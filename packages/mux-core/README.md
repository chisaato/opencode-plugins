# @misakacloud/opencode-mux-core

供 OpenCode 插件和 OpenChamber 复用的 `tmux` / `psmux` 任务管理库。任务在独立 pane 中运行；即使启动方退出，也可以查询状态、读取日志、发送输入或重启。

```ts
import { createMuxManager } from "@misakacloud/opencode-mux-core"

const mux = createMuxManager()
const cwd = process.cwd()
const build = await mux.runBuild({ name: "check", cwd, command: "bun run typecheck" })
console.log(build.task.status, build.tail)

const server = await mux.serviceAction({
  action: "start",
  name: "dev",
  cwd,
  command: "bun run dev",
})
if (server.task) console.log(await mux.attachCommand(server.task))
```

- `runBuild` 默认等待最多 120 秒；`wait: false` 只启动任务，超时不会终止任务。相同目录、角色和名称的任务复用已有 pane。
- `serviceAction` 接受 `start`、`restart`、`stop`、`status`、`remove`。重复 `start` 不会重启正在运行的服务，除非指定 `restartIfRunning: true`。停止先发送 `C-c`，指定 `force: true` 时才在超时后销毁 pane。
- 已退出但仍存在的 pane 可以读取日志。外部销毁的 pane 会标记为 `gone`，可以调用 `pruneGone` 清除记录。管理器也会重新发现有管理标记但尚未写入状态的 pane。
- `previewHistory({ cwd })` 预览指定项目的失效记录和超过保留期的已结束任务（默认 7 天）。`cleanHistory` 只处理提交的预览候选，跳过状态已变化的任务并逐项报告失败。两者默认保留驻留 shell，只有传入 `includeShell: true` 才纳入。
- 状态文件按 `OPENCODE_MUX_STATE_DIR`、`$XDG_STATE_HOME/opencode-mux`、`~/.local/state/opencode-mux` 的优先级选址。可指定 `stateDir`、`socketName`、`backend` 和 `runner` 进行隔离或注入测试依赖。
- 非 Windows 的 tmux 可通过系统用户主目录下的 `~/.config/opencode/opencode-mux.json` 指定专用 `socketName`，默认读取同目录的 `tmux.conf`。可选的 `tmuxConfig` 相对 `~/.config/opencode/` 解析，绝对路径直接使用。没有该 JSON 文件时，可信调用方也可以直接把绝对 `tmuxConfig` 路径和 `socketName` 传给管理器。自定义文件只在 tmux server 启动时加载，不会重载已有 server；默认不覆盖文件中的状态栏和按键。文件能执行命令，只使用信任的配置。
- 管理器依赖 `node:sqlite`，支持 Bun ≥ 1.4.4 或 Node.js ≥ 22.13（无需 `--experimental-sqlite`）。共用同一 `stateDir` 的管理器通过 `manager-lock.sqlite` 互斥，任务仍以 JSON 保存。锁忙时异步重试，约 5 秒后抛出 `MuxError`（`code: "STATE_BUSY"`）；构建等待、日志读取和停止后的等待不持锁。
- SQLite 锁在持锁进程退出时由系统释放，不要手动删除锁文件。请把状态目录放在支持 SQLite 文件锁的本地文件系统上。锁只协调使用同一状态目录的管理器，不会把 tmux 命令和 JSON 写入变成事务，也不约束直接执行的 tmux 命令。若进程崩溃时留下已写入管理标记的占位 pane，后续状态校对会重新发现并登记它；尚未写入标记的 pane 不会自动接管。
- `command` 是调用方信任的 shell 脚本，而不是转义后的单个参数。POSIX 使用 `sh -lc`，Windows / psmux 使用 `cmd.exe /d /c`；如果嵌套 `cmd` 会改变脚本的转义或变量展开，管理器会改用轮询。
- 低层 API `createMuxClient` 提供 pane 查询、创建、重启、捕获、交互与 `wait-for` 通知；`createMuxState` 提供注册表读写。
