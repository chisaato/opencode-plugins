import { Plugin } from "@opencode/plugin"
import { loadConfig } from "../config/loader"
import { applyFilter, type MutableSkill, type SkillEditorLike } from "../filter/apply"
import { hasWork } from "../matching/rules"
import {
  createSkillsListTool,
  SKILLS_LIST_TOOL_NAME,
  type RemovedSkillEntry,
} from "../tool/skills-list"
import { createLogger } from "../utils/logger"

/**
 * OpenCode V2 插件：按规则对 skill 做双层治理。
 *
 * - `remove` 硬剔除：`editor.remove(id)`，从运行时注册表彻底拔除，可随时无损复原。
 * - `hide`   软隐藏：`autoinvoke = false`，从 available_skills 摘除但保留 `@name` 手动调用。
 * - `enable` 显式激活：保证不被 remove / hide，且 `autoinvoke = true`。
 *
 * 同时（默认）注册 `skills_list` 工具，便于运行时查看 skill 的过滤/隐藏/移除状态。
 */
export const SkillFilterPlugin = Plugin.define({
  id: "opencode-skill-filter",
  async setup(ctx) {
    const projectDirectory = ctx.location?.directory ?? process.cwd()
    const inline = ctx.options as Record<string, unknown> | undefined

    const { rules, debug, exposeTool, sources } = await loadConfig({ projectDirectory, inline })
    console.log("[skill-filter] setup running for directory:", projectDirectory)
    console.log("[skill-filter] parsed rules:", JSON.stringify(rules))
    const logger = createLogger(debug)

    if (sources.length > 0) {
      logger.debug(`config sources: ${sources.join(", ")}`)
    }

    // 记录被硬剔除的 skill：它们从 ctx.skill.list() 中消失，需单独保留给 skills_list。
    const removedSkills = new Map<string, RemovedSkillEntry>()

    // 注册 skills_list 工具：独立于治理规则，即便没有规则也可用。
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
            getRemoved: () => Array.from(removedSkills.values()),
            logger,
          }),
        )
        logger.debug(`registered ${SKILLS_LIST_TOOL_NAME} tool`)
      })
    }

    if (!hasWork(rules)) {
      logger.debug("no remove/hide/enable rules configured; skill filter is inactive")
      return
    }

    logger.debug(
      `active with remove=[${rules.remove.join(", ")}] hide=[${rules.hide.join(", ")}] ` +
        `enable=[${rules.enable.join(", ")}] include=[${rules.include.join(", ")}] ` +
        `exclude=[${rules.exclude.join(", ")}]`,
    )

    // 注册 V2 skill transform：宿主在组装 available_skills 之前调用回调，
    // 我们在其中同步改写 autoinvoke 或移除 skill。
    await ctx.skill.transform((editor) => {
      console.log("[skill-filter] ctx.skill.transform invoked! editor:", typeof editor)
      const result = applyFilter(editor as unknown as SkillEditorLike, rules, logger, {
        onRemove: (skill, label) => {
          removedSkills.set(label, {
            name: typeof skill.name === "string" && skill.name !== "" ? skill.name : label,
            ...(typeof skill.id === "string" && skill.id !== "" ? { id: skill.id } : {}),
            ...(typeof skill.description === "string" && skill.description !== ""
              ? { description: skill.description }
              : {}),
          })
        },
      })
      logger.debug(
        `examined ${result.examined} skill(s); removed ${result.removed.length}, ` +
          `hidden ${result.hidden.length}, activated ${result.shown.length}`,
      )
    })
  },
})

export default SkillFilterPlugin
