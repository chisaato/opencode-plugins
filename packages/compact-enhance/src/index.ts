import { Plugin } from "@opencode/plugin"

export const CompactEnhancePlugin = Plugin.define({
  id: "opencode-compact-enhance",
  async setup(ctx) {
    const instructions = new Map<string, string>()

    await ctx.command.transform((editor) => {
      editor.add({
        name: "compact-enhance",
        description: "带指令压缩上下文：本次输入作为一次性摘要偏向指令，不进入聊天记录",
        async execute(input) {
          const instruction = input.prompt.text?.trim()
          if (instruction) instructions.set(input.sessionID, instruction)
          await ctx.session.compact({ sessionID: input.sessionID })
        },
      })
    })

    await ctx.session.hook("compaction", async (event) => {
      const hint = instructions.get(event.sessionID)
      if (hint === undefined) return

      // 只让本次摘要请求使用该指令，不写入会话历史。
      instructions.delete(event.sessionID)
      if (!hint) return

      event.messages.push({
        role: "user",
        content: [{
          type: "text",
          text: [
            "The user explicitly requests the following for this compaction only.",
            "Follow this instruction when deciding what to retain: include more detail where requested, and condense or omit details where requested.",
            "If it conflicts with the default summary brevity or level-of-detail rules, prioritize this instruction while keeping the requested summary format.",
            "Apply the instruction to the summary itself; do not quote it or carry it forward as a task.",
            "",
            hint,
          ].join("\n"),
        }],
      })
    })
  },
})

export default CompactEnhancePlugin
