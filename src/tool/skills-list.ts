import type { MutableSkill } from "../filter/apply"
import { silentLogger, type Logger } from "../utils/logger"

/** 自定义工具名称。 */
export const SKILLS_LIST_TOOL_NAME = "skills_list"

/** 自定义工具说明（会直接展示给模型）。 */
export const SKILLS_LIST_TOOL_DESCRIPTION =
  "列出当前 OpenCode 加载的所有 Skills 以及它们的过滤/隐藏状态 (autoinvoke)"

/** 查询过滤：全部 / 仅可自动调用 / 仅已隐藏。 */
export type SkillsListStatus = "all" | "active" | "hidden"

const STATUS_VALUES: readonly SkillsListStatus[] = ["all", "active", "hidden"]

/** 单个 skill 的可读摘要。 */
export interface SkillListEntry {
  id?: string
  name: string
  description?: string
  autoinvoke: boolean
  hidden: boolean
}

/** tools_list 的结构化返回体。 */
export interface SkillsListReport {
  status: SkillsListStatus
  /** 全部 skill 数量（不受 status 过滤影响）。 */
  total: number
  /** `autoinvoke !== false` 的数量。 */
  active: number
  /** `autoinvoke === false` 的数量。 */
  hidden: number
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
      description: '筛选结果：all=全部，active=可自动调用，hidden=已被隐藏。默认 "all"。',
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

/**
 * 把 skill 列表整理成结构化报告。
 *
 * `total/active/hidden` 始终基于全部 skill 统计；`skills` 则按 `status` 过滤，
 * 便于调用方一次拿到概览与明细。
 */
export function buildSkillsListReport(
  skills: readonly MutableSkill[],
  status: SkillsListStatus = "all",
): SkillsListReport {
  const entries: SkillListEntry[] = []
  let active = 0
  let hidden = 0

  for (const skill of skills) {
    const isHidden = isSkillHidden(skill)
    if (isHidden) {
      hidden += 1
    } else {
      active += 1
    }

    const name = skill.name ?? skill.id ?? "<unknown>"
    const entry: SkillListEntry = {
      name,
      autoinvoke: !isHidden,
      hidden: isHidden,
    }
    if (typeof skill.id === "string" && skill.id !== "") {
      entry.id = skill.id
    }
    if (typeof skill.description === "string" && skill.description !== "") {
      entry.description = skill.description
    }
    entries.push(entry)
  }

  const filtered =
    status === "all"
      ? entries
      : entries.filter((entry) => (status === "hidden" ? entry.hidden : !entry.hidden))

  return { status, total: skills.length, active, hidden, skills: filtered }
}

/** 把报告渲染成便于模型阅读的紧凑文本。 */
export function formatSkillsList(report: SkillsListReport): string {
  const header =
    `Skills (status=${report.status}): total=${report.total}, ` +
    `active=${report.active}, hidden=${report.hidden}`

  if (report.skills.length === 0) {
    return `${header}\n(no skills matched)`
  }

  const lines = report.skills.map((entry) => {
    const id = entry.id && entry.id !== entry.name ? ` (${entry.id})` : ""
    const state = entry.hidden ? "hidden" : "active"
    const description = entry.description ? ` - ${entry.description}` : ""
    return `- [${state}] ${entry.name}${id}${description}`
  })

  return [header, ...lines].join("\n")
}

export interface SkillsListToolDeps {
  /** 读取当前加载的 skill；通常为 `ctx.skill.list()` 的适配。 */
  listSkills: () => Promise<readonly MutableSkill[]> | readonly MutableSkill[]
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
      const report = buildSkillsListReport(skills, status)

      logger.debug(
        `skills_list: status=${status} total=${report.total} ` +
          `active=${report.active} hidden=${report.hidden}`,
      )

      return {
        content: [{ type: "text" as const, text: formatSkillsList(report) }],
        metadata: report as unknown as Record<string, unknown>,
      }
    },
  }
}
