import { Plugin } from "@opencode/plugin"
import { loadConfig } from "../config/loader"
import { applyFilter, type MutableSkill, type SkillEditorLike } from "../filter/apply"
import { hasWork } from "../matching/rules"
import { createSkillsListTool, SKILLS_LIST_TOOL_NAME } from "../tool/skills-list"
import { createLogger } from "../utils/logger"

/**
 * OpenCode V2 插件：按规则把多余/冲突的 skill 设为 `autoinvoke = false`，
 * 使其不出现在模型的 available_skills 列表中，但仍可通过 `@name` 主动调用。
 *
 * 同时（默认）注册 `skills_list` 工具，便于运行时查看 skill 的过滤/隐藏状态。
 */
export const SkillFilterPlugin = Plugin.define({
  id: "opencode-skill-filter",
  async setup(ctx) {
    const projectDirectory = ctx.location?.directory
    const inline = ctx.options as Record<string, unknown> | undefined

    const { rules, debug, exposeTool, sources } = await loadConfig({ projectDirectory, inline })
    const logger = createLogger(debug)

    if (sources.length > 0) {
      logger.debug(`config sources: ${sources.join(", ")}`)
    }

    // 注册 skills_list 工具：独立于 hide 规则，即便没有过滤规则也可用。
    if (exposeTool) {
      await ctx.tool.transform((editor) => {
        const already = editor.list().some((tool) => tool.name === SKILLS_LIST_TOOL_NAME)
        if (already) {
          logger.debug(`${SKILLS_LIST_TOOL_NAME} tool already registered; skipping`)
          return
        }

        editor.add(
          createSkillsListTool({
            listSkills: async () => {
              const result = await ctx.skill.list()
              return (result?.data ?? []) as MutableSkill[]
            },
            logger,
          }),
        )
        logger.debug(`registered ${SKILLS_LIST_TOOL_NAME} tool`)
      })
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
