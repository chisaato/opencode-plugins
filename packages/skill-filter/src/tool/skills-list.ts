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

/** 内核级 Policy 同步摘要（由 `syncPolicy` 生成）。 */
export interface PoliciesSummary {
  /** 已生成并同步的 deny policy 模式（即 remove 规则）。 */
  patterns: string[]
  /** 是否成功定位到目标配置文件。 */
  synced: boolean
  /** 是否实际写入了文件。 */
  written: boolean
  /** 目标配置文件路径（若已定位）。 */
  path?: string
  /** 未同步 / 未写入的原因（诊断）。 */
  reason?: string
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
  /** 内核 policy 同步摘要（仅在开启 `syncPolicy` 且存在 remove 规则时出现）。 */
  policies?: PoliciesSummary
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
 * - `removed` 为被硬剔除的数量（与存活列表按 id/name 去重，避免同一 skill 被重复计数）
 * - `skills` 则按 `status` 过滤，便于调用方一次拿到概览与明细
 */
export function buildSkillsListReport(
  skills: readonly MutableSkill[],
  status: SkillsListStatus = "all",
  removed: readonly RemovedSkillEntry[] = [],
  policies?: PoliciesSummary,
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

  // 已被测到仍然存活的 skill 不计入 removed（例如 editor.remove 不可用时的降级）。
  const liveKeys = new Set(activeEntries.map((entry) => entry.id ?? entry.name))
  const removedEntries = removed
    .filter((entry) => !liveKeys.has(entry.id ?? entry.name))
    .map(toRemovedEntry)

  const allEntries = [...activeEntries, ...removedEntries]
  const filtered =
    status === "all"
      ? allEntries
      : allEntries.filter((entry) => entry.state === status)

  const report: SkillsListReport = {
    status,
    total: activeEntries.length + removedEntries.length,
    active,
    hidden,
    removed: removedEntries.length,
    skills: filtered,
  }
  if (policies) {
    report.policies = policies
  }
  return report
}

/** 把报告渲染成便于模型阅读的紧凑文本。 */
export function formatSkillsList(report: SkillsListReport): string {
  const header =
    `Skills (status=${report.status}): total=${report.total}, ` +
    `active=${report.active}, hidden=${report.hidden}, removed=${report.removed}`

  const lines = [header]

  if (report.policies) {
    lines.push(formatPolicies(report.policies))
  }

  if (report.skills.length === 0) {
    lines.push("(no skills matched)")
    return lines.join("\n")
  }

  for (const entry of report.skills) {
    const id = entry.id && entry.id !== entry.name ? ` (${entry.id})` : ""
    const description = entry.description ? ` - ${entry.description}` : ""
    lines.push(`- [${entry.state}] ${entry.name}${id}${description}`)
  }

  return lines.join("\n")
}

/** 渲染内核 policy 同步状态行。 */
function formatPolicies(policies: PoliciesSummary): string {
  const target = policies.path ? ` -> ${policies.path}` : ""
  const written = policies.written ? " (written)" : ""
  const resources = policies.patterns.length
    ? policies.patterns.map((pattern) => `skill:${pattern}`).join(", ")
    : "none"
  return `policy: synced=${policies.synced}${written} deny=[${resources}]${target}`
}

export interface SkillsListToolDeps {
  /** 读取当前加载的 skill；通常为 `ctx.skill.list()` 的适配。 */
  listSkills: () => Promise<readonly MutableSkill[]> | readonly MutableSkill[]
  /** 读取本插件硬剔除（editor.remove）的 skill；用于统计 removed。 */
  getRemoved?: () => Promise<readonly RemovedSkillEntry[]> | readonly RemovedSkillEntry[]
  /** 读取内核 policy 同步状态（可选）。 */
  getPolicies?: () => Promise<PoliciesSummary | undefined> | PoliciesSummary | undefined
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
      const policies = deps.getPolicies ? await deps.getPolicies() : undefined
      const report = buildSkillsListReport(skills, status, removed, policies)

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
