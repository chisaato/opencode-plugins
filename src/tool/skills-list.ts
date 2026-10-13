import type { MutableSkill } from "../filter/apply"
import { silentLogger, type Logger } from "../utils/logger"

/** 自定义工具名称。 */
export const SKILLS_LIST_TOOL_NAME = "skills_list"

/** 自定义工具说明（会直接展示给模型）。 */
export const SKILLS_LIST_TOOL_DESCRIPTION =
  "列出当前 OpenCode 加载的所有 Skills 以及它们的过滤/隐藏/移除状态 (autoinvoke)"

/** 查询过滤：全部 / 仅可自动调用 / 仅已隐藏 / 仅已移除。 */
export type SkillsListStatus = "all" | "active" | "hidden" | "removed"

const STATUS_VALUES: readonly SkillsListStatus[] = ["all", "active", "hidden", "removed"]

/** 单个 skill 的展示状态。 */
export type SkillState = "active" | "hidden" | "removed"

/** 被本插件硬剔除（editor.remove）的 skill 摘要。 */
export interface RemovedSkillEntry {
  id?: string
  name: string
  description?: string
}

/** 单个 skill 的可读摘要。 */
export interface SkillListEntry {
  id?: string
  name: string
  description?: string
  autoinvoke: boolean
  hidden: boolean
  removed: boolean
  state: SkillState
}

/** skills_list 的结构化返回体。 */
export interface SkillsListReport {
  status: SkillsListStatus
  /** 原始发现总数 = 当前存活数量 + 被移除数量。 */
  total: number
  /** 当前存活且 `autoinvoke !== false` 的数量。 */
  active: number
  /** 当前存活且 `autoinvoke === false` 的数量。 */
  hidden: number
  /** 被本插件硬剔除的数量。 */
  removed: number
  /** 按 status 过滤后的条目列表。 */
  skills: SkillListEntry[]
}

/**
 * 一份宽松的 JSON Schema，描述 `skills_list` 的可选入参。
 *
 * 使用纯 JSON Schema（而非 effect Schema）以避免引入额外依赖，
 * 同时满足 `Tool.ValueSchema` 的 `JsonSchema` 分支。
 */
export type SkillsListInputSchema = {
  readonly type: "object"
  readonly properties: Record<string, unknown>
  readonly additionalProperties: boolean
}

export const SKILLS_LIST_INPUT_SCHEMA: SkillsListInputSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [...STATUS_VALUES],
      description:
        '筛选结果：all=全部，active=可自动调用，hidden=已被隐藏，removed=已被彻底移除。默认 "all"。',
    },
  },
  additionalProperties: false,
}

/** 判断一个 skill 是否处于“隐藏”（autoinvoke === false）状态。 */
export function isSkillHidden(skill: MutableSkill): boolean {
  return skill.autoinvoke === false
}

function normalizeStatus(value: unknown): SkillsListStatus {
  return STATUS_VALUES.includes(value as SkillsListStatus) ? (value as SkillsListStatus) : "all"
}

function toEntry(skill: MutableSkill): SkillListEntry {
  const isHidden = isSkillHidden(skill)
  const name = skill.name ?? skill.id ?? "<unknown>"
  const entry: SkillListEntry = {
    name,
    autoinvoke: !isHidden,
    hidden: isHidden,
    removed: false,
    state: isHidden ? "hidden" : "active",
  }
  if (typeof skill.id === "string" && skill.id !== "") {
    entry.id = skill.id
  }
  if (typeof skill.description === "string" && skill.description !== "") {
    entry.description = skill.description
  }
  return entry
}

function toRemovedEntry(removed: RemovedSkillEntry): SkillListEntry {
  const entry: SkillListEntry = {
    name: removed.name,
    autoinvoke: false,
    hidden: false,
    removed: true,
    state: "removed",
  }
  if (typeof removed.id === "string" && removed.id !== "") {
    entry.id = removed.id
  }
  if (typeof removed.description === "string" && removed.description !== "") {
    entry.description = removed.description
  }
  return entry
}

/**
 * 把 skill 列表整理成结构化报告。
 *
 * - `total` = 存活数量 + 被移除数量（原始发现总数）
 * - `active` / `hidden` 基于当前存活的 skill 统计
 * - `removed` 为被硬剔除的数量
 * - `skills` 则按 `status` 过滤，便于调用方一次拿到概览与明细
 */
export function buildSkillsListReport(
  skills: readonly MutableSkill[],
  status: SkillsListStatus = "all",
  removed: readonly RemovedSkillEntry[] = [],
): SkillsListReport {
  const activeEntries: SkillListEntry[] = []
  let active = 0
  let hidden = 0

  for (const skill of skills) {
    const entry = toEntry(skill)
    if (entry.hidden) {
      hidden += 1
    } else {
      active += 1
    }
    activeEntries.push(entry)
  }

  const removedEntries = removed.map(toRemovedEntry)

  const allEntries = [...activeEntries, ...removedEntries]
  const filtered =
    status === "all"
      ? allEntries
      : allEntries.filter((entry) => entry.state === status)

  return {
    status,
    total: activeEntries.length + removedEntries.length,
    active,
    hidden,
    removed: removedEntries.length,
    skills: filtered,
  }
}

/** 把报告渲染成便于模型阅读的紧凑文本。 */
export function formatSkillsList(report: SkillsListReport): string {
  const header =
    `Skills (status=${report.status}): total=${report.total}, ` +
    `active=${report.active}, hidden=${report.hidden}, removed=${report.removed}`

  if (report.skills.length === 0) {
    return `${header}\n(no skills matched)`
  }

  const lines = report.skills.map((entry) => {
    const id = entry.id && entry.id !== entry.name ? ` (${entry.id})` : ""
    const description = entry.description ? ` - ${entry.description}` : ""
    return `- [${entry.state}] ${entry.name}${id}${description}`
  })

  return [header, ...lines].join("\n")
}

export interface SkillsListToolDeps {
  /** 读取当前加载的 skill；通常为 `ctx.skill.list()` 的适配。 */
  listSkills: () => Promise<readonly MutableSkill[]> | readonly MutableSkill[]
  /** 读取本插件硬剔除（editor.remove）的 skill；用于统计 removed。 */
  getRemoved?: () => Promise<readonly RemovedSkillEntry[]> | readonly RemovedSkillEntry[]
  logger?: Logger
}

/**
 * 构造 `skills_list` 工具定义。
 *
 * 返回对象的形状与 `ToolEditor.add` 接受的 `Tool.Info` 兼容
 * （`name` / `description` / `input` / `execute`）。
 */
export function createSkillsListTool(deps: SkillsListToolDeps) {
  const logger = deps.logger ?? silentLogger

  return {
    name: SKILLS_LIST_TOOL_NAME,
    description: SKILLS_LIST_TOOL_DESCRIPTION,
    input: SKILLS_LIST_INPUT_SCHEMA,
    async execute(input: unknown, _context: unknown) {
      const status = normalizeStatus((input as { status?: unknown } | undefined)?.status)
      const skills = await deps.listSkills()
      const removed = deps.getRemoved ? await deps.getRemoved() : []
      const report = buildSkillsListReport(skills, status, removed)

      logger.debug(
        `skills_list: status=${status} total=${report.total} ` +
          `active=${report.active} hidden=${report.hidden} removed=${report.removed}`,
      )

      return {
        content: [{ type: "text" as const, text: formatSkillsList(report) }],
        metadata: report as unknown as Record<string, unknown>,
      }
    },
  }
}
