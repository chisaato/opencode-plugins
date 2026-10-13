import { Plugin } from "@opencode/plugin"
import { loadConfig } from "../config/loader"
import { applyFilter, type SkillEditorLike } from "../filter/apply"
import { hasWork } from "../matching/rules"
import { createLogger } from "../utils/logger"

/**
 * OpenCode V2 插件：按规则把多余/冲突的 skill 设为 `autoinvoke = false`，
 * 使其不出现在模型的 available_skills 列表中，但仍可通过 `@name` 主动调用。
 */
export const SkillFilterPlugin = Plugin.define({
  id: "opencode-skill-filter",
  async setup(ctx) {
    const projectDirectory = ctx.location?.directory
    const inline = ctx.options as Record<string, unknown> | undefined

    const { rules, debug, sources } = await loadConfig({ projectDirectory, inline })
    const logger = createLogger(debug)

    if (sources.length > 0) {
      logger.debug(`config sources: ${sources.join(", ")}`)
    }

    if (!hasWork(rules)) {
      logger.debug("no hide rules configured; skill filter is inactive")
      return
    }

    logger.debug(
      `active with hide=[${rules.hide.join(", ")}] unhide=[${rules.unhide.join(", ")}] ` +
        `include=[${rules.include.join(", ")}] exclude=[${rules.exclude.join(", ")}] ` +
        `restoreUnhidden=${rules.restoreUnhidden}`,
    )

    // 注册 V2 skill transform：宿主在组装 available_skills 之前调用回调，
    // 我们在其中同步改写 autoinvoke。
    await ctx.skill.transform((editor) => {
      const result = applyFilter(editor as unknown as SkillEditorLike, rules, logger)
      logger.debug(
        `examined ${result.examined} skill(s); hidden ${result.hidden.length}, restored ${result.shown.length}`,
      )
    })
  },
})

export default SkillFilterPlugin
