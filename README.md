# dsh-desktop

English | [中文](README.zh.md)

Desktop source launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — macOS, Windows, and Linux.

A desktop app that always runs the latest source: on every launch the bundled orchestrator syncs a dedicated clone of the harness repository from GitHub, rebuilds it when HEAD moved, then starts `dsh web` and shows the Web UI in the app window. Design and decisions: [docs/design.md](docs/design.md).

## How it works

- `boot.mjs` — zero-dependency Node orchestrator: toolchain probes, clone/sync (`git fetch --depth 1` + `reset --hard`), `pnpm install --frozen-lockfile` + `pnpm run build` when HEAD changed, then spawns `node apps/cli/lib/bin.js web --host 127.0.0.1 --port 0` and reports readiness by parsing the `dsh web: http://127.0.0.1:<port>` stdout line. Speaks a one-JSON-per-line protocol on stdout; covered by `tests/boot.spec.ts`.
- `splash/` — the window's initial page: boot phases, a log tail, and a retry button.
- `src-tauri/` — the Rust/Tauri 2 shell: spawns `node boot.mjs <app-data-dir>`, forwards events to the splash, navigates to the backend URL on readiness, and terminates the whole boot tree on quit — via a Unix process group (SIGTERM → SIGKILL after the 5.5 s grace) or, on Windows, a Job Object with kill-on-job-close.

The launcher never imports harness code at build time and never freezes a backend snapshot: whatever `master` holds on GitHub is what runs after the sync settles.

## Prerequisites

Build machine and target machine alike:

| Requirement | Detail |
|---|---|
| Node.js `^22.19.0 || >=24.0.0` | Hard floor. The harness repository pins pnpm 11.7, which requires Node ≥22.13 (`node:sqlite`); the boot orchestrator checks the engines range and fails loudly on older versions. |
| pnpm | Either a `pnpm` on PATH, or corepack (`corepack enable`), which ships with Node <25 and pins the exact version from each repository's `packageManager` field. |
| git | Any recent version; the launcher clones and syncs through it. |
| Rust toolchain | <https://rustup.rs> — build only; not needed to run a packaged app. |

Per platform additionally:

- **macOS**: Xcode Command Line Tools (`xcode-select --install`); macOS 13+
- **Windows**: git-for-windows; Visual Studio Build Tools with the C++ workload (node-pty compiles via node-gyp)
- **Linux**: the Tauri system libraries (webkit2gtk 4.1, librsvg, patchelf — see the [Tauri prerequisites](https://tauri.app/start/prerequisites/)) plus a C compiler

Quick check of the two most common gaps:

```sh
node -v          # must print v22.19+ or v24+ (a bare v20/v21 will NOT work)
pnpm -v          # or: corepack pnpm -v
```

nvm users with no global pnpm and an older default Node typically need:

```sh
nvm alias default 24   # raise the default; the pinned pnpm cannot run on Node 20
nvm use 24             # take effect in the current shell
corepack enable        # creates the pnpm shim; re-run after installing a new Node version
```

The packaged app itself does **not** need a global `pnpm` — the shell augments PATH with common node roots and the orchestrator falls back to corepack, creating its own shims — but the machine's `node` must satisfy the range above, because the app spawns `node` for everything it runs.

## Build (on the target platform)

```sh
pnpm install
pnpm run build          # or: pnpm exec tsx scripts/build.ts --icon
```

The script rasterizes `assets/favicon.svg` into a 1024px source PNG and runs `tauri icon` to regenerate `src-tauri/icons/` for every platform (force with `--icon`), compiles the shell with `tauri build`, and copies the produced bundles into `dist-app/`:

- macOS: `DeepSeek Harness.app` (ad-hoc signed — right-click → Open on first launch)
- Windows: NSIS setup `.exe` (unsigned — SmartScreen may warn)
- Linux: `.deb` and `.AppImage`

Shell development with live rebuild: `pnpm run dev` (the splash boots the real orchestrator against real app data).

## Per-user state

- macOS: `~/Library/Application Support/com.deepseek-ai.dsh-desktop/`
- Windows: `%APPDATA%\com.deepseek-ai.dsh-desktop\`
- Linux: `~/.local/share/com.deepseek-ai.dsh-desktop/`

Under that directory:

- `repo/` — the managed clone. It is app-owned: never point `repoDir` at a working checkout, because the launcher resets it with `git reset --hard`.
- `build-stamp` — the HEAD the current build corresponds to.
- `bin/` — corepack `pnpm` shims (created when node ships no `pnpm` binary).
- `logs/backend.log` — appended backend output.
- `config.json` — optional overrides:

  | Key | Default | Meaning |
  |---|---|---|
  | `repoUrl` | `https://github.com/deepseek-ai/deepseek-harness.git` | clone source |
  | `branch` | `master` | tracked branch |
  | `repoDir` | `<data>/repo` | clone location; relative paths resolve against the data directory |
  | `skipSync` | `false` | start without contacting GitHub |
  | `nodeDir` | auto-detected | directory containing the `node` executable |

A desktop-launched app sees a minimal GUI PATH, so the shell prepends common node roots before spawning the orchestrator: `DSH_DESKTOP_NODE_BIN_DIR`, then `config.json` `nodeDir`, then the platform set — newest `~/.nvm/versions/node/*/bin`, `~/.volta/bin`, `~/.local/share/mise/shims`, `/opt/homebrew/bin`, `/usr/local/bin` on Unix; `Program Files\nodejs` (both widths), `~\.volta\bin`, `~\scoop\shims`, `%APPDATA%\nvm` on Windows — the first entries containing a node binary win.

Sessions, profiles, and settings are NOT stored there: the backend uses the ordinary Harness home (`~/.dsh` by default), so the app shares state with a source checkout on the same machine.

## Behavior notes

- Offline launch: a failed `git fetch` logs a notice and continues with the existing checkout.
- First launch clones and builds, so it takes minutes; later launches are fast when HEAD did not move.
- The port is OS-assigned (`--port 0`); the window navigates to whatever URL the backend reports.
- Closing the window terminates the whole backend tree; a second instance focuses the existing window.
- **Windows shutdown is immediate**: there are no POSIX signals, so after a best-effort `taskkill` the shell closes the Job Object handle and the tree terminates at once. The append-only JSONL session log keeps recorded data safe; the graceful 5-second dispose exists only on macOS/Linux.

## Out of scope

CI distribution, signing/notarization (no code-signing identity here), x64/universal macOS builds, Tauri self-update.

## License

[MIT](LICENSE)
