# OpenCode Mux

OpenCode V2 插件：在独立的 tmux/psmux pane 中运行构建、测试和后台服务。人和模型可以查看同一个 pane；命令退出或工具等待超时后，仍可查看日志或重启任务。

## 安装

1. 安装 `tmux`（Linux/macOS）或 `psmux`（Windows），确保可执行文件在 OpenCode 的 `PATH` 上。
2. 在项目或全局的 `opencode.jsonc` 中配置插件，再重启 OpenCode：

```jsonc
{
  "plugins": ["@misakacloud/opencode-mux"]
}
```

插件从 `ctx.options` 读取配置，无需另建 `mux.jsonc`。需要自定义时使用：

```jsonc
{
  "plugins": [
    {
      "package": "@misakacloud/opencode-mux",
      "options": {
        "preferred": "tmux",
        "socketName": "opencode",
        "stateDir": "/path/to/mux-state",
        "defaultTimeoutMs": 120000,
        "defaultTailLines": 50,
        "statusTheme": "powerline"
      }
    }
  ]
}
```

选项均可省略。`preferred` 指定优先探测的后端，不可用时会回退（Windows 默认优先 `psmux`，其他平台默认优先 `tmux`）。`socketName` 为复用器 socket 名；`stateDir` 为任务记录目录，相对路径以项目目录为基准。未指定时，优先使用 `OPENCODE_MUX_STATE_DIR`，否则用 `$XDG_STATE_HOME/opencode-mux` 或 `~/.local/state/opencode-mux`。`defaultTimeoutMs` 覆盖构建等待和服务停止的默认时限（分别为 120 秒和 2 秒），`defaultTailLines` 覆盖构建、服务和重启的默认尾部日志行数（分别为 80、30、30；设为 `0` 可禁用）。单次工具入参优先于全局默认值。

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `statusTheme` | `powerline`（Windows/psmux 自动用 `ascii`） | `powerline` 为分段彩色底栏；`ascii` 使用纯文本分隔；`off` 不写入主题设置。 |

## 工具

| 工具 | 用途 |
| --- | --- |
| `mux_run_build` | 传入 `name`、`command` 运行构建或测试。默认等待结束并返回状态、退出码和日志；设 `wait: false` 可立即返回。 |
| `mux_service` | 按 `name` 和 `cwd` 管理服务：`start`、`restart`、`stop`、`status`、`remove`。新服务需要 `command`；`stop` 默认发送中断，设 `force: true` 可在停止超时后关闭 pane。 |
| `mux_restart` | 通过 `id` 或名称重启构建或服务，可传入 `command` 替换原命令。 |
| `mux_logs` | 读取最近的日志，默认 `100` 行，可用 `lines` 覆盖。 |
| `mux_input` | 向仍活着的 pane 发送文本，包括驻留的 shell。默认追加回车；`enter: false` 只发送文本。 |
| `mux_remove` | 移除单个构建或服务。设 `session: true` 可关闭整个项目会话。 |
| `mux_list` | 默认只列出当前项目的任务。用 `all: true` 查看所有项目，或用 `cwd`、`role`、`status` 筛选。`pruneGone: true` 会先清理目录和角色范围内已丢失 pane 的记录，不受 `status` 筛选影响。 |

运行构建和管理服务时，省略 `cwd` 使用当前项目目录。对于重启、日志和输入，`id` 最准确；仅提供 `name` 时会搜索所有目录，出现同名任务时会列出候选项，可追加 `role`、`cwd` 或改用 `id`。

### 移除任务或关闭会话

- `mux_remove({ id: "<任务 ID>" })`：只移除指定的构建或服务；若 pane 已不存在，仍会清理任务记录。也可用 `name` 配合 `role`、`cwd` 定位。
- `mux_remove({ session: true, cwd: "." })`：关闭当前项目的整个会话，终止会话中的所有任务、断开已附加的终端，并清理该会话的全部任务记录。省略 `cwd` 时也使用当前项目。

## 接手与排查

1. 用 `mux_run_build` 运行例如 `bun run test`，或用 `mux_service` 的 `start` 启动开发服务器。
2. 在普通终端运行结果里的 `attachCommand`，进入对应的 tmux/psmux 会话。按 `Ctrl-b` 然后 `d` 可解除附加，不会停止任务（使用默认键位时）。
3. 构建失败时查看退出码和尾部日志；构建等待超时并不终止 pane。可用 `mux_logs` 继续查看或用 `mux_restart` 重试。服务不再需要时可先 `stop`；确认不要保留 pane 和记录后再 `remove`。

### tmux 键位与人工接手

在本机使用默认 socket 时，`byobu attach -t =<会话名>` 和 `tmux attach -t =<会话名>` 都能连接。mux 会话默认使用 Byobu 风格键位：F2 新建窗口，F3/F4 切换到上一个/下一个窗口，F6 脱离，F7 回看滚动历史，F8 重命名窗口；Alt+←/→ 也可以切换窗口。键位不影响其他会话。

命令退出后，pane 默认保留交互式 shell；`mux_list` 用 `shell: true` 标记，任务状态和退出码仍反映原命令结果。AI 可以用 `mux_input` 设置 `enter: false` 预填命令，由人在终端检查后按回车。可在插件配置的 `options` 中分别关闭这两个功能；Windows/psmux 沿用原行为。

```jsonc
"options": {
  "keepShellOnExit": false,
  "byobuKeys": false
}
```

### 退出与脱离

- 按 **F6** 只脱离会话，后台任务继续运行，驻留 shell 和日志也会保留。想稍后接着操作，就先按 F6，不要退出 shell。
- 在驻留 shell 中按 **Ctrl+D** 或执行 `exit`，tmux 会自动清理该 pane。窗口里的最后一个 pane 退出时，窗口也会关闭；最后一个窗口退出时，会话随之结束。
- 要主动关闭整个项目会话，可使用 OpenChamber 面板的关闭会话操作，或调用 `mux_remove({ session: true })`。这会终止会话中的任务，不只是脱离。

### 会话外观

主题只应用于 mux 项目会话：底栏左侧显示 `mux`，中间是窗口标签并高亮当前窗口，右侧显示会话名、日期和每秒更新的时钟。按 F2 新开的窗口也会套用主题。主题启用鼠标，可点击标签切换窗口、滚轮回看、拖动窗格边框。

`powerline` 适合支持彩色状态栏的 tmux 终端。`ascii` 保留窗口高亮，改用 `序号:名称` 和 `+` 分隔，不依赖特殊字体，适合 Windows/psmux 或偏好纯文本标签的终端。设 `statusTheme: "off"` 可保留终端复用器的外观配置；不会撤销已在旧会话上应用的主题。
