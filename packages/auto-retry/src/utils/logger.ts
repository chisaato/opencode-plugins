/** 可注入的日志输出目标（默认 console）。 */
export interface LogSink {
  debug(message?: unknown, ...optionalParams: unknown[]): void
  info(message?: unknown, ...optionalParams: unknown[]): void
  warn(message?: unknown, ...optionalParams: unknown[]): void
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

const PREFIX = "[auto-retry]"

/** 什么都不做的日志器。 */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
}

/**
 * 创建带统一前缀的日志器。
 *
 * 警告始终输出（非法配置、停止续写）。debug 默认关闭，避免刷屏。
 */
export function createLogger(debugEnabled = false, sink: LogSink = console): Logger {
  return {
    debug(message, ...args) {
      if (!debugEnabled) return
      sink.debug(`${PREFIX} ${message}`, ...args)
    },
    info(message, ...args) {
      sink.info(`${PREFIX} ${message}`, ...args)
    },
    warn(message, ...args) {
      sink.warn(`${PREFIX} ${message}`, ...args)
    },
  }
}
