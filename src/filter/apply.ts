import { decideAction, type SkillIdentity } from "../matching/rules"
import type { NormalizedRules } from "../types"
import { silentLogger, type Logger } from "../utils/logger"

/** 插件实际会读写的 skill 形状（只依赖 id/name/autoinvoke）。 */
export interface MutableSkill {
  id?: string
  name?: string
  autoinvoke?: boolean
  [key: string]: unknown
}

/**
 * OpenCode V2 的 `SkillEditor` 结构。
 *
 * 真实契约（@opencode/plugin 2.x）：
 * - `list()` / `update(id, cb)` / `get(id)` / `add()` / `remove()`
 *
 * 同时兼容其它可能形态（如以 `skills` 记录暴露的编辑器），
 * 使得插件对宿主的内部表示变化更鲁棒。
 */
export interface SkillEditorLike {
  list?(): readonly MutableSkill[]
  get?(id: string): MutableSkill | undefined
  update?(id: string, update: (skill: MutableSkill) => void): void
  skills?: Record<string, MutableSkill> | readonly MutableSkill[]
}

export interface ApplyResult {
  /** 被检查的 skill 总数 */
  examined: number
  /** 被隐藏（autoinvoke → false）的 skill 标识 */
  hidden: string[]
  /** 被恢复（autoinvoke → true）的 skill 标识 */
  shown: string[]
}

/**
 * 枚举编辑器中的全部 skill，兼容多种形态。
 *
 * 优先使用 V2 的 `list()`；否则回退到 `skills`（对象记录或数组）。
 */
export function collectSkills(editor: SkillEditorLike): MutableSkill[] {
  if (typeof editor.list === "function") {
    return dedupe(toArray(editor.list()))
  }

  const skills = editor.skills
  if (Array.isArray(skills)) {
    return dedupe(skills.filter(isSkillLike))
  }
  if (isRecord(skills)) {
    const collected: MutableSkill[] = []
    for (const [key, value] of Object.entries(skills)) {
      if (!isSkillLike(value)) {
        continue
      }
      // 保留对象引用（不克隆），以便在缺少 editor.update 时能就地写回。
      if (typeof value.id !== "string" || value.id === "") {
        value.id = key
      }
      if (typeof value.name !== "string" || value.name === "") {
        value.name = value.id
      }
      collected.push(value)
    }
    return dedupe(collected)
  }

  return []
}

/**
 * 对编辑器中的全部 skill 应用过滤规则。
 *
 * - 命中 `hide` 的 skill：`autoinvoke = false`（优雅跳过已经是目标值的项）
 * - 命中 `unhide` 且开启 `restoreUnhidden`：`autoinvoke = true`
 * - 其余保持原样
 *
 * 修改优先走 `editor.update`（V2 契约），不可用时回退为直接修改对象。
 */
export function applyFilter(
  editor: SkillEditorLike,
  rules: NormalizedRules,
  logger: Logger = silentLogger,
): ApplyResult {
  const skills = collectSkills(editor)
  const hidden: string[] = []
  const shown: string[] = []

  for (const skill of skills) {
    const identity: SkillIdentity = { id: skill.id, name: skill.name }
    const decision = decideAction(identity, rules)
    const label = describe(skill)

    if (decision.action === "leave") {
      logger.debug(`leave ${label}: ${decision.reason}`)
      continue
    }

    // hide → autoinvoke=false；show → autoinvoke=true
    const shouldHide = decision.action === "hide"
    const targetValue = !shouldHide
    if (skill.autoinvoke === targetValue) {
      logger.debug(`skip ${label}: already autoinvoke=${targetValue}`)
      continue
    }

    if (!writeAutoinvoke(editor, skill, targetValue, logger)) {
      continue
    }

    if (shouldHide) {
      hidden.push(label)
    } else {
      shown.push(label)
    }
    logger.debug(`set autoinvoke=${targetValue} on ${label}: ${decision.reason}`)
  }

  return { examined: skills.length, hidden, shown }
}

/** 写入 autoinvoke，优先使用 editor.update。 */
function writeAutoinvoke(
  editor: SkillEditorLike,
  skill: MutableSkill,
  value: boolean,
  logger: Logger,
): boolean {
  const id = skill.id ?? skill.name
  if (typeof editor.update === "function" && id) {
    try {
      editor.update(id, (target) => {
        target.autoinvoke = value
      })
      return true
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`update(${id}) failed, falling back to in-place mutation: ${reason}`)
    }
  } else if (!id) {
    logger.warn("cannot determine skill id; skipping")
    return false
  }

  // 回退：editor 可能直接暴露可写对象（如 skills 记录形态）。
  skill.autoinvoke = value
  return true
}

function describe(skill: MutableSkill): string {
  const id = skill.id ?? skill.name
  const name = skill.name ?? skill.id
  if (id && name && id !== name) {
    return `${name} (${id})`
  }
  return id ?? name ?? "<unknown>"
}

function toArray(value: readonly MutableSkill[]): MutableSkill[] {
  return Array.isArray(value) ? [...value] : Array.from(value)
}

function dedupe(skills: MutableSkill[]): MutableSkill[] {
  const seen = new Set<string>()
  const result: MutableSkill[] = []
  for (const skill of skills) {
    const key = skill.id ?? skill.name
    if (key !== undefined) {
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
    }
    result.push(skill)
  }
  return result
}

function isSkillLike(value: unknown): value is MutableSkill {
  return typeof value === "object" && value !== null
}

function isRecord(value: unknown): value is Record<string, MutableSkill> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
