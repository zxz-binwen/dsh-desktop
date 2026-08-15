import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BRANCH,
  DEFAULT_REPO_URL,
  cloneFailureHint,
  firstPhase,
  needsBuild,
  needsShell,
  nodeSatisfiesEngines,
  parseReadinessLine,
  quoteCmdArg,
  resolveConfig,
} from '../boot.mjs'

describe('parseReadinessLine', () => {
  it('extracts the URL from the exact readiness line', () => {
    expect(parseReadinessLine('dsh web: http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
  })

  it('accepts a loopback hostname', () => {
    expect(parseReadinessLine('dsh web: http://localhost:45631')).toBe('http://localhost:45631')
  })

  it('stops before a LAN suffix', () => {
    expect(parseReadinessLine('dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)')).toBe('http://127.0.0.1:3080')
  })

  it('rejects non-readiness lines', () => {
    expect(parseReadinessLine('some other log line')).toBeNull()
    expect(parseReadinessLine('dsh web: http://127.0.0.1')).toBeNull()
    expect(parseReadinessLine('xx dsh web: http://127.0.0.1:3080')).toBeNull()
    expect(parseReadinessLine('')).toBeNull()
  })
})

describe('nodeSatisfiesEngines', () => {
  it('accepts the supported range ^22.19.0 || >=24.0.0', () => {
    expect(nodeSatisfiesEngines('v22.19.0')).toBe(true)
    expect(nodeSatisfiesEngines('v22.19.1')).toBe(true)
    expect(nodeSatisfiesEngines('v24.0.0')).toBe(true)
    expect(nodeSatisfiesEngines('v26.3.1')).toBe(true)
    expect(nodeSatisfiesEngines('24.1.0')).toBe(true)
  })

  it('rejects versions outside the range and unparseable input', () => {
    expect(nodeSatisfiesEngines('v22.18.9')).toBe(false)
    expect(nodeSatisfiesEngines('v23.4.0')).toBe(false)
    expect(nodeSatisfiesEngines('not-a-version')).toBe(false)
    expect(nodeSatisfiesEngines('')).toBe(false)
  })
})

describe('firstPhase', () => {
  it('clones before anything else when the repository is absent', () => {
    expect(firstPhase({ repoCloned: false, skipSync: false })).toBe('clone')
    expect(firstPhase({ repoCloned: false, skipSync: true })).toBe('clone')
  })

  it('syncs an existing clone unless told not to', () => {
    expect(firstPhase({ repoCloned: true, skipSync: false })).toBe('sync')
    expect(firstPhase({ repoCloned: true, skipSync: true })).toBe('none')
  })
})

describe('needsBuild', () => {
  it('skips the build when the stamp matches HEAD and the backend entry exists', () => {
    expect(needsBuild({ head: 'abc', stamp: 'abc', binExists: true })).toBe(false)
  })

  it('rebuilds on a missing stamp, a moved HEAD, or a missing backend entry', () => {
    expect(needsBuild({ head: 'abc', stamp: undefined, binExists: true })).toBe(true)
    expect(needsBuild({ head: 'abc', stamp: 'abd', binExists: true })).toBe(true)
    expect(needsBuild({ head: 'abc', stamp: 'abc', binExists: false })).toBe(true)
  })
})

describe('needsShell', () => {
  it('shells only the Windows .cmd shims', () => {
    expect(needsShell('win32', 'corepack')).toBe(true)
    expect(needsShell('win32', 'pnpm')).toBe(true)
    expect(needsShell('win32', 'git')).toBe(false)
    expect(needsShell('darwin', 'pnpm')).toBe(false)
    expect(needsShell('linux', 'corepack')).toBe(false)
  })
})

describe('quoteCmdArg', () => {
  it('passes plain words through untouched', () => {
    expect(quoteCmdArg('pnpm')).toBe('pnpm')
    expect(quoteCmdArg('--frozen-lockfile')).toBe('--frozen-lockfile')
    expect(quoteCmdArg('C:/Users/sqm/repo')).toBe('C:/Users/sqm/repo')
  })

  it('wraps anything outside the plain-word allowlist', () => {
    expect(quoteCmdArg('C:\\Users\\John Doe\\AppData\\Roaming\\x')).toBe('"C:\\Users\\John Doe\\AppData\\Roaming\\x"')
    expect(quoteCmdArg('https://example.com/repo.git?a b')).toBe('"https://example.com/repo.git?a b"')
    expect(quoteCmdArg('two words')).toBe('"two words"')
  })
})

describe('cloneFailureHint', () => {
  it('suggests a network problem for common git network failure output', () => {
    expect(cloneFailureHint(['fatal: unable to access', 'https://github.com/deepseek-ai/deepseek-harness.git/'])).toMatch(/internet connection/u)
    expect(cloneFailureHint(['fatal: Could not resolve host: github.com'])).toMatch(/internet connection/u)
    expect(cloneFailureHint(['fatal: Failed to connect to github.com port 443: Connection refused'])).toMatch(/internet connection/u)
    expect(cloneFailureHint(['fatal: unable to access', 'Failed to connect', 'network is unreachable'])).toMatch(/internet connection/u)
  })

  it('returns undefined for non-network failures and empty output', () => {
    expect(cloneFailureHint(['fatal: repository not found'])).toBeUndefined()
    expect(cloneFailureHint(['fatal: could not read Username for https://github.com: terminal prompts disabled'])).toBeUndefined()
    expect(cloneFailureHint([])).toBeUndefined()
  })
})

describe('resolveConfig', () => {
  it('derives every default path under the application data directory', () => {
    expect(resolveConfig('/data', {})).toEqual({
      repoUrl: DEFAULT_REPO_URL,
      branch: DEFAULT_BRANCH,
      repoDir: '/data/repo',
      skipSync: false,
      stampPath: '/data/build-stamp',
      logDir: '/data/logs',
    })
  })

  it('applies overrides and resolves a relative repoDir against the data directory', () => {
    const config = resolveConfig('/data', { repoUrl: 'https://example.com/repo.git', branch: 'dev', repoDir: 'checkout', skipSync: true })
    expect(config.repoUrl).toBe('https://example.com/repo.git')
    expect(config.branch).toBe('dev')
    expect(config.repoDir).toBe('/data/checkout')
    expect(config.skipSync).toBe(true)
  })

  it('keeps an absolute repoDir as given', () => {
    expect(resolveConfig('/data', { repoDir: '/elsewhere/repo' }).repoDir).toBe('/elsewhere/repo')
  })

  it('passes the shell-consumed nodeDir through and defaults it to undefined', () => {
    expect(resolveConfig('/data', {}).nodeDir).toBeUndefined()
    expect(resolveConfig('/data', { nodeDir: '/opt/node24/bin' }).nodeDir).toBe('/opt/node24/bin')
  })

  it('rejects malformed configuration loudly', () => {
    expect(() => resolveConfig('/data', null)).toThrow('config.json must be a JSON object')
    expect(() => resolveConfig('/data', ['array'])).toThrow('config.json must be a JSON object')
    expect(() => resolveConfig('/data', { unknown: 1 })).toThrow(/unknown config key "unknown"/u)
    expect(() => resolveConfig('/data', { branch: 7 })).toThrow(/"branch" must be a string/u)
    expect(() => resolveConfig('/data', { nodeDir: false })).toThrow(/"nodeDir" must be a string/u)
    expect(() => resolveConfig('/data', { repoUrl: 'ftp://example.com/repo.git' })).toThrow(/http\(s\) URL/u)
    expect(() => resolveConfig('/data', { branch: 'two words' })).toThrow(/without whitespace/u)
    expect(() => resolveConfig('/data', { branch: '--upload-pack=evil' })).toThrow(/must not start with "-"/u)
  })
})
