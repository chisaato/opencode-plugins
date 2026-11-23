# Mux 任务使用手册

Mux 把构建、测试和后台服务放进独立的 `tmux`（Linux/macOS）或 `psmux`（Windows）终端窗格（pane）。OpenCode 的 AI 工具和 OpenChamber 的面板可在**同一主机、同一用户、同一复用器 socket 与状态目录**下管理同一批任务。等待构建超时只结束等待，不会杀掉后台任务。

## 目录

- [简介与架构](#简介与架构)
- [安装](#安装)
- [快速上手](#快速上手)
- [按键与退出](#按键与退出)
- [OpenCode 工具参考](#opencode-工具参考)
- [插件配置参考](#插件配置参考)
- [HTTP API](#http-api)
- [故障排查 FAQ](#故障排查-faq)

## 简介与架构

| 层 | 入口 | 作用 |
| --- | --- | --- |
| OpenCode 插件 | 扩展自带的 `opencode-plugin/index.js`，或独立包 `@misakacloud/opencode-mux` | 注册 `mux_*` 工具；全局配置只保留**一个插件来源/一条加载路径**，避免重复注册 ID `opencode-mux`。 |
| OpenChamber 扩展 | `panel/index.html`、`status/index.html`、`service/main.js` | 增加 Mux Tasks 面板、项目状态区和本地 HTTP 服务；面板创建/筛选/查看任务，复制附加命令，查看日志与发送输入。 |
| 共享状态 | 默认 `~/.local/state/opencode-mux/` | `tasks/<任务 ID>.json` 保存任务记录；`exit/` 保存命令退出码哨兵。插件与扩展服务通过状态记录及同一复用器会话协作，不是两套独立任务。 |

OpenChamber 服务只监听服务端 `127.0.0.1`，使用宿主注入的 Bearer token 鉴权，以服务端用户身份运行；`service` 权限列出的可执行文件是权限声明，不是操作系统沙箱。`opencodePlugin` 权限允许扩展贡献 OpenCode 插件。扩展要求 OpenChamber `>=1.22.0`。远程 OpenCode 无法直接加载只存在于 OpenChamber 主机的本地路径；应分别安装可访问的插件，并保证双方实际共享主机/用户、socket 和状态目录。

状态目录优先级：插件显式 `options.stateDir`（只影响插件）→ `OPENCODE_MUX_STATE_DIR` → `$XDG_STATE_HOME/opencode-mux` → `~/.local/state/opencode-mux`。服务不读取插件 `options`，宿主也会过滤扩展服务的环境变量；不需要自定义时，两端同用户使用默认目录最简单。要让两边使用同一个专用 tmux socket，使用下面的[用户级 tmux 配置](#用户级-tmux-配置)。

## 安装

先在**实际运行 OpenChamber 服务和/或 OpenCode 的主机**安装 `tmux`（Linux/macOS）或 `psmux`（Windows），确保对应进程的 `PATH` 可以找到它。下面是两种可选路径，**不要同时把扩展插件与独立 mux 插件注册到同一 OpenCode 实例**。

### 路径一：安装 OpenChamber 扩展，同时为 OpenCode 配置同一路径

1. 从源码准备已构建扩展（在仓库根目录执行；使用发布的已构建扩展时可跳过）：

   ```sh
   bun install
   cd packages/openchamber-mux
   bun run build
   ```

   完整扩展应包含 `panel/main.js`、`status/main.js`、`service/main.js`、`opencode-plugin/index.js`；`--service-only` 仅用于服务调试，不是完整扩展安装产物。
2. 在 OpenChamber Web/桌面版的 **Settings → Extensions（设置 → 扩展）**中从文件夹安装构建后的 `packages/openchamber-mux`，审核并批准 `service` 和 `opencodePlugin` 权限，打开 **Mux Tasks** 面板。若宿主已经为其管理的 OpenCode 实例自动注入该插件，就**不要**再在该实例的 `plugins` 中配置第二份。
3. 若使用自行管理的 OpenCode，需在全局 `~/.config/opencode/opencode.jsonc` 的现有 `plugins` 数组中**仅保留一条**指向扩展中 `opencode-plugin` 目录的路径，再重启 OpenCode。例如把示例路径替换为你机器上的实际绝对路径：

   ```jsonc
   {
     "plugins": [
       "/data/SourceCode/opencode-plugins/packages/openchamber-mux/opencode-plugin"
     ]
   }
   ```

   与扩展加载的插件使用**同一个目录**，不要同时配置 `@misakacloud/opencode-mux`、另一份 bundle 或指向不同目录的同 ID 插件。不要为同一实例再额外添加 managed 插件记录；使用 `delivery: "file"` 的扩展插件时尤其无需手动写 managed 项。

**本机当前形态（仅供对照，并非通用路径）：** `~/.config/opencode/opencode.jsonc` 的 `plugins` 第 8 项是 `/data/SourceCode/opencode-plugins/packages/openchamber-mux/opencode-plugin`；它是目录路径，既不是 `packages/mux` 包名，也不是 `opencode-plugin/index.js` 文件路径。保持此项作为唯一的 mux 插件来源即可。

### 路径二：只在独立 OpenCode 使用 mux

不需要 OpenChamber 面板/状态区/服务时，在项目或全局 `opencode.jsonc` 中**只**注册独立包，然后重启 OpenCode：

```jsonc
{
  "plugins": ["@misakacloud/opencode-mux"]
}
```

也可配置内联 `options`，见[插件配置参考](#插件配置参考)。此路径仅提供工具，不提供 OpenChamber 面板。若后来安装扩展，先清理重复加载项。

## 快速上手

1. 在 OpenCode 中请 AI 调用 `mux_run_build`，例如传入以下工具参数（这是**工具入参**，不是 shell 命令；`cwd` 省略时为当前项目）：

   ```json
   {"name":"检查","command":"bun run typecheck","wait":false}
   ```

   独立插件的 `wait` 默认 `true`，会等待最多 120 秒并返回退出状态、`exitCode` 和尾部日志；`wait:false` 立即返回任务信息，`ok` 此时只代表启动成功。OpenChamber 面板新建构建及 HTTP 接口默认后台运行。无论是否等待，返回的 `id`、`muxSession`、`paneId` 和 `attachCommand` 都可用于后续查看。
2. 调用 `mux_list`（如 `{"cwd":"."}`）找到任务 ID 与会话名；在 OpenChamber 面板可选“当前项目/全部项目”、构建/后台服务筛选，点击任务查看详情、自动刷新日志（80/200/500 行）、复制日志或 **Attach** 命令。
3. 在**同一主机、同一用户**的普通终端，优先直接运行返回的 `attachCommand`。在本机默认 tmux socket、且已知 `muxSession` 的情况下，例如：

   ```sh
   tmux attach -t =oc-myproject-12345678
   # 已安装 byobu 时也可以使用：
   byobu attach -t =oc-myproject-12345678
   ```

   将示例会话名替换为返回值；自定义 socket 时应以实际 `attachCommand` 为准。附加后可以人工阅读、输入、接管运行中的程序；**F6 是脱离，任务继续在后台运行**。Windows/psmux 按工具返回的附加命令操作。
4. 对命令已退出但仍驻留 shell 的 tmux pane，AI 可先调用：

   ```json
   {"id":"<从 mux_list 取得的任务 ID>","input":"git status","enter":false}
   ```

   然后人在已附加的终端确认内容，**自己按回车**执行。`mux_list` 中的 `shell: true` 表示原命令已结束、pane 仍有交互式 shell；记录的状态和退出码仍指**原命令**。也可在面板的标准输入栏取消勾选“回车”后发送文本。

## 按键与退出

默认启用的 Byobu 风格快捷键只在此 mux 创建的 tmux 会话里生效，不修改其他会话。终端/平台不转发功能键时，可使用 tmux 原生前缀键操作；Windows/psmux 沿用自身行为。

| 按键 | 在 mux 的 tmux 会话中 |
| --- | --- |
| **F2** | 新建窗口。 |
| **F3 / F4** | 上一个 / 下一个窗口。 |
| **F6** | **仅脱离（detach）**；后台任务、驻留 shell 和记录继续保留，稍后可以再次 attach。 |
| **F7** | 进入回看/滚动历史。 |
| **F8** | 重命名窗口。 |
| **M-← / M-→**（Alt+左 / Alt+右） | 上一个 / 下一个窗口。 |
| **Ctrl+D** 或在驻留 shell 执行 `exit` | **退出该 shell，不是脱离。新增：** pane 自动清理；窗口的最后一个 pane 退出则窗口关闭，最后一个窗口退出则会话结束。要保留现场请按 F6，不要退出 shell。 |

默认在 POSIX tmux 上，命令结束后保留交互式 shell 供人工接管；`keepShellOnExit:false` 可关闭，任务结束后按复用器的原有退出行为处理。`byobuKeys:false` 关闭上述自定义键位；此时脱离可用 tmux 默认的 **Ctrl-b 然后 d**。插件的这两个 `options` 不会改变扩展服务自行启动任务时的默认值。

| 操作 | 确认与后果 |
| --- | --- |
| 面板任务卡片/详情“移除” | 第一次点击显示就地确认，第二次点“确认移除”；运行中明确显示“终止并移除”。销毁该任务的 pane 并删除记录，pane 已不在也可移除记录；可取消或按 Esc。 |
| 面板非空会话组“关闭会话” | 弹框显示会话名、目录、任务数及运行中任务数；需点击“确认关闭会话”。终止该会话**全部**任务（包括后台服务）、删除任务记录，已 attach 的终端会被脱离；这不是 F6。 |
| 面板“清理历史” | 预览当前项目失效记录和超过 7 天的已结束任务，再一次确认。默认保留驻留 shell；只有确认不再需要里面的交互现场时才勾选。不会终止运行中的任务，也不会删除手工开的非受管 pane。 |
| `mux_remove({"id":"<任务 ID>"})` | 仅移除单任务；也可用 `name`、`role`、`cwd` 定位。 |
| `mux_remove({"session":true,"cwd":"."})` | 按 `cwd` 关闭整个项目的 mux 会话；忽略 `id/name/role`，省略 `cwd` 时使用当前项目。**工具调用本身不提供面板的二次确认**。 |

## OpenCode 工具参考

以下示例是发给 AI 的 JSON **工具入参**；`id` 从 `mux_list` 获取。涉及 `cwd` 时相对路径以当前项目目录为基准；无 `cwd` 的单任务名称查询默认搜索**所有目录**，同名任务必须补充 `role/cwd` 或改用 `id`。整数参数必须是 `0` 至 `2147483647`；`tailLines:0` 不抓取尾部日志。工具由 OpenCode 插件提供，OpenChamber 面板不要求手动调用它们。

| 工具 | 参数与默认值 | 示例及结果 |
| --- | --- | --- |
| `mux_run_build` | 必填 `name:string`、`command:string`；可选 `cwd:string`（当前项目）、`wait:boolean`（`true`）、`timeoutMs:integer`（120000，覆盖等待时限）、`tailLines:integer`（80）。 | `{"name":"检查","command":"bun run typecheck","wait":false}`；返回状态、退出码（可为 `null`）、`timedOut`、日志尾部、附加命令；等待超时不终止 pane。 |
| `mux_service` | 必填 `action:"start" \| "restart" \| "stop" \| "status" \| "remove"`、`name:string`；可选 `command:string`（新服务必填；已有服务重启可沿用）、`cwd`（当前项目）、`restartIfRunning:boolean`（`false`；只用于 `start`）、`force:boolean`（`false`；停止超时后是否强停）、`timeoutMs:integer`（停止默认 2000）、`tailLines:integer`（30）。 | `{"action":"start","name":"开发服务","command":"npm run dev"}`；按名称及目录管理后台服务，`remove` 同时删除 pane 和记录。 |
| `mux_restart` | 必须指定 `id` 或 `name`；可选 `role:"build" \| "service"`、`cwd`、`command:string`（覆盖原命令）、`tailLines:integer`（30）。 | `{"id":"<任务 ID>"}`；重启已有构建/服务，返回新状态和尾部日志。 |
| `mux_logs` | 必须指定 `id` 或 `name`；可选 `role`、`cwd`、`lines:integer`（100）。 | `{"id":"<任务 ID>","lines":200}`；读取 pane 最近日志。 |
| `mux_input` | 必填 `input:string`（可为空，仅发回车），并指定 `id` 或 `name`；可选 `role`、`cwd`、`enter:boolean`（`true`）。 | `{"id":"<任务 ID>","input":"git status","enter":false}`；向仍活着的 pane 发送字面文本，含退出后驻留的 shell；`false` 不发送回车。 |
| `mux_remove` | 单任务必须指定 `id` 或 `name`（可选 `role`、`cwd`）；可选 `session:boolean`（`false`）。`session:true` 时仅 `cwd` 定位会话（默认当前项目）。 | `{"id":"<任务 ID>"}` 移除单任务；`{"session":true,"cwd":"."}` 关闭整个会话并清理其记录。 |
| `mux_clean_history` | 可选 `cwd`（当前项目）、`retentionDays`（7）、`includeShell`（`false`）；确认时传入预览给出的 `candidates`。 | `{}` 预览。确认时保留相同的筛选参数；预览后重启或状态变化的任务会跳过。 |
| `mux_list` | 可选 `cwd`（当前项目）、`all:boolean`（`false`，仅在未指定 `cwd` 时查看所有项目）、`role:"build" \| "service"`、`status:"running" \| "succeeded" \| "failed" \| "stopped" \| "gone"`、`pruneGone:boolean`（`false`）。 | `{"all":true,"pruneGone":true}`；先按目录/角色范围清理已失去 pane 的记录，再按状态筛选显示；清理范围**不受** `status` 限制。 |

`defaultTimeoutMs` 与 `defaultTailLines` 是 OpenCode 插件的工具默认值覆盖项：分别覆盖构建等待/服务停止的原默认时限（120 秒/2 秒）和构建/服务/重启的原默认尾部行数（80/30/30）。单次工具参数优先。`mux_logs.lines` 的默认 100 行不受 `defaultTailLines` 影响。

## 插件配置参考

只用于 OpenCode 插件；写在该插件配置项的内联 `options` 中，不需额外创建 `mux.jsonc`。例如独立包：

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
        "keepShellOnExit": false,
        "byobuKeys": false
      }
    }
  ]
}
```

仅配置需要改动的字段；不要把此示例与扩展的同 ID 插件一起启用。

| 选项 | 类型、默认值 | 效果 |
| --- | --- | --- |
| `preferred` | `"tmux" \| "psmux"`；Windows 默认优先 `psmux`，其他平台优先 `tmux` | 优先探测哪个后端，不可用则尝试另一个。 |
| `socketName` | 非空字符串；默认使用复用器默认 socket | 指定复用器 socket 名；非默认 socket 的 attach 应使用工具返回的 `attachCommand`，并注意扩展服务也需连到同一 socket 才能共享任务。 |
| `stateDir` | 非空路径；默认按环境变量和用户目录解析 | 任务记录与 `exit/` 哨兵目录；相对路径以 OpenCode 当前项目目录为基准。只设置插件此项不会修改扩展服务状态目录。 |
| `defaultTimeoutMs` | 非负整数；未设置时构建等待 120000 ms，服务停止 2000 ms | 覆盖两种操作的默认超时；超时不自动杀死构建，停止服务可用 `force:true` 强停。 |
| `defaultTailLines` | 非负整数；未设置时构建 80 行、服务/重启 30 行 | 覆盖这些工具的默认尾部行数；`0` 禁用抓取。 |
| `keepShellOnExit` | 布尔值，默认 `true` | POSIX tmux 中命令退出后保留交互式 shell 并用哨兵记录原命令退出码；设 `false` 不驻留 shell，也不启用该哨兵机制，按原有 pane 退出行为处理。Windows/psmux 沿用原行为。 |
| `byobuKeys` | 布尔值；普通模式默认 `true`，自定义 tmux 配置默认 `false` | 对 mux 创建的 tmux 会话启用上表键位；设 `false` 不设置这些自定义键位，使用 tmux 自身键位。Windows/psmux 沿用原行为。 |
| `statusTheme` | `"powerline" \| "ascii" \| "off"`；自定义 tmux 配置默认 `off` | 指定 Mux 状态栏样式；`off` 保留 tmux 自身样式。 |

未知字段或无效选项值被忽略；数值选项必须是安全的非负整数且不超过 `2147483647`。扩展本地服务单独创建核心管理器，不继承这些插件选项。

### 用户级 tmux 配置

在 **OpenChamber 服务端**，在运行 OpenChamber 的系统用户主目录下创建 `~/.config/opencode/opencode-mux.json`：

```json
{
  "socketName": "opencode-themed"
}
```

默认读取同目录的 `tmux.conf`。可选的 `tmuxConfig` 相对 `~/.config/opencode/` 解析，绝对路径直接使用。该文件必须可读，`socketName` 必须是专用的非默认名称。只用信任的配置：tmux 文件可以执行命令。没有 `opencode-mux.json` 就不会启用这项配置。配置入口固定在系统用户主目录，不受项目目录、`HOME` 或 `XDG_CONFIG_HOME` 影响，也不运行 Byobu 启动器。OpenCode 与扩展服务在同一主机、同一用户、同一状态目录下共用这份设置；项目 `options.socketName` 不会覆盖其中的 socket。

启用后重新启动 OpenCode 和扩展服务以读取设置。旧 socket 的任务不会迁移或关闭。tmux 只在指定 socket 的服务启动时加载配置，Mux 不会重载现有服务。自定义配置默认保留其状态栏和按键；要保留 F6 脱离，添加 `bind-key -n F6 detach-client`。

## HTTP API

这是扩展 `service` 暴露给**宿主/面板**的本地接口，不是无需鉴权的公共远程 API。宿主注入端口和 token，并由面板通过宿主请求接口发送 `Authorization: Bearer <token>`；**不要把 token 写进文档、仓库或浏览器前端代码**。服务监听 `127.0.0.1`，所有路由（包括健康检查）都要求 token；JSON 请求体最大 64 KiB，成功返回 HTTP 200 JSON，常见错误返回 `{"error":"..."}`（401 未授权、400 参数错误、404 未找到、503 缺少复用器）。`cwd` 在创建/操作入口应使用实际项目绝对路径。

`TaskView` = 保存的任务字段（`id/name/role/cwd/command/status/exitCode?/muxKind/muxSession/paneId/restartCount/...`）加 `attachCommand`；`status` 可为 `running/succeeded/failed/stopped/gone`。下表的 `?` 表示可选，未标者为必填。

| 方法与路径 | 请求体 / 查询参数 | 成功响应（JSON） |
| --- | --- | --- |
| `GET /health` | 无 | `{"ok":true,"backend":{...}}`；未找到后端时 `backend:null`。 |
| `GET /tasks` | 查询 `cwd?`、`role?=build\|service`、`status?=running\|succeeded\|failed\|stopped\|gone` | `{"tasks":[TaskView,...],"backend":{...}\|null}`；无后端时任务列表为空。 |
| `POST /builds` | `{"name":"检查","command":"bun run typecheck","cwd":"/path/to/project","wait":false,"timeoutMs":15000,"tailLines":80}`；后三项可选，`wait` 默认 `false`；等待时 `timeoutMs` 最多 15000 ms（省略亦为 15000）。 | `{"ok":true,"task":TaskView,"tail":"...","timedOut":false}`；`wait:false` 的 `ok` 仅表示启动成功。 |
| `POST /services` | `{"action":"start","name":"开发服务","cwd":"/path/to/project","command":"npm run dev"}`；`action` 可为 `start/restart/stop/status/remove`；`command?`（新服务必填）、`restartIfRunning?`、`force?`、`timeoutMs?`。 | `{"ok":true,"task":TaskView,"timedOut":false}`；找不到时 `task` 可缺省、`ok:false`。 |
| `POST /history/preview` | `{"cwd":"/path/to/project","includeShell":false,"retentionDays":7}`；后两项可选。 | `{"tasks":[ManagedTask,...]}`；不移除任务。 |
| `POST /history/clean` | 沿用预览参数，增加 `candidates` 数组，逐项传回预览记录的 `id`、`updatedAt` 和 `restartCount`。 | `{"removed":["id"],"skipped":["id"],"failed":[{"id":"...","message":"..."}]}`。 |
| `POST /prune` | `{"cwd":"/path/to/project","role":"build"}`；两项均可选，`role` 为 `build/service`。 | `{"pruned":[ManagedTask,...]}`；清理范围内已失去 pane 的记录。 |
| `DELETE /tasks/:id` | 无 | `{"ok":true,"task":TaskView}`；删除指定任务 pane 和记录。 |
| `POST /tasks/:id/restart` | `{"command":"新的命令"}`；`command?`，省略沿用旧命令。 | `{"ok":true,"task":TaskView}`，可带 `timedOut`。 |
| `POST /tasks/:id/stop` | `{"force":false,"timeoutMs":2000}`；均可选；`force:true` 在停止超时后强制关闭 pane。 | `{"ok":true,"task":TaskView,"timedOut":false}`；超时未强停可返回 `ok:false,timedOut:true`。 |
| `POST /tasks/:id/input` | `{"input":"rs","enter":true}`；`input` 必填但可为空，`enter?` 默认发送回车。 | `{"ok":true}`；非运行中的任务可能返回 409，不存在/无 pane 返回 404。 |
| `GET /tasks/:id/logs` | 查询 `lines?`（默认 120，非负整数） | `{"id":"...","status":"succeeded","exitCode":0,"tail":"...","attachCommand":"..."}`；没有退出码时 `exitCode` 可缺省，无可读 pane 返回 404。 |
| `POST /session/close` | `{"cwd":"/path/to/project"}`（必填） | `{"ok":true,"removed":2,"sessionName":"oc-project-..."}`；关闭整个项目复用器会话、删除记录并使已附加终端脱离。 |

如果需要用终端在**本机且已通过宿主安全获得凭据**的环境调试（不要把实际 token 粘贴给 AI），以下命令可复制执行；日常操作优先使用面板与工具：

```sh
curl -fsS -H "Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN" \
  "http://127.0.0.1:$OPENCHAMBER_SERVICE_PORT/health"
```

这两个环境变量是宿主给服务进程的，并不保证在普通用户 shell 中存在；不存在时请通过宿主界面操作，不要猜测凭据。

## 故障排查 FAQ

| 现象 / 问题 | 原因与处理 |
| --- | --- |
| `Duplicate plugin ID: opencode-mux` | 扩展贡献的插件、手动注册的扩展目录和独立 `@misakacloud/opencode-mux` 包中有两份在同一实例加载。检查全局及项目 `plugins` 和宿主自动注入情况；只留**同一个扩展插件目录的一条来源**，或独立包单独使用，重启 OpenCode。 |
| `delivery: "file"` 时还要写 managed 吗？ | 不需要。用扩展已有的文件路径作为单一来源；手工再加 managed 项可能造成重复加载。 |
| 面板显示找不到复用器 | 在 **OpenChamber 服务端**检查 `tmux`/`psmux` 是否安装并处于服务进程 `PATH`；OpenCode CLI 也要分别能找到它。缺失时扩展面板仍可打开，但无法运行任务。 |
| CLI 有任务、面板没有，或 attach 找不到会话 | 核对两端的主机、用户、状态目录、后端和 socket；`options.stateDir/socketName` 只作用于 OpenCode 插件，不会自动同步至扩展服务。非默认 socket 用返回的 `attachCommand`。 |
| 构建工具超时是否终止任务？ | 不会；继续用 `mux_list` / `mux_logs` 或复制 `attachCommand` 检查。HTTP 构建如果 `wait:true` 最多等待 15 秒；OpenCode 工具默认最多等 120 秒。 |
| 为什么命令结束后 pane 还活着、状态却已经是完成/失败？ | POSIX tmux 默认驻留 shell；`shell:true` 标识该状态，`exit/` 哨兵记录**原命令**退出码，避免把驻留 shell 误认作原任务仍在运行。要保留现场按 F6；退出 shell 用 Ctrl+D/`exit`。禁用 `keepShellOnExit` 可关闭驻留和这套哨兵。 |
| pane 已死或被外部关闭，记录还在？ | 协调检查会将找不到的 pane 标为 `gone`（显式强停可保留 `stopped`）；用 `mux_list({"pruneGone":true})` 或面板“清理历史”清除失效记录。不要手工编辑 `tasks/` 与 `exit/`：重启、删除、清理会处理对应哨兵，哨兵按任务 ID、pane 和 PID 区分运行代次。 |
| 退出码与状态如何映射？ | 取得原命令退出码时：`0 → succeeded`，`≥128 → stopped`，其他非零值 `→ failed`。无哨兵时根据 pane 存活、pane 退出码与停止请求判断；无 pane 为 `gone`，不能把所有非零退出都当作失败。 |
