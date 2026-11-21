/** 可注入的日志输出目标。 */
export interface LogSink {
  debug(message?: unknown, ...args: unknown[]): void
  info(message?: unknown, ...args: unknown[]): void
  warn(message?: unknown, ...args: unknown[]): void
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
}

/** 警告始终可见；仅调试信息受 debug 控制。 */
export function createLogger(debug: boolean, sink: LogSink = console): Logger {
  return {
    debug(message, ...args) {
      if (debug) sink.debug(`[model-prompts] ${message}`, ...args)
    },
    info(message, ...args) {
      if (debug) sink.info(`[model-prompts] ${message}`, ...args)
    },
    warn(message, ...args) {
      sink.warn(`[model-prompts] ${message}`, ...args)
    },
  }
}
