#!/usr/bin/env node
/**
 * DeepSeek Harness desktop boot orchestrator.
 *
 * Runs under plain system Node with zero dependencies so a freshly cloned,
 * not-yet-installed repository can bootstrap itself. The Tauri shell spawns
 * this script with the application data directory as the sole argument and
 * reads one JSON object per stdout line:
 *
 *   {type:'phase', phase:'clone'|'sync'|'install'|'build'|'start'}
 *   {type:'log', line:string}
 *   {type:'notice', message:string}
 *   {type:'ready', url:string}
 *   {type:'exited', code:number}
 *   {type:'error', message:string, hint?:string}
 *
 * Nothing else may write to stdout. All child output is forwarded as log
 * events (before readiness) and appended to logs/backend.log (always).
 *
 * Frozen bundles set DSH_FROZEN_ROOT (the app's frozen/ resources directory
 * holding a prebuilt repository and the node runtime): the backend starts
 * directly from it with no git, pnpm, or network contact at all.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
export const DEFAULT_BRANCH = 'master'

/** Milliseconds waiting for the `dsh web:` readiness line before giving up. */
export const READY_TIMEOUT_MS = 120_000
/**
 * Milliseconds between forwarding a shutdown signal to the backend and
 * force-killing it. dsh's own process-shutdown contract disposes the plugin
 * tree within five seconds; the margin covers scheduling only.
 */
export const BACKEND_SHUTDOWN_GRACE_MS = 5_500

/** Lines of child output retained for failure diagnostics. */
const ERROR_TAIL_LINES = 30

/** The `dsh web` URL line is the sanctioned readiness signal of the backend. */
const READINESS_PATTERN = /^dsh web: (http:\/\/(?:127\.0\.0\.1|localhost):\d+)(?:\s|$)/u

const CONFIG_VALUE_TYPES = {
  repoUrl: 'string',
  branch: 'string',
  repoDir: 'string',
  skipSync: 'boolean',
  nodeDir: 'string',
}

/**
 * Extract the local Web UI URL from a backend stdout line.
 * @param {string} line one stdout line of `dsh web`
 * @returns {string | null} the ready URL, or null when the line is not the URL line
 */
export function parseReadinessLine(line) {
  const match = READINESS_PATTERN.exec(line)
  return match === null ? null : match[1]
}

/**
 * Check a Node version string against the repository engines range
 * `^22.19.0 || >=24.0.0`.
 * @param {string} version a `process.version`-style string such as `v24.1.0`
 * @returns {boolean} whether the version satisfies the range
 */
export function nodeSatisfiesEngines(version) {
  const match = /^v?(\d+)\.(\d+)\.\d+/u.exec(version.trim())
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 19) || major >= 24
}

/**
 * Decide the first repository phase.
 * @param {{repoCloned: boolean, skipSync: boolean}} input observed repository state
 * @returns {'clone' | 'sync' | 'none'} the phase to run before anything else
 */
export function firstPhase({ repoCloned, skipSync }) {
  if (!repoCloned) return 'clone'
  return skipSync === true ? 'none' : 'sync'
}

/**
 * Decide whether install+build must run: the recorded build stamp must equal
 * the current HEAD and the backend entry must exist on disk.
 * @param {{head: string, stamp: string | undefined, binExists: boolean}} input observed state
 * @returns {boolean} whether a rebuild is needed
 */
export function needsBuild({ head, stamp, binExists }) {
  return binExists !== true || head !== stamp
}

/**
 * Pick an actionable hint when a clone failed because of the network rather
 * than because of the repository or the URL itself: the first launch cannot
 * proceed offline, so the splash should say so instead of showing raw git
 * output.
 * @param {string[]} tail retained output tail of the failed clone
 * @returns {string | undefined} the network hint, or undefined for other failures
 */
export function cloneFailureHint(tail) {
  const markers = [
    'unable to access',
    'could not resolve host',
    'could not resolve proxy',
    'failed to connect',
    'network is unreachable',
    'operation timed out',
    'connection timed out',
    'connection refused',
  ]
  const output = tail.join('\n').toLowerCase()
  return markers.some((marker) => output.includes(marker))
    ? 'Check your internet connection — the first launch must reach GitHub'
    : undefined
}

/**
 * Merge user configuration over the defaults and derive all state paths.
 * Performs no I/O; every invalid shape throws with the offending key named.
 * `nodeDir` (a directory containing the node executable) is consumed by the
 * shell for PATH augmentation, not by this script.
 * @param {string} appDataDir absolute application data directory
 * @param {unknown} overrides parsed contents of `config.json`; the function
 *   itself rejects non-object shapes, so callers may pass anything
 * @returns {{
 *   repoUrl: string, branch: string, repoDir: string, skipSync: boolean,
 *   nodeDir: string | undefined, stampPath: string, logDir: string,
 * }} the resolved configuration
 */
export function resolveConfig(appDataDir, overrides) {
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new Error('config.json must be a JSON object')
  }
  for (const key of Object.keys(overrides)) {
    const expected = CONFIG_VALUE_TYPES[key]
    if (expected === undefined) {
      throw new Error(`unknown config key ${JSON.stringify(key)}; expected one of ${Object.keys(CONFIG_VALUE_TYPES).join(', ')}`)
    }
    const actual = typeof overrides[key]
    if (actual !== expected) {
      throw new Error(`config key ${JSON.stringify(key)} must be a ${expected}, got ${actual}`)
    }
  }
  const repoUrl = typeof overrides.repoUrl === 'string' && overrides.repoUrl !== '' ? overrides.repoUrl : DEFAULT_REPO_URL
  if (!/^https?:\/\//u.test(repoUrl)) throw new Error('config key "repoUrl" must be an http(s) URL')
  const branch = typeof overrides.branch === 'string' && overrides.branch !== '' ? overrides.branch : DEFAULT_BRANCH
  if (/\s/u.test(branch)) throw new Error('config key "branch" must be a single git ref without whitespace')
  if (branch.startsWith('-')) throw new Error('config key "branch" must not start with "-" (git would parse it as an option)')
  const rawRepoDir = typeof overrides.repoDir === 'string' && overrides.repoDir !== '' ? overrides.repoDir : 'repo'
  const repoDir = isAbsolute(rawRepoDir) ? rawRepoDir : resolve(appDataDir, rawRepoDir)
  return {
    repoUrl,
    branch,
    repoDir,
    skipSync: overrides.skipSync === true,
    nodeDir: typeof overrides.nodeDir === 'string' && overrides.nodeDir !== '' ? overrides.nodeDir : undefined,
    stampPath: join(appDataDir, 'build-stamp'),
    logDir: join(appDataDir, 'logs'),
  }
}

/**
 * Whether `file` must be spawned through cmd.exe on this platform: Windows
 * resolves corepack/pnpm only as `.cmd` shims (a bare spawn of a `.cmd` fails
 * with EINVAL), while git and node are real executables everywhere.
 * @param {string} platform a `process.platform` value
 * @param {string} file executable name that would be spawned
 * @returns {boolean} whether the spawn needs `shell: true`
 */
export function needsShell(platform, file) {
  return platform === 'win32' && (file === 'corepack' || file === 'pnpm')
}

/**
 * Quote one argv element for a cmd.exe invocation: with `shell: true`, Node
 * space-joins the arguments without quoting, so any argument outside the
 * plain-word allowlist must be wrapped in double quotes.
 *
 * Known caveat: cmd.exe still expands %VAR% inside double quotes, and a
 * quoted argument ending in a backslash escapes the closing quote. Neither
 * can occur today (git URLs, branches, and data paths never contain '%' or
 * end in a backslash), so this stays a documented limitation rather than a
 * general cmd quoting layer.
 * @param {string} arg one argv element
 * @returns {string} the cmd-safe spelling of the argument
 */
export function quoteCmdArg(arg) {
  return /^[\w\-./:=+@#?~]+$/u.test(arg) ? arg : `"${arg}"`
}

/** True once the failure path has emitted its error; suppresses later events. */
let exiting = false
/** The child currently owned by this process, so signals can be forwarded. */
let currentChild = null
/** Set once a shutdown signal was received; later phases stop and `exited` is suppressed. */
let shuttingDown = false
/** The received shutdown signal, for the conventional exit code. */
let shutdownSignal = 'SIGTERM'

/**
 * Write one protocol event to stdout for the Tauri shell.
 * @param {string} type event type
 * @param {Record<string, unknown>} [payload] additional event fields
 */
function emit(type, payload = {}) {
  if (exiting) return
  process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`)
}

/**
 * Report a fatal condition and mark the process as failed.
 * @param {string} message what went wrong
 * @param {string} [hint] actionable next step shown on the splash
 */
function fail(message, hint) {
  emit('error', hint === undefined ? { message } : { message, hint })
  exiting = true
  process.exitCode = 1
}

/**
 * Split a readable stream into lines and observe each one.
 * @param {import('node:stream').Readable} stream the child stream to drain
 * @param {(line: string) => void} onLine called per line without its newline
 */
async function readLines(stream, onLine) {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      onLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer !== '') onLine(buffer)
}

/**
 * Run a command to completion, streaming each output line as a log event and
 * retaining a tail for failure reporting.
 * @param {string} file executable to run
 * @param {string[]} args argv without the executable
 * @param {{cwd: string, env: NodeJS.ProcessEnv}} options
 * @returns {Promise<{code: number, tail: string[]}>} exit code and retained output tail
 */
async function run(file, args, { cwd, env }) {
  const shell = needsShell(process.platform, file)
  const child = spawn(file, shell ? args.map(quoteCmdArg) : args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('error', () => {})
  currentChild = child
  const tail = []
  const observe = (line) => {
    if (line === '') return
    tail.push(line)
    if (tail.length > ERROR_TAIL_LINES) tail.shift()
    emit('log', { line })
  }
  await Promise.all([readLines(child.stdout, observe), readLines(child.stderr, observe)])
  const code = await waitForClose(child)
  currentChild = null
  return { code, tail }
}

/**
 * Resolve when a child closes, whether it ran or failed to spawn.
 * @param {import('node:child_process').ChildProcess} child the process to await
 * @returns {Promise<number>} exit code, or -1 when it never ran or was killed by a signal
 */
function waitForClose(child) {
  return new Promise((resolveClose) => {
    child.on('close', (code) => resolveClose(code === null ? -1 : code))
  })
}

/**
 * Probe whether a command runs successfully.
 * @param {string} file executable to run
 * @param {string[]} args argv without the executable
 * @param {NodeJS.ProcessEnv} env environment for the probe
 * @returns {Promise<boolean>} whether the probe exited 0
 */
async function probeOk(file, args, env) {
  const shell = needsShell(process.platform, file)
  const child = spawn(file, shell ? args.map(quoteCmdArg) : args, { env, shell, stdio: ['ignore', 'ignore', 'ignore'] })
  return await new Promise((resolveProbe) => {
    child.on('error', () => resolveProbe(false))
    child.on('exit', code => resolveProbe(code === 0))
  })
}

/**
 * Resolve a pnpm launcher: corepack first (it pins the exact version from the
 * repository's packageManager field), a PATH pnpm second.
 * @returns {Promise<{file: string, prefix: string[], env: NodeJS.ProcessEnv} | null>}
 */
async function resolvePnpm() {
  const corepackEnv = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
  if (await probeOk('corepack', ['pnpm', '--version'], corepackEnv)) {
    return { file: 'corepack', prefix: ['pnpm'], env: corepackEnv }
  }
  if (await probeOk('pnpm', ['--version'], process.env)) {
    return { file: 'pnpm', prefix: [], env: process.env }
  }
  return null
}

/**
 * Run one git command in the repository and return its trimmed stdout.
 * @param {string[]} args git argv
 * @param {string} cwd repository (or its parent for clone)
 * @returns {Promise<string>} trimmed stdout; rejects on a non-zero exit
 */
async function git(args, cwd) {
  const child = spawn('git', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] })
  child.on('error', () => {})
  currentChild = child
  let out = ''
  for await (const chunk of child.stdout) out += chunk
  const code = await waitForClose(child)
  currentChild = null
  if (code !== 0) throw new Error(`git ${args.join(' ')} exited with code ${String(code)}`)
  return out.trim()
}

/**
 * Boot the frozen bundle: the application resources carry a prebuilt
 * repository and the node runtime (`frozen/repo`, `frozen/node`), so the
 * backend starts immediately — no toolchain probes, no git, no network.
 * @param {string} frozenRoot absolute path of the frozen resources directory
 * @param {string} appDataDir application data directory (for logs)
 */
async function bootFrozen(frozenRoot, appDataDir) {
  const logDir = join(appDataDir, 'logs')
  await mkdir(logDir, { recursive: true })
  await startBackend(join(frozenRoot, 'repo'), logDir, process.env)
}

/**
 * Spawn the backend web server from `repoDir` and supervise it to readiness:
 * append every output line to logs/backend.log, forward pre-readiness lines
 * as log events, emit `ready` on the readiness URL, and turn a pre-readiness
 * death into a failure.
 * @param {string} repoDir repository providing apps/cli/lib/bin.js
 * @param {string} logDir where backend.log is appended
 * @param {NodeJS.ProcessEnv} env environment for the backend
 */
async function startBackend(repoDir, logDir, env) {
  emit('phase', { phase: 'start' })
  const backend = spawn(process.execPath, [join(repoDir, 'apps/cli/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', '0'], {
    cwd: repoDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend.on('error', () => {})
  currentChild = backend
  const logPath = join(logDir, 'backend.log')
  const logStream = createWriteStream(logPath, { flags: 'a' })
  let ready = false

  const watchdog = setTimeout(() => {
    if (ready) return
    backend.kill('SIGTERM')
    fail(`the backend did not report readiness within ${String(READY_TIMEOUT_MS / 1000)}s`, `See ${logPath}`)
  }, READY_TIMEOUT_MS)
  watchdog.unref()

  const observeBackend = (line) => {
    if (line === '') return
    logStream.write(`${line}\n`)
    if (ready) return
    const url = parseReadinessLine(line)
    if (url !== null) {
      ready = true
      clearTimeout(watchdog)
      emit('ready', { url })
      return
    }
    emit('log', { line })
  }
  // A broken output stream must surface as a failure instead of crashing this
  // process on an unhandled rejection; without readable output the backend
  // cannot be supervised, so it is terminated too.
  const drains = [readLines(backend.stdout, observeBackend), readLines(backend.stderr, observeBackend)]
  for (const drain of drains) {
    drain.catch((error) => {
      backend.kill('SIGTERM')
      fail(`backend output stream failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const exitCode = await waitForClose(backend)
  currentChild = null
  logStream.end()
  if (process.exitCode === 1) return
  exitIfShuttingDown()
  if (!ready) {
    fail(`the backend exited with code ${String(exitCode)} before reporting readiness`, `See ${logPath}`)
    return
  }
  emit('exited', { code: exitCode })
  process.exitCode = exitCode < 0 ? 1 : exitCode
}

/**
 * Boot sequence: toolchain → clone/sync → install+build → backend → readiness.
 * @param {string} appDataDirArg application data directory passed by the shell
 */
async function main(appDataDirArg) {
  const appDataDir = resolve(appDataDirArg)
  await mkdir(appDataDir, { recursive: true })

  const frozenRoot = process.env.DSH_FROZEN_ROOT
  if (frozenRoot !== undefined && frozenRoot !== '') {
    await bootFrozen(resolve(frozenRoot), appDataDir)
    return
  }

  let overrides = {}
  const configPath = join(appDataDir, 'config.json')
  if (existsSync(configPath)) {
    try {
      overrides = JSON.parse(await readFile(configPath, 'utf8'))
    } catch (error) {
      fail(`config.json is not valid JSON: ${String(error)}`)
      return
    }
  }
  let config
  try {
    config = resolveConfig(appDataDir, overrides)
  } catch (error) {
    fail(String(error))
    return
  }
  await mkdir(config.logDir, { recursive: true })

  if (!(await probeOk('git', ['--version'], process.env))) {
    fail('git was not found on PATH', 'Install the Xcode Command Line Tools: xcode-select --install')
    return
  }
  if (!nodeSatisfiesEngines(process.version)) {
    fail(`node ${process.version} does not satisfy the repository engines range ^22.19.0 || >=24.0.0`, 'Install Node.js 24 from https://nodejs.org')
    return
  }
  const phase = firstPhase({ repoCloned: existsSync(join(config.repoDir, '.git')), skipSync: config.skipSync })
  if (phase === 'clone') {
    emit('phase', { phase: 'clone' })
    const clone = await run('git', ['clone', '--depth', '1', '--branch', config.branch, config.repoUrl, config.repoDir], {
      cwd: appDataDir,
      env: process.env,
    })
    if (clone.code !== 0) {
      fail(`cloning ${config.repoUrl} (branch ${config.branch}) failed`, cloneFailureHint(clone.tail) ?? clone.tail.join('\n'))
      return
    }
    exitIfShuttingDown()
  } else if (phase === 'sync') {
    emit('phase', { phase: 'sync' })
    // The clone's origin still records the URL from clone time; a repoUrl
    // change in config.json must retarget it or every later fetch keeps
    // syncing the original source. Best effort: a checkout too broken to
    // retarget fails at the fetch or the HEAD read below.
    try {
      const originUrl = await git(['remote', 'get-url', 'origin'], config.repoDir)
      if (originUrl !== config.repoUrl) {
        await git(['remote', 'set-url', 'origin', config.repoUrl], config.repoDir)
        emit('notice', { message: `repoUrl changed; origin retargeted to ${config.repoUrl}` })
      }
    } catch (error) {
      emit('notice', { message: `cannot retarget origin after a repoUrl change: ${String(error)}` })
    }
    const fetch = await run('git', ['fetch', '--depth', '1', 'origin', config.branch], { cwd: config.repoDir, env: process.env })
    if (fetch.code !== 0) {
      exitIfShuttingDown()
      emit('notice', { message: 'git fetch failed; continuing with the existing checkout' })
    } else {
      const reset = await run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: config.repoDir, env: process.env })
      if (reset.code !== 0) {
        fail('git reset failed on the managed checkout', `Delete ${config.repoDir} and relaunch to re-clone`)
        return
      }
    }
    exitIfShuttingDown()
  }

  let head
  try {
    head = await git(['rev-parse', 'HEAD'], config.repoDir)
  } catch (error) {
    // A clone interrupted mid-download (the grace-window SIGKILL can land
    // during the first clone) can leave a checkout whose HEAD never resolves;
    // every later launch would fail here without the re-clone hint.
    fail(`cannot resolve HEAD in the managed checkout: ${String(error)}`, `Delete ${config.repoDir} and relaunch to re-clone`)
    return
  }
  exitIfShuttingDown()
  const binPath = join(config.repoDir, 'apps/cli/lib/bin.js')
  const stamp = existsSync(config.stampPath) ? (await readFile(config.stampPath, 'utf8')).trim() : undefined
  /** Child environment shared by the pnpm phases and the backend; only the shim-PATH augmentation below ever changes it. */
  let childEnv = { ...process.env }
  if (needsBuild({ head, stamp, binExists: existsSync(binPath) })) {
    // Resolve pnpm only now: a launch whose stamp already matches HEAD (the
    // common fast path) never pays the corepack/pnpm probes — the corepack
    // probe can download pnpm on first use and adds seconds to every start.
    const pnpm = await resolvePnpm()
    if (pnpm === null) {
      fail('pnpm is unavailable', 'Install pnpm (npm i -g pnpm) or use a Node version that ships corepack')
      return
    }
    // The repository's own build scripts invoke bare `pnpm` (build:web), but a
    // node installation without enabled corepack shims has no `pnpm` on PATH.
    // Create shims once per data directory and put them ahead of PATH.
    if (pnpm.file === 'corepack') {
      const shimDir = join(appDataDir, 'bin')
      await mkdir(shimDir, { recursive: true })
      const enable = await run('corepack', ['enable', '--install-directory', shimDir], { cwd: appDataDir, env: process.env })
      if (enable.code !== 0) {
        fail('corepack enable failed to create the pnpm shim', enable.tail.join('\n'))
        return
      }
      childEnv = { ...childEnv, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', PATH: `${shimDir}${delimiter}${childEnv.PATH ?? ''}` }
    }
    /**
     * pnpm-only environment: CI=1 keeps pnpm from installing git hooks and
     * emitting TTY progress bars. The backend must not inherit it — the
     * harness would see a CI runtime it did not opt into.
     */
    const pnpmEnv = { ...childEnv, CI: '1' }
    emit('phase', { phase: 'install' })
    const install = await run(pnpm.file, [...pnpm.prefix, 'install', '--frozen-lockfile'], { cwd: config.repoDir, env: pnpmEnv })
    if (install.code !== 0) {
      fail('pnpm install failed', install.tail.join('\n'))
      return
    }
    exitIfShuttingDown()
    emit('phase', { phase: 'build' })
    const build = await run(pnpm.file, [...pnpm.prefix, 'run', 'build'], { cwd: config.repoDir, env: pnpmEnv })
    if (build.code !== 0) {
      fail('pnpm run build failed', build.tail.join('\n'))
      return
    }
    exitIfShuttingDown()
    await writeFile(config.stampPath, `${head}\n`, 'utf8')
  }
  exitIfShuttingDown()

  await startBackend(config.repoDir, config.logDir, childEnv)
}

/**
 * Exit immediately when a shutdown signal already arrived: phases that have
 * not started must not spawn children the shell is no longer waiting for, and
 * the `exited` event must not surface while the shell is tearing the tree
 * down. Never returns once `shuttingDown` is set.
 */
function exitIfShuttingDown() {
  if (!shuttingDown) return
  process.exit(shutdownSignal === 'SIGINT' ? 130 : 0)
}

/**
 * Forward shutdown signals to the owned child, force-killing after the grace
 * window; with nothing to forward, exit immediately so the shell never waits.
 * A received signal also records the shutdown so later phases stop and the
 * normal-exit `exited` event stays suppressed.
 * @param {'SIGTERM' | 'SIGINT'} signal the received signal
 */
function forwardSignal(signal) {
  shuttingDown = true
  shutdownSignal = signal
  const child = currentChild
  if (child === null || child.killed) {
    process.exit(signal === 'SIGINT' ? 130 : 0)
  }
  child.kill(signal)
  const forceKill = setTimeout(() => child.kill('SIGKILL'), BACKEND_SHUTDOWN_GRACE_MS)
  forceKill.unref()
}

process.on('SIGTERM', () => forwardSignal('SIGTERM'))
process.on('SIGINT', () => forwardSignal('SIGINT'))

// The argv path can traverse symlinks (an .app unpacked under /var/folders),
// while the ESM loader realpaths the module — compare the resolved path or
// the guard silently never matches and the orchestrator does nothing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [appDataDir] = process.argv.slice(2)
  if (appDataDir === undefined || appDataDir === '') {
    process.stderr.write('usage: node boot.mjs <app-data-dir>\n')
    process.exit(2)
  }
  try {
    await main(appDataDir)
  } catch (error) {
    // An unexpected throw (fs failure, git rejection) must surface as an
    // error event; a silent crash would leave the splash waiting forever.
    fail(`unexpected boot failure: ${error instanceof Error ? error.message : String(error)}`)
  }
}
