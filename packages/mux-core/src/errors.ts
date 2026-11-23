export type MuxErrorCode =
  | "BACKEND_UNAVAILABLE"
  | "COMMAND_REQUIRED"
  | "TASK_NO_LIVE_PANE"
  // 预留给状态锁；目前不会抛出此错误。
  | "STATE_BUSY"

export class MuxError extends Error {
  constructor(readonly code: MuxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "MuxError"
  }
}
