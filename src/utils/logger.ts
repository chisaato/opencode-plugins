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

const PREFIX = "[skill-filter]"

/** 什么都不做的日志器。 */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
}

/**
 * 创建带统一前缀的日志器。
 *
 * OpenCode V2 的 plugin Context 没有 `logger` 字段，因此默认落到 `console`，
 * 且修改行为统一走 `debug` 级别，避免污染用户正常输出。
 */
export function createLogger(enabled: boolean, sink: LogSink = console): Logger {
  if (!enabled) {
    return silentLogger
  }

  return {
    debug(message, ...args) {
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
