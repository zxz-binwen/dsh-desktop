/**
 * Build the dsh-desktop app for the HOST platform: a macOS .app, a Windows
 * NSIS installer, or Linux deb/AppImage bundles. The Tauri shell compiles
 * from src-tauri; the icon set for every platform derives from
 * assets/favicon.svg through `tauri icon`. Requires the Rust toolchain
 * (rustup) and a C toolchain; Windows additionally needs the Visual Studio
 * Build Tools, Linux the webkit2gtk development packages.
 * Design: docs/design.md
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const iconsDir = join(root, 'src-tauri', 'icons')
const faviconPath = join(root, 'assets/favicon.svg')
const outDir = join(root, 'dist-app')
const bundleRoot = join(root, 'src-tauri', 'target', 'release', 'bundle')
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
    'Usage: pnpm run build [--icon] [--help]',
    '',
    'Builds the platform desktop bundle into dist-app/ from src-tauri',
    '(macOS .app, Windows NSIS installer, Linux deb/AppImage).',
    '',
    '  --icon                regenerate src-tauri/icons from the favicon first.',
    '  --help                print this help.',
  ].join('\n')
}

/**
 * Run a command to completion with inherited stdio.
 * @param file executable to run
 * @param args argv without the executable
 * @param label human-readable command name for failure reporting
 */
function runInherit(file: string, args: string[], label: string): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { cwd: root, stdio: 'inherit' })
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
  return spawnSync(tool, [versionFlag], { encoding: 'utf8' }).status === 0
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

async function main(): Promise<void> {
  const flags = parseArgs({ options: { icon: { type: 'boolean' }, help: { type: 'boolean' } } })
  if (flags.values.help === true) {
    console.log(usage())
    return
  }
  if (!isRunnable('cargo', '--version')) {
    throw new Error('cargo is required but not runnable. Install the Rust toolchain from https://rustup.rs.')
  }

  if (flags.values.icon === true || !existsSync(join(iconsDir, 'icon.icns')) || !existsSync(join(iconsDir, 'icon.ico'))) {
    await generateIcons()
  }

  const pnpm = resolvePnpm()
  await runInherit(pnpm.file, [...pnpm.prefix, 'exec', 'tauri', 'build'], 'tauri build')
  if (!existsSync(bundleRoot)) {
    throw new Error(`tauri build did not produce any bundle under ${bundleRoot}.`)
  }

  const produced = await collectBundles()
  if (produced.length === 0) throw new Error('tauri build produced no bundle artifacts to collect.')
  for (const artifact of produced) console.log(`build: wrote ${artifact}`)
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
