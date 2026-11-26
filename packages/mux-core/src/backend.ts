import { spawn } from "node:child_process"
import { assertTmuxConfigTarget, validateTmuxBackendConfig } from "./config"
import type { CommandRunner, DetectMuxBackendOptions, MuxBackend } from "./types"

/** 执行复用器命令时不经过宿主 shell。 */
export function createCommandRunner(): CommandRunner {
  return (executable, args, { cwd, env, signal, timeoutMs } = {}) => new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, env, signal, timeout: timeoutMs, killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    let error: Error | undefined
    child.once("error", (cause) => { error = cause })
    child.once("close", (exitCode, exitSignal) => {
      if (error) reject(error)
      else resolve({ exitCode, stdout, stderr, signal: exitSignal ?? undefined })
    })
  })
}

export async function detectMuxBackend({
  runner = createCommandRunner(), platform = process.platform, preferred, socketName, tmuxConfig,
}: DetectMuxBackendOptions = {}): Promise<MuxBackend | null> {
  const fallback = platform === "win32" ? ["psmux", "tmux"] as const : ["tmux", "psmux"] as const
  const configured = tmuxConfig === undefined ? undefined : { kind: "tmux" as const, executable: "tmux", platform, socketName, tmuxConfig }
  if (configured) await validateTmuxBackendConfig(configured)
  const kinds = configured ? ["tmux"] as const
    : preferred ? [preferred, ...fallback.filter((kind) => kind !== preferred)] : fallback
  for (const kind of kinds) {
    try {
      if ((await runner(kind, ["-V"], { timeoutMs: 2_000 })).exitCode === 0) {
        return configured ?? { kind, executable: kind, platform, socketName }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "EACCES") throw error
    }
  }
  return null
}

export function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * 命令在非交互 shell 中执行完后，exec 交互 shell 供人工接管。
 * 通过临时 rc 文件在交互 shell 启动末尾把刚执行的命令注入其历史，
 * 这样在 pane 里按 Up 能调出 mux 执行过的命令。使用 shell 自身的历史
 * API（zsh 的 print -s / bash 的 history -s），避免直接改写 HISTFILE
 * 带来的格式、路径和 SHARE_HISTORY 覆盖问题。其他 shell 走原有 fallback。
 */
function interactiveShellWithHistory(command: string): string {
  const zshRcLines = [
    'unset ZDOTDIR',
    '[ -r "${HOME}/.zshrc" ] && source "${HOME}/.zshrc"',
    '__oc_mux_inject_history() {',
    '  precmd_functions=(${precmd_functions:#__oc_mux_inject_history})',
    '  unfunction __oc_mux_inject_history 2>/dev/null',
    '  if [ -n "${__OC_HIST_DIR:-}" ]; then rm -rf "$__OC_HIST_DIR"; unset __OC_HIST_DIR; fi',
    '  if [ -n "${__OC_HIST_CMD:-}" ]; then print -s -- "$__OC_HIST_CMD"; unset __OC_HIST_CMD; fi',
    '}',
    'precmd_functions+=(__oc_mux_inject_history)',
  ]
  const bashRcLines = [
    '[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc',
    '[ -r "${HOME}/.bashrc" ] && . "${HOME}/.bashrc"',
    '__oc_mux_inject_history() {',
    '  if [ -n "${__OC_HIST_CMD:-}" ]; then history -s -- "$__OC_HIST_CMD"; unset __OC_HIST_CMD; fi',
    '  if [ -n "${__OC_HIST_DIR:-}" ]; then rm -rf "$__OC_HIST_DIR"; unset __OC_HIST_DIR; fi',
    '  unset -f __oc_mux_inject_history',
    '}',
    'if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then',
    '  PROMPT_COMMAND+=(__oc_mux_inject_history)',
    'else',
    '  __OC_PC="${PROMPT_COMMAND:-}"',
    '  PROMPT_COMMAND="__oc_mux_inject_history${__OC_PC:+;$__OC_PC}"',
    'fi',
  ]
  const writeZshRc = `printf '%s\\n' ${zshRcLines.map(quotePosixShell).join(' ')} > "$__oc_tmp/.zshrc"`
  const writeBashRc = `printf '%s\\n' ${bashRcLines.map(quotePosixShell).join(' ')} > "$__oc_tmp/bashrc"`
  const tmpDir = '"${TMPDIR:-/tmp}/oc-mux-hist.XXXXXX"'
  return [
    `__oc_hist_cmd=${quotePosixShell(command)};`,
    '__oc_shell=${SHELL:-};',
    'case ${__oc_shell##*/} in',
    `zsh) if __oc_tmp=$(mktemp -d ${tmpDir}); then ${writeZshRc}; __OC_HIST_DIR="$__oc_tmp" __OC_HIST_CMD="$__oc_hist_cmd" ZDOTDIR="$__oc_tmp" exec "$__oc_shell" -i; fi ;;`,
    `bash) if __oc_tmp=$(mktemp -d ${tmpDir}); then ${writeBashRc}; __OC_HIST_DIR="$__oc_tmp" __OC_HIST_CMD="$__oc_hist_cmd" exec "$__oc_shell" --rcfile "$__oc_tmp/bashrc" -i; fi ;;`,
    'esac;',
    'if [ -n "$__oc_shell" ] && [ -x "$__oc_shell" ]; then exec "$__oc_shell" -i;',
    'elif [ -x /bin/bash ]; then exec /bin/bash -i; else exec /bin/sh -i; fi',
  ].join(' ')
}

export function muxCommandArgs(backend: MuxBackend, args: readonly string[]): string[] {
  const socket = backend.socketName ? ["-L", backend.socketName] : []
  // tmux 仅在启动 server 时处理 -f；不要给 attach 或其他命令传宿主配置。
  if (args[0] === "new-session" && backend.tmuxConfig !== undefined) {
    assertTmuxConfigTarget(backend)
    return [...socket, "-f", backend.tmuxConfig, ...args]
  }
  return [...socket, ...args]
}

function useCmd(backend: MuxBackend): boolean {
  return (backend.platform ?? process.platform) === "win32" || backend.kind === "psmux"
}

/** Windows/psmux 沿用原有的命令包装和按键设置。 */
export function supportsPosixMuxFeatures(backend: MuxBackend): boolean {
  return !useCmd(backend)
}

/** 引用 cmd.exe 中的单个参数。拒绝无法安全内联的字符串。 */
export function quoteCmdArg(value: string): string {
  if (/["%\r\n\0]/.test(value)) throw new Error("Unsupported character in cmd.exe argument")
  return `"${value.replace(/\\+$/, "$&$&")}"`
}

/** 构造 pane 的 argv，避免由 tmux 额外解释用户命令。 */
export function wrapShellCommand(backend: MuxBackend, command: string, channel?: string, exitFilePrefix?: string): string[] {
  // A trailing semicolon in an argv forwarded to tmux is a tmux command separator.
  const direct = command.endsWith(";") ? `${command}${useCmd(backend) ? " " : "\n"}` : command
  const executable = backend.executable ?? backend.kind
  if (exitFilePrefix && supportsPosixMuxFeatures(backend)) {
    const signal = channel
      ? `${[executable, ...muxCommandArgs(backend, ["wait-for", "-S", channel])].map(quotePosixShell).join(" ")} 2>/dev/null; `
      : ""
    return ["sh", "-lc",
      // 外层捕获 Ctrl+C，内层仍按原样执行用户命令并返回退出码。
      `trap ':' INT; sh -lc ${quotePosixShell(command)}; __rc=$?; `
      + `__oc_exit=${quotePosixShell(exitFilePrefix)}$$.txt; `
      + 'if __oc_tmp=$(mktemp "${__oc_exit}.XXXXXX"); then '
      + 'if ! { printf \'%s\\n\' "$__rc" > "$__oc_tmp" && mv -f "$__oc_tmp" "$__oc_exit"; }; then rm -f "$__oc_tmp"; fi; fi; '
      + signal
      + interactiveShellWithHistory(command)]
  }
  if (!channel) return useCmd(backend) ? ["cmd.exe", "/d", "/c", direct] : ["sh", "-lc", direct]
  const args = muxCommandArgs(backend, ["wait-for", "-S", channel])
  if (useCmd(backend)) {
    // Nested cmd would expand these characters before the original task sees them.
    // Run such scripts directly and let the manager discover the exit by polling.
    if (/["%!^\r\n]/.test(command) || [executable, ...args].some((arg) => /["%!\r\n\0]/.test(arg))) {
      return ["cmd.exe", "/d", "/c", direct]
    }
    const signal = [executable, ...args].map(quoteCmdArg).join(" ")
    // 内层 cmd 运行任务；外层在发送通知之前记录任务原始退出码。
    return ["cmd.exe", "/d", "/v:on", "/c",
      `cmd.exe /d /v:off /s /c "${command}" & set "__oc_rc=!errorlevel!" & ${signal} & exit /b !__oc_rc!`]
  }
  const signal = [executable, ...args].map(quotePosixShell).join(" ")
  return ["sh", "-lc", `sh -lc ${quotePosixShell(command)}; __rc=$?; ${signal}; exit "$__rc"`]
}

export function buildAttachCommand(backend: MuxBackend, sessionName: string): string {
  const executable = backend.executable ?? backend.kind
  const args = muxCommandArgs(backend, ["attach-session", "-t", `=${sessionName}`])
  if (useCmd(backend)) {
    // cmd strips the leading quote of a /c string unless the entire command is wrapped.
    return `cmd.exe /d /v:off /s /c "${[executable, ...args].map(quoteCmdArg).join(" ")}"`
  }
  return [executable, ...args].map(quotePosixShell).join(" ")
}

/** 移除 CSI、OSC 等常见终端转义序列。 */
export function stripAnsi(text: string): string {
  return text
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g, "")
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-_]/g, "")
}
