export type MuxKind = "tmux" | "psmux"
export type TaskRole = "build" | "service"
export type StatusTheme = "powerline" | "ascii" | "off"
export type TaskStatus = "running" | "succeeded" | "failed" | "stopped" | "gone"
export type TriggerSource = "ai" | "human" | "openchamber"

export interface ManagedTask {
  id: string
  role: TaskRole
  name: string
  cwd: string
  command: string
  /** 调用方的 OpenCode 会话，与复用器会话相互独立。 */
  sessionId?: string
  source?: TriggerSource
  muxKind: MuxKind
  muxSession: string
  socketName?: string
  paneId: string
  panePid?: number
  status: TaskStatus
  exitCode?: number
  /** 任务已退出，pane 中仍保留交互式 shell。 */
  shell?: true
  restartCount: number
  createdAt: string
  updatedAt: string
  stopRequested?: boolean
  /** pane 已由显式强制停止操作销毁，不应当视为外部丢失。 */
  forceStopped?: boolean
}

export interface LivePaneInfo {
  sessionName: string
  windowIndex: number
  windowName: string
  paneId: string
  panePid?: number
  paneCurrentPath: string
  paneCurrentCommand: string
  paneDead: boolean
  exitCode?: number
  paneTitle: string
  managed: boolean
  taskId?: string
  role?: TaskRole
  taskName?: string
  sessionId?: string
  cwd?: string
  command?: string
}

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  signal?: NodeJS.Signals
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>

export interface MuxBackend {
  kind: MuxKind
  executable?: string
  socketName?: string
  platform?: NodeJS.Platform
}

export interface DetectMuxBackendOptions {
  runner?: CommandRunner
  platform?: NodeJS.Platform
  preferred?: MuxKind
  socketName?: string
}

export interface ManagedPaneOptions {
  id: string
  role: TaskRole
  name: string
  cwd: string
  command: string
  muxSession: string
  sessionId?: string
  channel?: string
}

export interface MuxManagerOptions extends DetectMuxBackendOptions {
  backend?: MuxBackend
  stateDir?: string
  pollIntervalMs?: number
  keepShellOnExit?: boolean
  byobuKeys?: boolean
  statusTheme?: StatusTheme
}

export interface TaskIdentity {
  name: string
  cwd: string
  sessionId?: string
  source?: TriggerSource
}

export interface RunBuildOptions extends TaskIdentity {
  command: string
  wait?: boolean
  timeoutMs?: number
  tailLines?: number
}

export interface RunBuildResult {
  /** 未等待时仅表示已成功启动；等待时表示命令以 0 退出。 */
  ok: boolean
  task: ManagedTask
  tail: string
  timedOut: boolean
}

export type ServiceAction = "start" | "restart" | "stop" | "status" | "remove"

export interface StopTaskOptions {
  force?: boolean
  timeoutMs?: number
}

export interface RestartTaskOptions {
  command?: string
  sessionId?: string
  source?: TriggerSource
}

export interface ServiceActionOptions extends TaskIdentity, StopTaskOptions {
  action: ServiceAction
  command?: string
  restartIfRunning?: boolean
}

export interface ServiceActionResult {
  ok: boolean
  task?: ManagedTask
  timedOut?: boolean
}

export interface TaskFilter {
  cwd?: string
  role?: TaskRole
  name?: string
  status?: TaskStatus
  sessionId?: string
}

export interface SendInputOptions {
  enter?: boolean
}
