/**
 * End-to-end tests for the boot orchestrator: a fake toolchain (git,
 * corepack) and a fake harness backend let the real `boot.mjs` run through
 * its clone → install → build → start → ready pipeline, plus the shutdown
 * and failure paths, against throwaway data directories.
 *
 * The fake tools are POSIX shell scripts, so this suite is skipped on
 * Windows; the Windows-specific spawn logic is covered by the unit tests for
 * `needsShell`/`quoteCmdArg` in boot.spec.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

const BOOT_PATH = join(import.meta.dirname, '..', 'boot.mjs')
const INITIAL_HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
const MOVED_HEAD = 'f9e8d7c6b5a4938271605141312111098f7e6d5c4'

/**
 * Fake `apps/cli/lib/bin.js`: prints the readiness line, records whether it
 * saw CI in the environment, and exits 0 on SIGTERM. Shared by the fake git
 * clone and the frozen-mode test.
 */
const FAKE_BACKEND_JS = `require('node:fs').writeFileSync('.backend-ci', process.env.CI === undefined ? 'unset' : process.env.CI)
process.stdout.write('dsh web: http://127.0.0.1:3080\\n')
const keepAlive = setInterval(() => {}, 60_000)
const parent = process.ppid
const watchdog = setInterval(() => {
  if (process.ppid !== parent) process.exit(0)
}, 500)
process.on('SIGTERM', () => {
  clearInterval(keepAlive)
  clearInterval(watchdog)
  process.exit(0)
})
`

const GIT_SCRIPT = `#!/bin/sh
# Fake git for dsh-desktop integration tests (see tests/boot.integration.spec.ts).
# boot.mjs always invokes one of the exact shapes handled below.
set -u
cmd="$1"
shift
case "$cmd" in
  --version)
    echo "git version 2.53.0"
    exit 0
    ;;
  clone)
    # boot.mjs: git clone --depth 1 --branch <branch> <url> <dest>
    branch="$4"
    url="$5"
    dest="$6"
    mkdir -p "$dest/.git" "$dest/apps/cli/lib"
    printf '%s\\n' "$FAKE_INITIAL_HEAD" > "$dest/.git/HEAD"
    cat > "$dest/apps/cli/lib/bin.js" <<'NODE'
${FAKE_BACKEND_JS}NODE
    printf '{"name":"fake-harness","private":true}\\n' > "$dest/package.json"
    : > "$dest/pnpm-lock.yaml"
    if [ -n "\${FAKE_INSTALL_FAIL:-}" ]; then : > "$dest/.install-fail"; fi
    exit 0
    ;;
  remote)
    # boot.mjs: git remote get-url origin / git remote set-url origin <url>
    # (positions are post-shift, so $1 is the subcommand). The recorded URL
    # starts at the default repo URL (what clone would have used).
    if [ "$1" = "get-url" ]; then
      if [ -f .git/origin-url ]; then cat .git/origin-url; else echo "https://github.com/deepseek-ai/deepseek-harness.git"; fi
    else
      printf '%s\\n' "$3" > .git/origin-url
    fi
    exit 0
    ;;
  fetch)
    # boot.mjs: git fetch --depth 1 origin <branch>
    if [ -f .fetch-fail ]; then exit 1; fi
    if [ -f .fetch-head ]; then cat .fetch-head > .git/FETCH_HEAD; else cat .git/HEAD > .git/FETCH_HEAD; fi
    exit 0
    ;;
  reset)
    # boot.mjs: git reset --hard FETCH_HEAD
    cat .git/FETCH_HEAD > .git/HEAD
    exit 0
    ;;
  rev-parse)
    if [ -f .rev-parse-fail ]; then echo "fatal: ambiguous argument 'HEAD'" >&2; exit 128; fi
    cat .git/HEAD
    exit 0
    ;;
  *)
    echo "fake git: unexpected command: $cmd $*" >&2
    exit 2
    ;;
esac
`

const COREPACK_SCRIPT = `#!/bin/sh
# Fake corepack for dsh-desktop integration tests: every invocation succeeds
# except when the repository carries the install-failure marker. The install
# invocation also records whether it ran under CI (boot.mjs sets CI=1 for the
# pnpm phases only — the backend environment must stay CI-free).
set -u
if [ -f .install-fail ]; then exit 1; fi
if [ "\${1:-}" = "pnpm" ] && [ "\${2:-}" = "install" ]; then
  if [ -n "\${CI:-}" ]; then echo set > .saw-ci; else echo unset > .saw-ci; fi
fi
exit 0
`

interface BootEvent {
  type: string
  [key: string]: unknown
}

interface BootHarness {
  events: BootEvent[]
  stderr: string
  waitFor(type: string): Promise<BootEvent>
  exit: Promise<number>
  kill(signal: NodeJS.Signals): void
}

const procs: ChildProcess[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const proc of procs.splice(0)) {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const dir of tempDirs.splice(0)) {
    void rm(dir, { recursive: true, force: true })
  }
})

/** Build a fake-toolchain environment and throwaway data directory. */
async function makeEnv(extraEnv: Record<string, string> = {}): Promise<{ dataDir: string; env: NodeJS.ProcessEnv }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-boot-test-'))
  const binDir = await mkdtemp(join(tmpdir(), 'dsh-bin-test-'))
  await writeFile(join(binDir, 'git'), GIT_SCRIPT, { mode: 0o755 })
  await writeFile(join(binDir, 'corepack'), COREPACK_SCRIPT, { mode: 0o755 })
  tempDirs.push(dataDir, binDir)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    FAKE_INITIAL_HEAD: INITIAL_HEAD,
    ...extraEnv,
  }
  return { dataDir, env }
}

/** Spawn the real orchestrator against a fake toolchain and collect its events. */
function launchBoot(dataDir: string, env: NodeJS.ProcessEnv): BootHarness {
  const child = spawn(process.execPath, [BOOT_PATH, dataDir], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(child)
  const events: BootEvent[] = []
  const waiters = new Map<string, Array<(event: BootEvent) => void>>()
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    try {
      const event = JSON.parse(trimmed) as BootEvent
      events.push(event)
      const queue = waiters.get(event.type)
      if (queue !== undefined) {
        waiters.delete(event.type)
        for (const resolve of queue) resolve(event)
      }
    } catch {
      // A non-JSON stdout line would violate the protocol; keep it visible.
      events.push({ type: 'raw', line: trimmed })
    }
  })
  const exit = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))
  return {
    events,
    get stderr() {
      return stderr
    },
    waitFor(type: string): Promise<BootEvent> {
      const existing = events.find((event) => event.type === type)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve) => {
        const queue = waiters.get(type) ?? []
        queue.push(resolve)
        waiters.set(type, queue)
      })
    },
    exit,
    kill: (signal) => {
      child.kill(signal)
    },
  }
}

function phases(events: BootEvent[]): string[] {
  return events.filter((event) => event.type === 'phase').map((event) => String(event.phase))
}

/** Run a full boot to readiness, then shut it down gracefully. */
async function bootToReady(dataDir: string, env: NodeJS.ProcessEnv): Promise<BootHarness> {
  const boot = launchBoot(dataDir, env)
  await boot.waitFor('ready')
  boot.kill('SIGTERM')
  await expect(boot.exit).resolves.toBe(0)
  return boot
}

describe.skipIf(process.platform === 'win32')('boot.mjs end-to-end', () => {
  it('clones, builds, reports ready, and shuts down gracefully on a fresh data directory', async () => {
    const { dataDir, env } = await makeEnv()
    const boot = launchBoot(dataDir, env)

    const ready = await boot.waitFor('ready')
    expect(ready.url).toBe('http://127.0.0.1:3080')
    expect(phases(boot.events)).toEqual(['clone', 'install', 'build', 'start'])

    const stamp = (await readFile(join(dataDir, 'build-stamp'), 'utf8')).trim()
    expect(stamp).toBe(INITIAL_HEAD)

    boot.kill('SIGTERM')
    await expect(boot.exit).resolves.toBe(0)
  }, 20_000)

  it('skips install and build when HEAD did not move', async () => {
    const { dataDir, env } = await makeEnv()
    await bootToReady(dataDir, env)

    const boot = launchBoot(dataDir, env)
    await boot.waitFor('ready')
    expect(phases(boot.events)).toEqual(['sync', 'start'])
    boot.kill('SIGTERM')
    await expect(boot.exit).resolves.toBe(0)
  }, 20_000)

  it('rebuilds when the sync moved HEAD', async () => {
    const { dataDir, env } = await makeEnv()
    await bootToReady(dataDir, env)
    await writeFile(join(dataDir, 'repo', '.fetch-head'), `${MOVED_HEAD}\n`)

    const boot = launchBoot(dataDir, env)
    await boot.waitFor('ready')
    expect(phases(boot.events)).toEqual(['sync', 'install', 'build', 'start'])
    const stamp = (await readFile(join(dataDir, 'build-stamp'), 'utf8')).trim()
    expect(stamp).toBe(MOVED_HEAD)
    boot.kill('SIGTERM')
    await expect(boot.exit).resolves.toBe(0)
  }, 20_000)

  it('continues offline with a notice when the sync fetch fails', async () => {
    const { dataDir, env } = await makeEnv()
    await bootToReady(dataDir, env)
    await writeFile(join(dataDir, 'repo', '.fetch-fail'), '')

    const boot = launchBoot(dataDir, env)
    const notice = await boot.waitFor('notice')
    expect(notice.message).toMatch(/git fetch failed/u)
    await boot.waitFor('ready')
    expect(phases(boot.events)).toEqual(['sync', 'start'])
    boot.kill('SIGTERM')
    await expect(boot.exit).resolves.toBe(0)
  }, 20_000)

  it('retargets origin with a notice when repoUrl changes in config.json', async () => {
    const { dataDir, env } = await makeEnv()
    await bootToReady(dataDir, env)
    const repoUrl = 'https://example.com/another-harness.git'
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ repoUrl }), 'utf8')

    const boot = launchBoot(dataDir, env)
    const notice = await boot.waitFor('notice')
    expect(notice.message).toBe(`repoUrl changed; origin retargeted to ${repoUrl}`)
    await boot.waitFor('ready')
    expect((await readFile(join(dataDir, 'repo', '.git', 'origin-url'), 'utf8')).trim()).toBe(repoUrl)
    boot.kill('SIGTERM')
    await expect(boot.exit).resolves.toBe(0)
  }, 20_000)

  it('reports an unresolvable HEAD with the delete-and-reclone hint', async () => {
    const { dataDir, env } = await makeEnv()
    await bootToReady(dataDir, env)
    await writeFile(join(dataDir, 'repo', '.rev-parse-fail'), '')

    const boot = launchBoot(dataDir, env)
    const error = await boot.waitFor('error')
    expect(error.message).toMatch(/cannot resolve HEAD/u)
    expect(error.hint).toBe(`Delete ${join(dataDir, 'repo')} and relaunch to re-clone`)
    await expect(boot.exit).resolves.toBe(1)
  }, 20_000)

  it('runs the pnpm install under CI=1 but keeps CI out of the backend environment', async () => {
    const { dataDir, env } = await makeEnv()
    await bootToReady(dataDir, env)
    expect((await readFile(join(dataDir, 'repo', '.saw-ci'), 'utf8')).trim()).toBe('set')
    expect((await readFile(join(dataDir, 'repo', '.backend-ci'), 'utf8')).trim()).toBe('unset')
  }, 20_000)

  it('reports a failed install as an error event and exits nonzero', async () => {
    const { dataDir, env } = await makeEnv({ FAKE_INSTALL_FAIL: '1' })
    const boot = launchBoot(dataDir, env)

    const error = await boot.waitFor('error')
    expect(error.message).toMatch(/pnpm install failed/u)
    await expect(boot.exit).resolves.toBe(1)
  }, 20_000)
})

describe.skipIf(process.platform === 'win32')('boot.mjs frozen mode', () => {
  it('boots the frozen payload directly with no git, pnpm, or config probes', async () => {
    const frozenRoot = await mkdtemp(join(tmpdir(), 'dsh-frozen-test-'))
    tempDirs.push(frozenRoot)
    const binDir = join(frozenRoot, 'repo', 'apps', 'cli', 'lib')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, 'bin.js'), FAKE_BACKEND_JS)
    const { dataDir } = await makeEnv()
    // A minimal PATH without the fake (or any real) git/corepack/pnpm proves
    // the frozen path touches none of them.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', DSH_FROZEN_ROOT: frozenRoot }

    const boot = launchBoot(dataDir, env)
    const ready = await boot.waitFor('ready')
    expect(ready.url).toBe('http://127.0.0.1:3080')
    expect(phases(boot.events)).toEqual(['start'])
    expect((await readFile(join(frozenRoot, 'repo', '.backend-ci'), 'utf8')).trim()).toBe('unset')
    boot.kill('SIGTERM')
    await expect(boot.exit).resolves.toBe(0)
  }, 20_000)
})
