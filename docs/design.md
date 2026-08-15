# Design: source launcher over frozen bundle

English | [中文](design.zh.md)

## Problem

Users want a double-clickable desktop app for the DeepSeek Harness Web UI, and the app must run the latest code from GitHub on every launch — freezing a backend into the bundle would go stale immediately. The target is a developer-facing launcher, so requiring git + Node + pnpm on the machine is acceptable; self-contained distribution is not a goal.

## Decision

### Launcher over frozen bundle

The app ships no backend. `boot.mjs` (zero-dependency plain Node, because it must bootstrap a not-yet-installed clone) manages a dedicated shallow clone under the app data directory: `git clone --depth 1` on first launch, `git fetch --depth 1` + `git reset --hard FETCH_HEAD` after (a changed `repoUrl` in config.json retargets `origin` before the fetch, and a checkout whose HEAD no longer resolves — the interrupted-clone case — fails with the delete-and-reclone hint instead of a bare error). When HEAD moved (tracked by a `build-stamp` file) it runs `pnpm install --frozen-lockfile && pnpm run build`, then spawns `node apps/cli/lib/bin.js web --host 127.0.0.1 --port 0`. The clone is app-owned and reset hard; the README and config validation keep users from pointing `repoDir` at a working checkout. A failed fetch logs a notice and continues offline; only `git reset` failing is fatal (corrupt checkout → delete and re-clone).

### Tauri shell with a TypeScript orchestrator

All orchestration lives in `boot.mjs` (TypeScript-testable through exported pure functions: readiness parsing, engines check, phase planning, config resolution, Windows shim detection). The Rust half stays a thin supervisor: spawn `node boot.mjs <app-data-dir>` in its own containment, read one JSON object per stdout line, forward events to the bundled splash page, and navigate the window to the URL from the `ready` event. The readiness source of truth is the harness's own `dsh web: http://127.0.0.1:<port>` stdout line — the same signal its keyless CLI compat test consumes — not a port probe, because the line only prints after the whole plugin tree (including the `/api` route owner) settles.

The Web UI needs zero changes: the client derives every HTTP/WebSocket/plugin-bundle URL from `window.location`, and the loopback host always passes the `/api` trust fence. Loading the dist over `file://` was rejected: asset paths are root-absolute, `window.__DSH_BOOT__` is injected by server-side index taps, and plugin bundles are served by the backend's `/plugins` route.

### Shutdown contract

Quitting follows the backend's own process-shutdown semantics. On Unix the boot tree runs as a process group: SIGTERM, a 5.5 s grace matching the backend's 5 s dispose budget plus scheduling margin, then SIGKILL. The shell triggers this on window close, on `RunEvent::Exit` (dock quit, logout), and before a splash retry; `boot.mjs` additionally forwards signals it receives directly to its current child. On Windows there are no signals: the shell assigns the boot child to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — the tree dies when the shell exits or crashes, a best-effort `taskkill /T` posts WM_CLOSE first, and shutdown is otherwise immediate (the append-only JSONL session log is the data-safety story there). After readiness (splash already navigated away) backend failures surface as a native dialog offering a full-shell relaunch; a stdout-EOF guard surfaces an orchestrator crash that never reported anything.

### GUI-environment realities

Two properties of a desktop-launched process shaped the shell. First, it inherits only the system PATH, which never contains nvm or homebrew node, so the shell prepends the common node roots (env `DSH_DESKTOP_NODE_BIN_DIR`, config `nodeDir`, newest `~/.nvm/versions/node/*/bin`, volta, mise shims, homebrew on Unix; `Program Files\nodejs`, volta, scoop, nvm on Windows) to the boot process's PATH. Second, an emitted event reaches nobody until the splash attaches its listener, so the first boot is gated on a `splash_ready` invoke from the splash after `listen()` resolves — an early spawn failure surfaces on the splash instead of vanishing. On Windows, corepack/pnpm resolve only as `.cmd` shims, so `boot.mjs` spawns exactly those two through cmd.exe with a plain-word-allowlist quoting rule; git and node are real executables everywhere.

### Packaging

`scripts/build.ts` rasterizes `assets/favicon.svg` via `@resvg/resvg-js` into a 1024px source PNG and runs `tauri icon` (every platform's icon set in one command), then `tauri build` with per-platform config overlays (`tauri.{macos,windows,linux}.conf.json` select .app / NSIS / deb+AppImage) and copies whatever was produced into `dist-app/`. This repository is intentionally standalone: the launcher never imports harness code at build time and needs no lockstep versioning with the harness — it was extracted from a harness monorepo checkout on 2026-08-15 precisely because every integration point there was escape-hatch wiring around product gates.

### Frozen distribution

For direct-use distribution the same shell ships as a second flavor (`scripts/build.ts --frozen`, macOS first): the harness is cloned and built with its full dependency graph (it resolves some imports through cross-package hoisting, so a prod-only prune breaks runtime resolution), the tree is copied with every symlink resolved into a plain file tree (Tauri's resource packer drops links; pnpm's workspace links are sometimes build-machine-absolute), source maps and build caches are stripped, and an official node binary (SHA-256 verified) is frozen into the app's `frozen/` resources. At startup the shell detects `frozen/`, spawns the orchestrator with the bundled node (`DSH_FROZEN_ROOT` points `boot.mjs` at the payload), and the backend starts with zero git/pnpm/network contact; the splash footer is switched to say so via a `mode` event. The tradeoff is explicit: a frozen build never updates itself — shipping a new zip is the upgrade path — and the source launcher remains the always-fresh flavor.

## Disposition

- CI distribution, DMG, notarization (no Apple Developer identity), x64/universal macOS, and Tauri self-update are explicitly out of scope; the ad-hoc bundle requires the right-click-Open gesture on first launch.
- macOS is the fully verified platform (build + end-to-end launch); the Windows code path is cross-type-checked against `x86_64-pc-windows-msvc`, and actual Windows/Linux builds must run on their target machines.
- The splash speaks through `window.__TAURI__` globals (`withGlobalTauri`) to stay dependency-free; the remote page gains no IPC capabilities, so the navigated Web UI cannot invoke shell commands.
