# 设计：源码启动器而非冻结包

[English](design.md) | 中文

## 问题

用户希望有一个可双击运行的桌面 app 来承载 DeepSeek Harness 的 Web UI，并且应用要在每次启动时运行 GitHub 上的最新代码——把后端冻结进安装包会立刻过时。目标是面向开发者的启动器，因此机器上装有 git + Node + pnpm 是可接受的前提；自包含分发不是目标。

## 决策

### 启动器优先于冻结包

app 不内嵌任何后端。`boot.mjs`（零依赖的纯 Node 脚本，因为它必须能引导一个尚未安装的克隆）在应用数据目录下管理一份专用浅克隆：首次启动 `git clone --depth 1`，之后 `git fetch --depth 1` + `git reset --hard FETCH_HEAD`（`config.json` 里的 `repoUrl` 变更会在 fetch 前重定向 `origin`；HEAD 无法解析的检出——即克隆被中断的情形——会带“删除后重克隆”提示报错，而非裸错误）。HEAD 移动时（由 `build-stamp` 文件跟踪）执行 `pnpm install --frozen-lockfile && pnpm run build`，然后拉起 `node apps/cli/lib/bin.js web --host 127.0.0.1 --port 0`。克隆为应用所有并被硬重置；因此配置校验与 README 共同阻止用户把 `repoDir` 指向自己的工作区。fetch 失败只记录通知并离线继续；仅 `git reset` 失败视为致命（检出损坏 → 删除后重新克隆）。

### Tauri 壳 + TypeScript 编排器

全部编排逻辑在 `boot.mjs`（通过导出的纯函数接受 TypeScript 测试：就绪行解析、engines 校验、阶段规划、配置解析、Windows shim 判定）。Rust 一侧只是薄监督者：以独立容器启动 `node boot.mjs <app-data-dir>`，逐行读取 stdout 上的 JSON 对象，把事件转发给内置 splash 页，收到 `ready` 事件的 URL 后让窗口导航过去。就绪判定的事实源是 harness 自身的 `dsh web: http://127.0.0.1:<port>` stdout 行——与其 keyless CLI 兼容测试消费的是同一信号——而不是端口探测，因为该行只在整个插件树（含 `/api` 路由属主）稳定后打印。

Web UI 零改动：客户端从 `window.location` 推导全部 HTTP/WebSocket/插件 bundle URL，回环主机始终通过 `/api` 信任栅栏。经 `file://` 加载 dist 的方案被否决：资源路径是根绝对的、`window.__DSH_BOOT__` 由服务端 index tap 注入、插件 bundle 由后端 `/plugins` 路由伺服。

### 关停契约

退出遵循后端自身的进程关停语义。Unix 上 boot 树以进程组运行：SIGTERM、5.5 秒宽限（对应后端 5 秒 dispose 预算加调度余量）、然后 SIGKILL。壳在关窗、`RunEvent::Exit`（Dock 退出、注销）以及 splash 重试前触发该流程；`boot.mjs` 还会把直接收到的信号转发给当前子进程。Windows 没有信号：壳把 boot 子进程挂入设了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object——壳退出或崩溃即整树终止，此前先做 best-effort 的 `taskkill /T`（WM_CLOSE），其余情况下关停是立即的（数据安全由追加式 JSONL 会话日志承担）。就绪之后（splash 已被导航离开）后端故障以原生对话框呈现，并提供整个壳的重启选项；stdout EOF 守卫兜底呈现"编排器未报告任何东西就死亡"的情形。

### GUI 环境的现实

桌面启动进程有两个特性塑造了壳的设计。其一，它只继承系统 PATH，永远不含 nvm 或 homebrew 的 node，因此壳把常见 node 安装根（env `DSH_DESKTOP_NODE_BIN_DIR`、config `nodeDir`、最新的 `~/.nvm/versions/node/*/bin`、volta、mise shims、homebrew；Windows 上是 `Program Files\nodejs`、volta、scoop、nvm）前置到 boot 进程的 PATH。其二，事件在 splash 挂上监听器之前发出无人可达，所以首次启动由 splash 在 `listen()` 成功后 invoke `splash_ready` 门控——早期的 spawn 失败会呈现在 splash 上而不是凭空消失。Windows 上 corepack/pnpm 只能以 `.cmd` shim 解析，因此 `boot.mjs` 恰好对这两者经 cmd.exe 启动并配一条纯词白名单引用规则；git 与 node 在所有平台都是真可执行文件。

### 打包

`scripts/build.ts` 用 `@resvg/resvg-js` 把 `assets/favicon.svg` 栅格化为 1024px 源图并执行 `tauri icon`（一条命令产出全平台图标集），随后 `tauri build` 按平台 overlay（`tauri.{macos,windows,linux}.conf.json` 分别选择 .app / NSIS / deb+AppImage）并把产物拷贝到 `dist-app/`。本仓库有意保持独立：启动器在构建时不 import 任何 harness 代码，也不需要与 harness 锁步版本——2026-08-15 它从一个 harness monorepo 检出中被抽出，正是因为那边所有集成点都是绕过产品门禁的接线。

### 冻结分发

面向直接分发，同一个壳还有第二种形态（`scripts/build.ts --frozen`，先做 macOS）：克隆 harness 并以**完整依赖图**安装构建（它有跨包提升解析的导入，裁剪到生产依赖会破坏运行时解析），拷贝目录树时**保留符号链接并改写为相对路径**（Tauri 资源打包会丢弃链接，故构建后用 rsync 把载荷注入 bundle），剥离 source map 与构建缓存，把 pnpm hoisted 布局重复存储的相同文件**硬链接去重**（约 1.2 GB），与官方 node 二进制（SHA-256 校验）一起冻结。分发格式为 tar.gz——tar 单份存储去重硬链接，zip 会双倍。启动时壳检测到 `frozen/` 就用内置 node 拉起编排器（`DSH_FROZEN_ROOT` 指向 `boot.mjs` 所需载荷），后端零 git/pnpm/网络直接启动；splash 的 footer 通过一个 `mode` 事件改写说明。取舍是明确的：冻结包不自更新——发布新包即升级——源码启动器仍是"永远最新"的形态。

## 处置

- CI 分发、DMG、公证（无 Apple Developer 身份）、x64/universal macOS、Tauri 自更新明确在范围外；ad-hoc 安装包首次启动需要"右键→打开"手势。
- macOS 是完整验证过的平台（构建 + 端到端启动）；Windows 代码路径经 `x86_64-pc-windows-msvc` 交叉类型检查，实际 Windows/Linux 构建须在目标机器上执行。
- splash 通过 `window.__TAURI__` 全局（`withGlobalTauri`）通信以保持零依赖；远程页面不获得任何 IPC 权限，导航后的 Web UI 无法调用壳命令。
