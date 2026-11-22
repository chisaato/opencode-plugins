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
- 状态文件按 `OPENCODE_MUX_STATE_DIR`、`$XDG_STATE_HOME/opencode-mux`、`~/.local/state/opencode-mux` 的优先级选址。可指定 `stateDir`、`socketName`、`backend` 和 `runner` 进行隔离或注入测试依赖。
- `command` 是调用方信任的 shell 脚本，而不是转义后的单个参数。POSIX 使用 `sh -lc`，Windows / psmux 使用 `cmd.exe /d /c`；如果嵌套 `cmd` 会改变脚本的转义或变量展开，管理器会改用轮询。
- 低层 API `createMuxClient` 提供 pane 查询、创建、重启、捕获、交互与 `wait-for` 通知；`createMuxState` 提供注册表读写。
