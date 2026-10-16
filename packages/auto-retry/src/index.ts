import { Plugin } from "@opencode/plugin"
import { loadConfig } from "./config/loader"
import { createHandler, type ObservedEvent, type TranscriptMessage } from "./handler"
import { createLogger } from "./utils/logger"

/**
 * 命中规则时，向失败的会话发送一条可见的续写消息。
 *
 * 内容拦截不走 session.hook("retry")（内核把它标成不可重试），所以这里自己订阅事件。
 * prompt 不能指定模型，续写使用会话当前模型。
 */
const AutoRetryPlugin = Plugin.define({
  id: "opencode-auto-retry",
  async setup(ctx) {
    const logger = createLogger()
    const projectDir = ctx.location.directory
    const config = await loadConfig({ projectDir, logger })
    if (config.rules.length === 0) return

    const controller = new AbortController()
    // 事件里的 sessionID 运行时就是 Session.ID，这里只补上品牌类型。
    const asSessionID = (sessionID: string) => sessionID as Parameters<typeof ctx.session.get>[0]["sessionID"]
    const handler = createHandler({
      events: ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<ObservedEvent>,
      prompt: (input) =>
        ctx.session.prompt({
          sessionID: asSessionID(input.sessionID),
          text: input.text,
        }),
      getSession: (sessionID) => ctx.session.get({ sessionID: asSessionID(sessionID) }),
      listMessages: async (sessionID) => {
        const messages = await ctx.session.context({ sessionID: asSessionID(sessionID) })
        return messages as readonly TranscriptMessage[]
      },
      notify: (message) => {
        // promise 插件 Context 没有 toast。警告会进宿主日志，文案是给用户看的。
        logger.warn(message)
      },
      config,
      logger,
    })

    const task = handler.start().catch((error: unknown) => {
      if (isAbort(error)) return
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`事件订阅结束：${reason}`)
    })

    return async () => {
      controller.abort()
      await task
    }
  },
})

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export default AutoRetryPlugin
