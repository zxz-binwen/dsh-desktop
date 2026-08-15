/**
 * Build the dsh-desktop app for the HOST platform: a macOS .app, a Windows
 * NSIS installer, or Linux deb/AppImage bundles. The Tauri shell compiles
 * from src-tauri; the icon set for every platform derives from
 * assets/favicon.svg through `tauri icon`. Requires the Rust toolchain
 * (rustup) and a C toolchain; Windows additionally needs the Visual Studio
 * Build Tools, Linux the webkit2gtk development packages.
 *
 * `--frozen` (macOS) builds the standalone flavor instead: a prebuilt harness
 * repository and an official node runtime are frozen into the bundle's
 * resources, so the app opens directly with no git, pnpm, or network at
 * startup, and a GitHub-release-ready zip is produced.
 * Design: docs/design.md
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const iconsDir = join(root, 'src-tauri', 'icons')
const faviconPath = join(root, 'assets/favicon.svg')
const outDir = join(root, 'dist-app')
const bundleRoot = join(root, 'src-tauri', 'target', 'release', 'bundle')
const frozenDir = join(root, 'dist-frozen')
const harnessCache = join(root, '.harness-build')
const DEFAULT_HARNESS_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
const DEFAULT_HARNESS_REF = 'master'
const DEFAULT_FROZEN_NODE = 'v24.19.0'
/** `tauri icon` input: a square transparent PNG of at least 1024px. */
const ICON_SOURCE_SIZE = 1024

/** Structural type for the @resvg/resvg-js surface this script consumes. */
interface ResvgRenderer {
  render(): { asPng(): Buffer }
}

interface ResvgConstructor {
  new (svg: string, options: { fitTo: { mode: 'width'; value: number } }): ResvgRenderer
}

function usage(): string {
  return [
    'Usage: pnpm run build [--icon] [--frozen [options]] [--help]',
    '',
    'Builds the platform desktop bundle into dist-app/ from src-tauri',
    '(macOS .app, Windows NSIS installer, Linux deb/AppImage).',
    '',
    '  --icon                regenerate src-tauri/icons from the favicon first.',
    '  --frozen              macOS standalone flavor: freeze a prebuilt harness + the node',
    '                        runtime into the bundle (opens directly, never touches git or',
    '                        the network) and emit a GitHub-release-ready zip.',
    '  --node-version <v>    node version bundled by --frozen (default v24.19.0).',
    '  --harness-url <url>   harness repository frozen by --frozen (default deepseek-ai).',
    '  --harness-ref <ref>   harness branch or tag frozen by --frozen (default master).',
    '  --harness-dir <path>  freeze an existing harness checkout instead of cloning.',
    '                        Mutated in place (install, build, dev-deps pruned).',
    '  --help                print this help.',
  ].join('\n')
}

/**
 * Windows resolves corepack/pnpm only as `.cmd` shims, and a bare spawn of a
 * `.cmd` fails with EINVAL; git, cargo, and node are real executables
 * everywhere. Keep in sync with boot.mjs `needsShell`/`quoteCmdArg`.
 */
function needsShell(file: string): boolean {
  return process.platform === 'win32' && (file === 'corepack' || file === 'pnpm')
}

const CMD_PLAIN_WORD = /^[\w\-./:=+@#?~]+$/u

/** Quote one argv element for a cmd.exe invocation (see boot.mjs). */
function quoteCmdArg(arg: string): string {
  return CMD_PLAIN_WORD.test(arg) ? arg : `"${arg}"`
}

/**
 * Run a command to completion with inherited stdio.
 * @param file executable to run
 * @param args argv without the executable
 * @param label human-readable command name for failure reporting
 * @param [options.cwd] working directory (repository root by default)
 * @param [options.env] child environment (the build environment by default)
 */
function runInherit(
  file: string,
  args: string[],
  label: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const shell = needsShell(file)
    const child = spawn(file, shell ? args.map(quoteCmdArg) : args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: 'inherit',
      shell,
    })
    child.on('error', (error) => {
      rejectRun(new Error(`${label}: ${String(error)}`))
    })
    child.on('exit', (code) => {
      if (code === 0) {
        resolveRun()
      } else {
        rejectRun(new Error(`${label} exited with code ${String(code)}`))
      }
    })
  })
}

/**
 * Probe whether an executable runs. Version flags are the portable probe;
 * `which` is not a Windows builtin.
 * @param tool executable name to probe
 * @param versionFlag the flag that prints a version and exits 0
 */
function isRunnable(tool: string, versionFlag: string): boolean {
  return spawnSync(tool, [versionFlag], { encoding: 'utf8', shell: needsShell(tool) }).status === 0
}

/**
 * Resolve a pnpm launcher: a PATH pnpm first, corepack second (it pins the
 * exact version from this package's packageManager field).
 * @returns the executable plus a fixed argv prefix
 */
function resolvePnpm(): { file: string; prefix: string[] } {
  if (isRunnable('pnpm', '--version')) return { file: 'pnpm', prefix: [] }
  const corepack = spawnSync('corepack', ['pnpm', '--version'], {
    encoding: 'utf8',
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    shell: needsShell('corepack'),
  })
  if (corepack.status === 0) return { file: 'corepack', prefix: ['pnpm'] }
  throw new Error('pnpm is not runnable; install pnpm (npm i -g pnpm) or use a Node version that ships corepack.')
}

/**
 * Rasterize the favicon into a square PNG and let `tauri icon` derive every
 * platform icon (icns, ico, and the PNG set) from it.
 */
async function generateIcons(): Promise<void> {
  const require = createRequire(join(root, 'package.json'))
  const { Resvg } = require('@resvg/resvg-js') as { Resvg: ResvgConstructor }
  const svg = await readFile(faviconPath, 'utf8')
  const sourcePng = new Resvg(svg, { fitTo: { mode: 'width', value: ICON_SOURCE_SIZE } }).render().asPng()
  const sourcePath = join(iconsDir, 'app-icon.png')
  await mkdir(iconsDir, { recursive: true })
  await writeFile(sourcePath, sourcePng)
  const pnpm = resolvePnpm()
  await runInherit(pnpm.file, [...pnpm.prefix, 'exec', 'tauri', 'icon', sourcePath], 'tauri icon')
}

/**
 * Collect the bundle outputs `tauri build` produced for this platform and
 * copy each into dist-app/.
 */
async function collectBundles(): Promise<string[]> {
  await mkdir(outDir, { recursive: true })
  const produced: string[] = []
  for (const kind of await readdir(bundleRoot)) {
    const kindDir = join(bundleRoot, kind)
    for (const entry of await readdir(kindDir)) {
      const source = join(kindDir, entry)
      const destination = join(outDir, entry)
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, { recursive: true })
      produced.push(destination)
    }
  }
  return produced
}

/**
 * pnpm install spelling shared by every frozen-harness invocation. The hoisted
 * node linker produces an npm-style node_modules without pnpm's symlinked
 * store (symlinks would not survive the bundle-resource copy); the targeted
 * architectures keep pnpm from fetching every other platform's native
 * optional binaries (codex/esbuild/rolldown ship linux/win32 variants too).
 */
const FROZEN_INSTALL_FLAGS = [
  '--config.node-linker=hoisted',
  `--config.supportedArchitectures.os=${process.platform}`,
  `--config.supportedArchitectures.cpu=${process.arch}`,
] as const

/**
 * Resolve a pnpm launcher whose environment also satisfies a bare `pnpm`:
 * the harness build scripts invoke `pnpm` directly (build:web), which fails
 * on machines where pnpm exists only through corepack. Mirrors boot.mjs —
 * corepack shims are enabled into a local dir and put ahead of PATH.
 */
async function pnpmLauncher(): Promise<{ file: string; prefix: string[]; env: NodeJS.ProcessEnv }> {
  const pnpm = resolvePnpm()
  if (pnpm.file !== 'corepack') {
    return { file: pnpm.file, prefix: pnpm.prefix, env: { ...process.env, CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } }
  }
  const shimDir = join(harnessCache, 'bin')
  await mkdir(shimDir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
  }
  await runInherit('corepack', ['enable', '--install-directory', shimDir], 'corepack enable (harness shims)', { env })
  return { file: 'pnpm', prefix: [], env }
}

/**
 * Resolve a harness checkout to freeze: the .harness-build cache clone kept in
 * sync with `url`/`ref`, or `harnessDir` as given.
 * @returns the absolute checkout path plus its HEAD (or 'external-checkout')
 */
async function prepareHarnessSource(harnessUrl: string, harnessRef: string, harnessDir?: string): Promise<{ dir: string; head: string }> {
  if (harnessDir !== undefined) {
    const dir = resolve(harnessDir)
    if (!existsSync(join(dir, 'package.json'))) throw new Error(`--harness-dir ${dir} has no package.json.`)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    return { dir, head: head.status === 0 ? head.stdout.trim() : 'external-checkout' }
  }
  const dir = join(harnessCache, 'src')
  if (existsSync(join(dir, '.git'))) {
    await runInherit('git', ['remote', 'set-url', 'origin', harnessUrl], 'git remote set-url (harness)', { cwd: dir })
    await runInherit('git', ['fetch', '--depth', '1', 'origin', harnessRef], 'git fetch (harness)', { cwd: dir })
    await runInherit('git', ['reset', '--hard', 'FETCH_HEAD'], 'git reset (harness)', { cwd: dir })
  } else {
    await rm(dir, { recursive: true, force: true })
    await runInherit('git', ['clone', '--depth', '1', '--branch', harnessRef, harnessUrl, dir], 'git clone (harness)')
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' })
  if (head.status !== 0 || head.stdout.trim() === '') throw new Error('cannot resolve the harness checkout HEAD.')
  return { dir, head: head.stdout.trim() }
}

/**
 * Install and build the harness in place. The install keeps the full
 * dependency graph: the harness relies on cross-package hoisting (phantom
 * imports resolved through another package's hoisted link), so a prod-only
 * prune breaks its runtime resolution. Bulk is controlled by stripping build
 * artifacts, not dependencies.
 */
async function buildFrozenHarness(harnessDir: string): Promise<void> {
  const pnpm = await pnpmLauncher()
  await runInherit(pnpm.file, [...pnpm.prefix, 'install', '--frozen-lockfile', ...FROZEN_INSTALL_FLAGS], 'pnpm install (harness)', { cwd: harnessDir, env: pnpm.env })
  await runInherit(pnpm.file, [...pnpm.prefix, 'run', 'build'], 'pnpm run build (harness)', { cwd: harnessDir, env: pnpm.env })
}

/**
 * Copy the built harness (minus its git directory) into the frozen payload.
 * Symlinks are kept: they carry pnpm's workspace resolution, which the
 * backend's imports rely on. Dangling links to pruned packages are skipped.
 */
async function copyFrozenRepo(source: string): Promise<void> {
  const destination = join(frozenDir, 'repo')
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => {
      if (lstatSync(entry).isSymbolicLink() && !existsSync(entry)) return false
      const relativePath = entry.slice(source.length)
      return relativePath !== '/.git' && !relativePath.startsWith('/.git/') && !relativePath.endsWith('/.DS_Store')
    },
  })
  await relativizeSymlinks(source, destination)
  await slimFrozenRepo(destination)
}

/**
 * Build artifacts with no runtime role, stripped to keep the bundle under
 * distribution size limits: source maps (a missing map is a silent 404) and
 * TypeScript build caches.
 */
const SLIM_SUFFIXES = ['.map', '.tsbuildinfo'] as const

async function slimFrozenRepo(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await slimFrozenRepo(path)
    } else if (entry.isFile() && SLIM_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      await rm(path, { force: true })
    }
  }
}

/**
 * Rewrite absolute symlinks into relative ones. pnpm creates some workspace
 * links as absolute paths into the build checkout; the payload must carry
 * links that resolve inside itself. Absolute links pointing outside the
 * payload tree cannot be shipped and are removed.
 */
async function relativizeSymlinks(sourceRoot: string, tree: string): Promise<void> {
  for (const link of await collectSymlinks(tree)) {
    const target = await readlink(link)
    if (!isAbsolute(target)) continue
    if (!target.startsWith(sourceRoot)) {
      await rm(link, { force: true })
      continue
    }
    const mapped = join(tree, target.slice(sourceRoot.length))
    await rm(link, { force: true })
    await symlink(relative(dirname(link), mapped), link)
  }
}

async function collectSymlinks(dir: string, into: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      into.push(path)
    } else if (entry.isDirectory()) {
      await collectSymlinks(path, into)
    }
  }
  return into
}

/**
 * Download an official node distribution and ship its binary and license as
 * the frozen runtime, verifying the release SHA-256 first. curl carries the
 * download because it honors proxy environments that Node's fetch ignores.
 * @param version a `v24.19.0`-style dist version (a leading `v` is optional)
 */
async function downloadFrozenNode(version: string): Promise<void> {
  const normalized = version.startsWith('v') ? version : `v${version}`
  const dist = `node-${normalized}-darwin-${process.arch}`
  const base = `https://nodejs.org/dist/${normalized}`
  const download = (url: string, destination: string) => {
    const result = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', destination, url])
    if (result.status !== 0) throw new Error(`downloading ${url} failed (curl exit ${String(result.status)}).`)
  }
  const archive = join(frozenDir, `${dist}.tar.gz`)
  const sumsPath = join(frozenDir, 'SHASUMS256.txt')
  download(`${base}/${dist}.tar.gz`, archive)
  download(`${base}/SHASUMS256.txt`, sumsPath)
  const sums = await readFile(sumsPath, 'utf8')
  await rm(sumsPath, { force: true })
  const sumLine = sums.split('\n').find((line) => line.endsWith(`${dist}.tar.gz`))
  if (sumLine === undefined) throw new Error(`SHASUMS256.txt has no entry for ${dist}.tar.gz.`)
  const expected = sumLine.slice(0, 64)
  const tarball = await readFile(archive)
  const actual = createHash('sha256').update(tarball).digest('hex')
  if (actual !== expected) throw new Error(`node ${normalized} checksum mismatch: expected ${expected}, got ${actual}.`)

  const nodeDir = join(frozenDir, 'node')
  await rm(nodeDir, { recursive: true, force: true })
  await mkdir(nodeDir, { recursive: true })
  // Ship only the runtime binary and its license; the dist also carries
  // headers, npm, and corepack, none of which the frozen bundle invokes.
  const extract = spawnSync('tar', ['-xzf', archive, '-C', nodeDir, '--strip-components', '1', `${dist}/bin/node`, `${dist}/LICENSE`])
  await rm(archive, { force: true })
  if (extract.status !== 0) throw new Error(`extracting the node tarball failed: ${String(extract.stderr)}`)
  if (!existsSync(join(nodeDir, 'bin', 'node'))) throw new Error('the node tarball did not yield bin/node.')
}

/**
 * Assemble dist-frozen/ (repo + node + manifest) — everything the app's
 * frozen/ resources directory needs.
 */
async function prepareFrozenPayload(options: {
  harnessUrl: string
  harnessRef: string
  harnessDir?: string
  nodeVersion: string
}): Promise<void> {
  await rm(frozenDir, { recursive: true, force: true })
  await mkdir(frozenDir, { recursive: true })
  console.log(`build: freezing harness ${options.harnessUrl} @ ${options.harnessRef} with node ${options.nodeVersion}`)
  const { dir, head } = await prepareHarnessSource(options.harnessUrl, options.harnessRef, options.harnessDir)
  await buildFrozenHarness(dir)
  await copyFrozenRepo(dir)
  await downloadFrozenNode(options.nodeVersion)
  const manifest = {
    mode: 'frozen',
    node: options.nodeVersion,
    harnessUrl: options.harnessUrl,
    harnessRef: options.harnessRef,
    harnessHead: head,
    builtAt: new Date().toISOString(),
  }
  await writeFile(join(frozenDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`build: frozen harness @ ${head}`)
}

/**
 * Copy the frozen repository into the bundled .app after `tauri build`:
 * Tauri's resource packer drops symlinks, so the repository travels outside
 * the resource mechanism and is copied with rsync, which preserves links
 * (already relativized). The bundle is re-signed ad-hoc to cover the added
 * content.
 */
async function injectFrozenRepo(): Promise<void> {
  const macosDir = join(bundleRoot, 'macos')
  const app = (await readdir(macosDir)).find((entry) => entry.endsWith('.app'))
  if (app === undefined) throw new Error(`tauri build produced no .app under ${macosDir}.`)
  const appPath = join(macosDir, app)
  const frozenRoot = join(appPath, 'Contents', 'Resources', 'frozen')
  await mkdir(frozenRoot, { recursive: true })
  const copied = spawnSync('rsync', ['-a', `${join(frozenDir, 'repo')}/`, join(frozenRoot, 'repo')])
  if (copied.status !== 0) throw new Error(`copying the frozen repo into the bundle failed: ${String(copied.stderr)}`)
  const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath])
  if (signed.status !== 0) throw new Error(`re-signing the bundle failed: ${String(signed.stderr)}`)
}

/**
 * Zip the collected macOS .app for GitHub distribution. ditto preserves
 * symlinks, extended attributes, and the ad-hoc signature.
 */
async function zipAppBundle(): Promise<string> {
  const apps = (await readdir(outDir)).filter((entry) => entry.endsWith('.app'))
  if (apps.length !== 1) throw new Error(`expected exactly one .app under ${outDir}, found: ${apps.join(', ')}`)
  const version = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version
  const zip = join(outDir, `DeepSeek-Harness-${version}-macos-${process.arch}-standalone.zip`)
  await rm(zip, { force: true })
  const zipped = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(outDir, apps[0]!), zip])
  if (zipped.status !== 0) throw new Error(`zipping the .app failed: ${String(zipped.stderr)}`)
  return zip
}

async function main(): Promise<void> {
  const flags = parseArgs({
    options: {
      icon: { type: 'boolean' },
      help: { type: 'boolean' },
      frozen: { type: 'boolean' },
      'node-version': { type: 'string' },
      'harness-url': { type: 'string' },
      'harness-ref': { type: 'string' },
      'harness-dir': { type: 'string' },
    },
  })
  if (flags.values.help === true) {
    console.log(usage())
    return
  }
  if (!isRunnable('cargo', '--version')) {
    throw new Error('cargo is required but not runnable. Install the Rust toolchain from https://rustup.rs.')
  }
  const frozen = flags.values.frozen === true
  if (frozen && process.platform !== 'darwin') {
    throw new Error('--frozen packages a macOS standalone bundle; run it on a Mac.')
  }

  if (flags.values.icon === true || !existsSync(join(iconsDir, 'icon.icns')) || !existsSync(join(iconsDir, 'icon.ico'))) {
    await generateIcons()
  }

  const tauriArgs = frozen ? ['build', '--config', join(root, 'src-tauri', 'tauri.frozen.conf.json')] : ['build']
  if (frozen) {
    await prepareFrozenPayload({
      harnessUrl: flags.values['harness-url'] ?? DEFAULT_HARNESS_URL,
      harnessRef: flags.values['harness-ref'] ?? DEFAULT_HARNESS_REF,
      harnessDir: flags.values['harness-dir'],
      nodeVersion: flags.values['node-version'] ?? DEFAULT_FROZEN_NODE,
    })
  }
  const pnpm = resolvePnpm()
  await runInherit(pnpm.file, [...pnpm.prefix, 'exec', 'tauri', ...tauriArgs], frozen ? 'tauri build (frozen)' : 'tauri build')
  if (!existsSync(bundleRoot)) {
    throw new Error(`tauri build did not produce any bundle under ${bundleRoot}.`)
  }
  if (frozen) await injectFrozenRepo()

  const produced = await collectBundles()
  if (produced.length === 0) throw new Error('tauri build produced no bundle artifacts to collect.')
  for (const artifact of produced) console.log(`build: wrote ${artifact}`)
  if (frozen) {
    const zip = await zipAppBundle()
    const version = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version
    console.log(`build: wrote ${zip}`)
    console.log(`build: publish with: gh release create v${version} "${zip}" --title "DeepSeek Harness ${version} (macOS standalone)" --draft`)
    console.log('build: the frozen flavor never syncs from GitHub; ship a new zip to update it.')
  }
  console.log(`build: ${process.platform === 'win32' ? 'the installer is unsigned; SmartScreen may warn on first run' : 'the bundle is ad-hoc signed; on first launch right-click the app and choose Open'}.`)
  console.log(
    `build: per-user state lives under ${
      process.platform === 'win32'
        ? '%APPDATA%'
        : process.platform === 'darwin'
          ? '~/Library/Application Support'
          : '~/.local/share'
    }/com.deepseek-ai.dsh-desktop/.`,
  )
}

await main().catch((error: unknown) => {
  console.error(`build: ${String(error instanceof Error ? error.message : error)}`)
  process.exitCode = 1
})
