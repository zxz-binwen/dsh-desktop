# dsh-desktop

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面源码启动器 —— 支持 macOS、Windows 与 Linux。

一个始终运行最新源码的桌面应用：每次启动时，内置的编排器会从 GitHub 同步一份专用的 harness 仓库克隆，HEAD 有变动就重新构建，然后启动 `dsh web` 并在应用窗口中显示 Web UI。设计决策见 [docs/design.zh.md](docs/design.zh.md)。

## 工作原理

- `boot.mjs` —— 零依赖的 Node 编排器：工具链探测、克隆/同步（`git fetch --depth 1` + `reset --hard`）、HEAD 变更时执行 `pnpm install --frozen-lockfile` + `pnpm run build`，然后拉起 `node apps/cli/lib/bin.js web --host 127.0.0.1 --port 0`，并通过解析 stdout 上的 `dsh web: http://127.0.0.1:<port>` 行报告就绪。stdout 上逐行输出 JSON 协议；由 `tests/boot.spec.ts` 覆盖。
- `splash/` —— 窗口的初始页面：启动阶段、日志尾部、重试按钮。
- `src-tauri/` —— Rust/Tauri 2 壳：以独立容器拉起 `node boot.mjs <应用数据目录>`，把事件转发给 splash，就绪后导航到后端 URL，退出时终止整棵 boot 进程树 —— Unix 上用进程组（SIGTERM → 5.5 秒宽限 → SIGKILL），Windows 上用设了 kill-on-close 的 Job Object。

启动器在构建时不 import 任何 harness 代码，也不冻结后端快照：同步完成后运行的永远是 GitHub `master` 上的最新内容。另有一种面向直接分发、内置预构建后端与 node 运行时的**冻结**分发包，见 [macOS 独立包](#macos-独立包frozen)。

## 环境约束

构建机与目标机相同：

| 要求 | 说明 |
|---|---|
| Node.js `^22.19.0 || >=24.0.0` | 硬性下限。harness 仓库钉死了 pnpm 11.7，它要求 Node ≥22.13（依赖 `node:sqlite`）；启动编排器会校验 engines 范围，版本过低时明确报错拒绝启动。 |
| pnpm | PATH 上有 `pnpm`，或者用 corepack（`corepack enable`，Node <25 自带）——corepack 会按各仓库 `packageManager` 字段钉死精确版本。 |
| git | 任意较新版本；启动器靠它克隆与同步。 |
| Rust 工具链 | <https://rustup.rs> —— 仅构建时需要；运行打包好的 app 不需要。 |

另外按平台：

- **macOS**：Xcode Command Line Tools（`xcode-select --install`）；macOS 13+
- **Windows**：git-for-windows；带 C++ 工作负载的 Visual Studio Build Tools（node-pty 经 node-gyp 编译）
- **Linux**：Tauri 系统库（webkit2gtk 4.1、librsvg、patchelf —— 见 [Tauri 前置说明](https://tauri.app/start/prerequisites/)）加 C 编译器

两个最常见的坑的快速自检：

```sh
node -v          # 必须是 v22.19+ 或 v24+（v20/v21 一律不行）
pnpm -v          # 或：corepack pnpm -v
```

没有全局 pnpm、默认 Node 又偏旧的 nvm 用户通常需要：

```sh
nvm alias default 24   # 抬高默认版本；钉死的 pnpm 在 Node 20 上跑不起来
nvm use 24             # 当前 shell 立即生效
corepack enable        # 生成 pnpm shim；每装一个新 Node 版本后需重跑一次
```

打包好的 app 本身**不需要**全局 `pnpm` —— 壳会把常见 node 安装根前置到 PATH，编排器会回退到 corepack 并自建 shim —— 但机器上的 `node` 必须满足上述版本范围，因为 app 运行的一切都通过 `node` 拉起。

## 构建（在目标平台上）

```sh
pnpm install
pnpm run build          # 或：pnpm exec tsx scripts/build.ts --icon
```

脚本会把 `assets/favicon.svg` 栅格化为 1024px 源图并运行 `tauri icon` 重新生成 `src-tauri/icons/`（用 `--icon` 强制），随后用 `tauri build` 编译壳，并把产物拷贝到 `dist-app/`：

- macOS：`DeepSeek Harness.app`（ad-hoc 签名 —— 首次启动右键 → 打开）
- Windows：NSIS 安装器 `.exe`（未签名 —— 首次运行 SmartScreen 可能告警）
- Linux：`.deb` 与 `.AppImage`

壳的开发模式（实时重建）：`pnpm run dev`（splash 会以真实应用数据启动真实编排器）。

### macOS 独立包（`--frozen`）

```sh
pnpm run build --frozen       # 可选：--node-version v24.19.0 --harness-ref master
```

独立（冻结）包把 harness **和** Node 运行时一起打进安装包：打开即用、不联网、目标机器无需安装任何东西（不需要 git、pnpm、Node）。构建时克隆 harness，安装并构建**完整依赖图**（harness 有跨包提升解析的导入，裁剪到生产依赖会破坏运行时解析），拷贝目录树时**保留符号链接**并改写为相对路径（Tauri 资源打包会丢弃链接，故载荷在构建后注入），剥离 source map 与构建缓存，并把 pnpm 布局重复存储的约 1.2 GB 相同文件**硬链接去重**。启动时壳检测到 `frozen/` 就用内置 node 直接拉起后端，splash 也会注明。产物：`dist-app/DeepSeek-Harness-<版本>-macos-<架构>-standalone.tar.gz`（约 400 MB；tar 单份存储去重硬链接——zip 会双倍），可直接附到 GitHub Release（`gh release create ... --draft`）。冻结包不会自更新——升级即发布新的包。

## 开发

```sh
pnpm test        # boot 编排器测试（单元 + 假工具链端到端）
pnpm typecheck   # 类型检查构建脚本与测试
```

## 每用户数据

- macOS：`~/Library/Application Support/com.deepseek-ai.dsh-desktop/`
- Windows：`%APPDATA%\com.deepseek-ai.dsh-desktop\`
- Linux：`~/.local/share/com.deepseek-ai.dsh-desktop/`

该目录下：

- `repo/` —— 受管克隆。它归应用所有：不要把 `repoDir` 指向你的工作区检出，因为启动器会用 `git reset --hard` 硬重置它。
- `build-stamp` —— 当前构建对应的 HEAD。
- `bin/` —— corepack 的 `pnpm` shim（node 未自带 `pnpm` 二进制时生成）。
- `logs/backend.log` —— 追加写入的后端输出。
- `config.json` —— 可选覆盖：

  | 键 | 默认值 | 含义 |
  |---|---|---|
  | `repoUrl` | `https://github.com/deepseek-ai/deepseek-harness.git` | 克隆来源 |
  | `branch` | `master` | 跟踪分支 |
  | `repoDir` | `<数据目录>/repo` | 克隆位置；相对路径按数据目录解析 |
  | `skipSync` | `false` | 启动时不联系 GitHub |
  | `nodeDir` | 自动探测 | 含 `node` 可执行文件的目录 |

桌面启动的应用只能看到极简的 GUI PATH，因此壳在拉起编排器前会把常见的 node 安装根前置：`DSH_DESKTOP_NODE_BIN_DIR`，然后是 `config.json` 的 `nodeDir`，再是平台集合 —— Unix 上取最新的 `~/.nvm/versions/node/*/bin`、`~/.volta/bin`、`~/.local/share/mise/shims`、`/opt/homebrew/bin`、`/usr/local/bin`；Windows 上取 `Program Files\nodejs`（两个宽度）、`~\.volta\bin`、`~\scoop\shims`、`%APPDATA%\nvm` —— 含有 node 二进制的目录按序优先。

会话、配置与设置不存放在这里：后端使用常规的 Harness home（默认 `~/.dsh`），因此应用与同机源码检出共享状态。

## 行为说明

- 离线启动：`git fetch` 失败时记录一条通知并继续使用现有检出。只有首次启动需要网络——没有现有克隆时，失败的 `git clone` 会中止并给出网络提示。
- 在 `config.json` 中更改 `repoUrl` 后，下次启动会把现有克隆的 `origin` 重定向到新地址（记录一条通知）；切换来源无需删除 `repo/`。HEAD 无法解析的检出（首启克隆被中断）会失败并给出“删除后重克隆”的提示。
- 首次启动需要克隆和构建，耗时数分钟；之后 HEAD 没变时启动很快。
- 端口由操作系统分配（`--port 0`）；窗口导航到后端报告的任意 URL。
- 关窗即终止整棵后端进程树；二次启动实例会聚焦已有窗口。
- **Windows 关停是立即的**：没有 POSIX 信号，best-effort `taskkill` 之后壳直接关闭 Job Object 句柄、整树即刻终止。追加式 JSONL 会话日志保证已记录数据的安全；5 秒优雅退出只存在于 macOS/Linux。

## 范围外

CI 分发、签名/公证（此处没有代码签名身份）、x64/universal macOS 构建、Tauri 自更新。

## 许可证

[MIT](LICENSE)
