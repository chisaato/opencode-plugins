import { Plugin } from "@opencode/plugin"
import { loadConfig } from "../config/loader"
import { applyFilter, type MutableSkill, type SkillEditorLike } from "../filter/apply"
import { hasWork } from "../matching/rules"
import { syncPolicies } from "../policy/sync"
import {
  createSkillsListTool,
  SKILLS_LIST_TOOL_NAME,
  type PoliciesSummary,
  type RemovedSkillEntry,
} from "../tool/skills-list"
import { createLogger } from "../utils/logger"

/**
 * OpenCode V2 插件：按规则对 skill 做双层治理。
 *
 * 运行时（动态防护）：
 * - `remove` 硬剔除：`editor.remove(id)`，从运行时注册表彻底拔除，可随时无损复原。
 * - `hide`   软隐藏：`autoinvoke = false`，从 available_skills 摘除但保留 `@name` 手动调用。
 * - `enable` 显式激活：保证不被 remove / hide，且 `autoinvoke = true`。
 *
 * 内核级（静态加固）：
 * - `syncPolicy`（默认开）把 `remove` 规则写入 `experimental.policies`，使内核
 *   末端的 `ConfigPolicyPlugin` 在下一次启动时直接拔除命中的技能，从根上对抗
 *   兼容层插件重载时再次注入。
 *
 * 同时（默认）注册 `skills_list` 工具，便于运行时查看 skill 的过滤/隐藏/移除状态。
 */
export const SkillFilterPlugin = Plugin.define({
  id: "opencode-skill-filter",
  async setup(ctx) {
    const projectDirectory = ctx.location?.directory ?? process.cwd()
    const inline = ctx.options as Record<string, unknown> | undefined

    const { rules, debug, exposeTool, syncPolicy, syncPolicyPath, sources } = await loadConfig({
      projectDirectory,
      inline,
    })
    const logger = createLogger(debug)

    if (sources.length > 0) {
      logger.debug(`config sources: ${sources.join(", ")}`)
    }

    // 记录被硬剔除的 skill：它们从 ctx.skill.list() 中消失，需单独保留给 skills_list。
    const removedSkills = new Map<string, RemovedSkillEntry>()
    let policyInfo: PoliciesSummary | undefined

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
            getPolicies: () => policyInfo,
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

    // 内核级加固：把 remove 规则同步为 deny policy，供下一次启动的内核直接剔除。
    if (syncPolicy && rules.remove.length > 0) {
      policyInfo = await syncPolicySafely({
        projectDirectory,
        patterns: rules.remove,
        targetPath: syncPolicyPath,
        logger,
      })
    }

    // 运行时防护：注册 V2 skill transform。宿主每次组装 skill 注册表都会调用回调，
    // 因而回调可能被多次触发；applyFilter 每次都基于当前 list() 重新判定，天然幂等，
    // 兼容层在重载时重新注入的技能也会被再次剔除。
    await ctx.skill.transform((editor) => {
      const result = applyFilter(editor as unknown as SkillEditorLike, rules, logger, {
        onRemove: (skill, label) => {
          recordRemoved(removedSkills, skill, label)
        },
      })
      logger.debug(
        `examined ${result.examined} skill(s); removed ${result.removed.length}, ` +
          `hidden ${result.hidden.length}, activated ${result.shown.length}`,
      )
    })
  },
})

/** 调用 syncPolicies，并把失败收敛为一条诊断信息（绝不影响插件启动）。 */
async function syncPolicySafely(options: {
  projectDirectory: string
  patterns: string[]
  targetPath?: string
  logger: ReturnType<typeof createLogger>
}): Promise<PoliciesSummary> {
  const { patterns, targetPath, logger } = options
  try {
    const result = await syncPolicies({
      projectDirectory: options.projectDirectory,
      patterns,
      ...(targetPath !== undefined ? { targetPath } : {}),
      logger,
    })
    if (result.written) {
      logger.debug(
        `kernel policy synced (${result.patterns.length} rule(s)) -> ${result.path}`,
      )
    } else if (result.reason) {
      logger.debug(`kernel policy not written: ${result.reason}`)
    }
    return {
      patterns: result.patterns,
      synced: result.synced,
      written: result.written,
      ...(result.path !== undefined ? { path: result.path } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`kernel policy sync failed: ${reason}`)
    return { patterns, synced: false, written: false, reason }
  }
}

/** 记录被硬剔除的 skill，按 id/name 去重（多次 transform 调用不会重复计数）。 */
function recordRemoved(
  store: Map<string, RemovedSkillEntry>,
  skill: MutableSkill,
  label: string,
): void {
  const id = typeof skill.id === "string" && skill.id !== "" ? skill.id : undefined
  const name = typeof skill.name === "string" && skill.name !== "" ? skill.name : label
  const key = id ?? name
  if (store.has(key)) {
    return
  }
  store.set(key, {
    name,
    ...(id !== undefined ? { id } : {}),
    ...(typeof skill.description === "string" && skill.description !== ""
      ? { description: skill.description }
      : {}),
  })
}

export default SkillFilterPlugin
