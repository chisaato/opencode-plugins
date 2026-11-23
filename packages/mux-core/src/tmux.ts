import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { muxCommandArgs, stripAnsi, supportsPosixMuxFeatures, wrapShellCommand } from "./backend"
import type { CommandOptions, CommandResult, CommandRunner, LivePaneInfo, ManagedPaneOptions, MuxBackend, StatusTheme } from "./types"

const OPTIONS = {
  managed: "@opencode_mux_managed",
  id: "@opencode_mux_id",
  role: "@opencode_mux_role",
  name: "@opencode_mux_name",
  session: "@opencode_mux_session",
  dir: "@opencode_mux_dir",
  cmd: "@opencode_mux_cmd",
}
// 使用独立的数组项，不覆盖此 pane 上已有的其他 hook。
const cleanupHookName = "pane-died[100]"
// pane-died 提供目标 pane 上下文；kill-pane 的 -t 不展开格式，直接继承该目标。
const cleanupHook = 'if-shell -F "#{pane_dead}" "kill-pane"'
const byobuTable = "mux-byobu"
// 使用数字下标，兼容 tmux 3.4 等不支持具名 hook 下标的版本。
const themeHook = "after-new-window[100]"
const mouseKey = /^(?:[CMS]-)*(?:Mouse|Wheel|DoubleClick|TripleClick)\S*$/
const keyBinding = /^(bind-key\s+(?:-r\s+)?-T\s+)(\S+)(\s+(\S+)\s+\S.*)$/

function mouseBindings(stdout: string, table: string): string[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = keyBinding.exec(line)
    return match && match[2] === table && mouseKey.test(match[4]) ? [`${match[1]}${byobuTable}${match[3]}`] : []
  })
}

const fallbackMouseBindings = [
  ["MouseDown1Status", "switch-client -t ="],
  ["WheelUpStatus", "previous-window"],
  ["WheelDownStatus", "next-window"],
  ["MouseDown1Pane", "select-pane -t = ; send-keys -M"],
  ["WheelUpPane", 'if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -e }'],
  ["WheelDownPane", 'if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M"'],
  ["MouseDrag1Pane", 'if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -M }'],
  ["MouseDrag1Border", "resize-pane -M"],
]

function sessionThemeOptions(ascii: boolean): [string, string][] {
  return [
    ["status", "on"],
    ["status-position", "bottom"],
    ["status-interval", "1"],
    ["status-justify", "left"],
    ["status-style", "bg=#333333,fg=#eeeeee"],
    ["status-left-style", "default"],
    ["status-left-length", "16"],
    ["status-left", ascii ? "#[bg=#5faf5f,fg=#1c1c1c,bold] mux #[default] "
      : "#[bg=#5faf5f,fg=#1c1c1c,bold] mux #[bg=#333333,fg=#5faf5f,nobold]#[default] "],
    ["status-right-style", "default"],
    ["status-right-length", "96"],
    ["status-right", ascii ? "#S + %Y-%m-%d + %H:%M:%S"
      : "#[bg=#333333,fg=#4e4e4e]#[bg=#4e4e4e,fg=#eeeeee] #S #[bg=#4e4e4e,fg=#1c1c1c]#[bg=#1c1c1c,fg=#b8b8b8] %Y-%m-%d #[fg=#eeeeee,bold]%H:%M:%S #[default]"],
    ["mouse", "on"],
    ["renumber-windows", "on"],
    ["visual-activity", "off"],
    ["message-style", "bg=#75507b,fg=#eeeeee,bold"],
    ["message-command-style", "bg=#333333,fg=#87d75f,bold"],
  ]
}

function windowThemeOptions(ascii: boolean): [string, string][] {
  const compact = " #I:#W#{?window_flags,#{window_flags},} "
  return [
    ["window-status-style", "bg=#333333,fg=#b8b8b8"],
    ["window-status-current-style", "bg=#eeeeee,fg=#1c1c1c,bold"],
    ["window-status-activity-style", "bg=#333333,fg=#87d75f,bold"],
    ["window-status-bell-style", "bg=#dd4814,fg=#eeeeee,bold"],
    ["window-status-separator", " "],
    ["window-status-format", ascii ? compact : " #I  #W#{?window_flags,#{window_flags},} "],
    ["window-status-current-format", ascii ? compact
      : "#[bg=#eeeeee,fg=#333333,nobold]#[fg=#1c1c1c,bold] #I  #W#{?window_flags,#{window_flags},} #[bg=#333333,fg=#eeeeee,nobold]"],
    ["pane-border-style", "fg=#4e4e4e"],
    ["pane-active-border-style", "fg=#5faf5f"],
    ["mode-style", "bg=#75507b,fg=#eeeeee"],
    ["monitor-activity", "on"],
  ]
}

const commandList = (commands: string[][]) => commands.flatMap((command, index) => index ? [";", ...command] : command)
const separator = "\x1f"
const paneFormat = [
  "session_name", "window_index", "window_name", "pane_id", "pane_pid", "pane_current_path",
  "pane_current_command", "pane_dead", "pane_dead_status", "pane_dead_signal",
  ...Object.values(OPTIONS), "pane_title",
].map((field) => `#{${field}}`).join(separator)

function numberField(value: string): number | undefined {
  return /^-?\d+$/.test(value) ? Number(value) : undefined
}

// 常见值保持原样；对格式分隔字符和 tmux 命令分隔符做可逆编码。
const encodedPrefix = "opencode-b64:"
function encodeField(value: string): string {
  return /[\r\n\x1f]|;$/.test(value) || value.startsWith(encodedPrefix)
    ? encodedPrefix + Buffer.from(value).toString("base64")
    : value
}

function decodeField(value: string): string | undefined {
  return value.startsWith(encodedPrefix)
    ? Buffer.from(value.slice(encodedPrefix.length), "base64").toString()
    : value || undefined
}

export function parsePanes(stdout: string): LivePaneInfo[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const fields = line.split(separator)
    if (fields.length < 18 || !/^%\d+$/.test(fields[3])) return []
    const [sessionName, index, windowName, paneId, pid, paneCurrentPath, paneCurrentCommand,
      dead, status, signal, managed, taskId, role, name, sessionId, cwd, command, ...title] = fields
    const signum = numberField(signal)
    return [{
      sessionName, windowIndex: Number(index), windowName, paneId, panePid: numberField(pid),
      paneCurrentPath, paneCurrentCommand, paneDead: dead === "1",
      exitCode: dead === "1" ? (numberField(status) ?? (signum ? 128 + signum : undefined)) : undefined,
      paneTitle: title.join(separator), managed: managed === "1", taskId: decodeField(taskId),
      role: role === "build" || role === "service" ? role : undefined,
      taskName: decodeField(name), sessionId: decodeField(sessionId),
      cwd: decodeField(cwd), command: decodeField(command),
    }]
  })
}

function noServer(result: CommandResult): boolean {
  return result.exitCode === 1
    && /no server running|no sessions|error connecting to .+ \(No such file or directory\)/i.test(result.stderr)
}

export class MuxCommandError extends Error {
  constructor(readonly subcommand: string, readonly result: CommandResult) {
    super(`${subcommand} failed (${result.exitCode ?? result.signal ?? "no exit code"}): ${result.stderr.trim()}`)
    this.name = "MuxCommandError"
  }

  get isMissingPane(): boolean {
    return (this.subcommand === "capture-pane" || this.subcommand === "send-keys")
      && /can't find pane|no such pane|pane not found|no server running|no sessions|no such file or directory/i.test(this.result.stderr)
  }
}

export interface RespawnPaneOptions {
  cwd: string
  command: string
  channel?: string
  /** 提供管理元数据时同步更新 pane options，以便重新发现。 */
  metadata?: ManagedPaneOptions
}

interface MuxClientOptions {
  byobuKeys?: boolean
  prepareExitFile?: (paneId: string, id: string) => Promise<string>
  statusTheme?: StatusTheme
}

export function createMuxClient(backend: MuxBackend, runner: CommandRunner, options: MuxClientOptions = {}) {
  const run = (args: readonly string[], options?: CommandOptions) =>
    runner(backend.executable ?? backend.kind, muxCommandArgs(backend, args), options)
  const checked = async (args: readonly string[], options?: CommandOptions) => {
    const result = await run(args, options)
    if (result.exitCode !== 0) throw new MuxCommandError(args[0], result)
    return result
  }

  async function listPanes(): Promise<LivePaneInfo[]> {
    const result = await run(["list-panes", "-a", "-F", paneFormat])
    if (noServer(result)) return []
    if (result.exitCode !== 0) throw new MuxCommandError("list-panes", result)
    return parsePanes(result.stdout)
  }

  async function setMetadata(paneId: string, task: ManagedPaneOptions): Promise<void> {
    const entries = [
      [OPTIONS.id, task.id], [OPTIONS.role, task.role], [OPTIONS.name, task.name],
      [OPTIONS.session, task.sessionId ?? ""], [OPTIONS.dir, task.cwd], [OPTIONS.cmd, task.command],
      [OPTIONS.managed, "1"],
    ]
    const commands = entries.map(([key, value]) => ["set-option", "-p", "-t", paneId, key, encodeField(value)])
    if (backend.kind === "psmux") {
      for (const command of commands) await checked(command)
    } else {
      await checked(commands.flatMap((command, index) => index ? [";", ...command] : command))
    }
  }

  async function respawnPane(paneId: string, { cwd, command, channel, metadata }: RespawnPaneOptions, taskId = metadata?.id): Promise<void> {
    const exitFilePrefix = taskId && await options.prepareExitFile?.(paneId, taskId)
    if (supportsPosixMuxFeatures(backend)) {
      // tmux 3.8 对 pane-died 推断窗口作用域；显式定位到 pane，覆盖会话中的每个驻留 pane。
      if (exitFilePrefix) await checked(["set-hook", "-p", "-t", paneId, cleanupHookName, cleanupHook])
      // 以关闭驻留的配置重启已有任务时，撤掉之前为这个 pane 设置的清理 hook。
      else if (metadata) await checked(["set-hook", "-p", "-u", "-t", paneId, cleanupHookName])
    }
    await checked(["respawn-pane", "-k", "-t", paneId, "-c", cwd, ...wrapShellCommand(backend, command, channel, exitFilePrefix)])
    if (metadata) await setMetadata(paneId, metadata)
  }

  async function transplantMouseBindings(): Promise<void> {
    const existing = await run(["list-keys", "-T", byobuTable])
    if (existing.exitCode === 0 && mouseBindings(existing.stdout, byobuTable).length) return

    const root = await run(["list-keys", "-T", "root"])
    const bindings = root.exitCode === 0 ? mouseBindings(root.stdout, "root") : []
    if (bindings.length) {
      const dir = await mkdtemp(join(tmpdir(), "opencode-mux-keys-"))
      try {
        // 只替换键表名，用 tmux 自己的解析器保留命令、引号和转义分隔符。
        const path = join(dir, "mouse.conf")
        await writeFile(path, `${bindings.join("\n")}\n`, { mode: 0o600 })
        if ((await run(["source-file", path])).exitCode === 0) return
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    await checked(commandList(fallbackMouseBindings.map(([key, command]) => ["bind-key", "-T", byobuTable, key, command])))
  }

  async function enableByobuKeys(session: string): Promise<void> {
    const bindings = [
      ["F2", "new-window", "-c", "#{pane_current_path}"],
      ["F3", "previous-window"], ["F4", "next-window"], ["F6", "detach-client"], ["F7", "copy-mode"],
      ["F8", "command-prompt", "-I", "#W", "-p", "rename-window ", 'rename-window "%%"'],
      ["M-Left", "previous-window"], ["M-Right", "next-window"],
    ]
    await transplantMouseBindings()
    await checked(commandList([
      ...bindings.map((binding) => ["bind-key", "-T", byobuTable, ...binding]),
      ["set-option", "-t", session, "key-table", byobuTable],
    ]))
  }

  async function applySessionTheme(sessionName: string, paneId: string, variant: StatusTheme): Promise<void> {
    if (variant === "off") return
    const ascii = variant === "ascii" || !supportsPosixMuxFeatures(backend)
    const windowOptions = windowThemeOptions(ascii)
    const hook = windowOptions.map(([key, value]) => `set-option -w ${key} ${JSON.stringify(value)}`).join("; ")
    const commands = [
      ...sessionThemeOptions(ascii).map(([key, value]) => ["set-option", "-t", sessionName, key, value]),
      ["set-hook", "-t", sessionName, themeHook, hook],
      ...windowOptions.map(([key, value]) => ["set-option", "-w", "-t", paneId, key, value]),
    ]
    if (backend.kind === "psmux") {
      // psmux 对 tmux 选项和具名 hook 的覆盖因版本而异，且不支持批量执行。
      for (const command of commands) {
        const result = await run(command)
        if (result.exitCode !== 0 && !/unknown|unsupported|not (?:yet )?(?:supported|implemented)|invalid (?:option|style|hook|index|value)/i.test(result.stderr)) {
          throw new MuxCommandError(command[0], result)
        }
      }
    } else {
      await checked(commandList(commands))
    }
  }

  async function killPane(paneId: string): Promise<void> {
    const result = await run(["kill-pane", "-t", paneId])
    if (result.exitCode !== 0 && !noServer(result) && !/can't find pane|no such pane|pane not found/i.test(result.stderr)) {
      throw new MuxCommandError("kill-pane", result)
    }
  }

  async function killSession(sessionName: string): Promise<void> {
    // 要求精确匹配，避免目标不存在时误关名称相近的会话。
    const result = await run(["kill-session", "-t", `=${sessionName}`])
    if (result.exitCode !== 0 && !noServer(result) && !/can't find session|no such session|session not found/i.test(result.stderr)) {
      throw new MuxCommandError("kill-session", result)
    }
  }

  async function createManagedPane(task: ManagedPaneOptions): Promise<string> {
    const placeholder = wrapShellCommand(backend, backend.kind === "psmux" || (backend.platform ?? process.platform) === "win32"
      ? "ping -t 127.0.0.1 >nul" : "exec sleep 86400")
    const common = ["-c", task.cwd, "-P", "-F", "#{pane_id}", ...placeholder]
    const first = await run(["new-session", "-d", "-s", task.muxSession, ...common])
    let result = first
    if (first.exitCode !== 0) {
      if (!/duplicate session|session already exists/i.test(first.stderr)) throw new MuxCommandError("new-session", first)
      result = await checked(["new-window", "-d", "-t", `${task.muxSession}:`, ...common])
    }
    const paneId = result.stdout.trim()
    if (!/^%\d+$/.test(paneId)) throw new Error(`Invalid pane id from mux: ${paneId}`)
    try {
      const remain = ["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]
      if (backend.kind === "tmux") {
        remain.push(";", "set-option", "-p", "-t", paneId, "remain-on-exit-format", "")
      }
      await checked(remain)
      await setMetadata(paneId, task)
      await applySessionTheme(task.muxSession, paneId, options.statusTheme ?? "powerline")
      if (options.byobuKeys && supportsPosixMuxFeatures(backend)) await enableByobuKeys(task.muxSession)
      await respawnPane(paneId, task, task.id)
    } catch (error) {
      await killPane(paneId).catch(() => {})
      throw error
    }
    return paneId
  }

  async function sendInterrupt(paneId: string): Promise<void> {
    await checked(["send-keys", "-t", paneId, "C-c"])
  }

  async function sendKeys(paneId: string, text: string, enter = false): Promise<void> {
    if (text) await checked(["send-keys", "-t", paneId, "-l", "--", text.endsWith(";") ? text.slice(0, -1) + "\\;" : text])
    if (enter) await checked(["send-keys", "-t", paneId, "Enter"])
  }

  async function capturePane(paneId: string, lines?: number): Promise<string> {
    if (lines !== undefined && (!Number.isSafeInteger(lines) || lines < 0)) {
      throw new RangeError("lines must be a non-negative integer")
    }
    if (lines === 0) return ""
    const args = ["capture-pane", "-p", "-t", paneId]
    if (lines !== undefined) args.push("-S", `-${lines}`)
    const result = await checked(args)
    const output = stripAnsi(result.stdout).replaceAll("\r\n", "\n").replace(/(?:\n[ \t]*)+$/, "")
    return lines === undefined ? output : output.split("\n").slice(-lines).join("\n")
  }

  /** 返回是否收到通知；超时和取消会终止阻塞的 mux 客户端。 */
  async function waitForChannel(channel: string, { timeoutMs, signal }: CommandOptions = {}): Promise<boolean> {
    if (signal?.aborted || (timeoutMs !== undefined && timeoutMs <= 0)) return false
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    const timer = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs)
    try {
      return (await run(["wait-for", channel], { signal: controller.signal, timeoutMs })).exitCode === 0
    } catch (error) {
      if (controller.signal.aborted) return false
      throw error
    } finally {
      signal?.removeEventListener("abort", abort)
      clearTimeout(timer)
    }
  }

  return { listPanes, createManagedPane, respawnPane, sendInterrupt, sendKeys, capturePane, killPane, killSession, waitForChannel }
}

export type MuxClient = ReturnType<typeof createMuxClient>
