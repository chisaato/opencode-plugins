import path from "node:path"
import { PROMPTS_DIR_NAME, resolveUserPath } from "../utils/paths"
import type { Logger } from "../utils/logger"

export interface Rule {
  models: string[]
  prompts: string[]
  agents?: string[]
  excludeAgents?: string[]
  requireTools?: string[]
  configDir: string
  promptsDir: string
}

export interface Layer {
  rules: Rule[]
  replace: boolean
  debug: boolean
  source: string
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** 路径列表绝不接受换行（避免将内联提示词误作文件名）。 */
function strings(value: unknown, label: string, logger: Logger, paths = false): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    logger.warn(`${label}：应为数组`)
    return []
  }
  return value.filter((entry): entry is string => {
    if (typeof entry === "string" && entry.length > 0 && (!paths || !/[\r\n]/.test(entry))) return true
    logger.warn(`${label}：无效的${paths ? "提示词路径" : "匹配模式"} ${JSON.stringify(entry)}`)
    return false
  })
}

export function normalizeLayer(raw: unknown, configDir: string, source: string, logger: Logger): Layer | undefined {
  if (!isObject(raw)) {
    logger.warn(`${source}：应为 JSON 对象`)
    return undefined
  }
  const promptsDir =
    typeof raw.promptsDir === "string"
      ? raw.promptsDir.startsWith("~/") || path.isAbsolute(raw.promptsDir)
        ? resolveUserPath(raw.promptsDir)
        : path.resolve(configDir, raw.promptsDir)
      : path.join(configDir, PROMPTS_DIR_NAME)
  const defaults = {
    agents: strings(raw.agents, `${source}.agents`, logger),
    excludeAgents: strings(raw.excludeAgents, `${source}.excludeAgents`, logger),
    requireTools: strings(raw.requireTools, `${source}.requireTools`, logger),
  }
  const rules: Rule[] = []
  const add = (item: Record<string, unknown>, models: string[], label: string) => {
    const prompts = strings(item.prompts, `${label}.prompts`, logger, true)
    if (!prompts || models.length === 0) return
    rules.push({
      models,
      prompts,
      agents: strings(item.agents, `${label}.agents`, logger) ?? defaults.agents,
      excludeAgents: strings(item.excludeAgents, `${label}.excludeAgents`, logger) ?? defaults.excludeAgents,
      requireTools: strings(item.requireTools, `${label}.requireTools`, logger) ?? defaults.requireTools,
      configDir,
      promptsDir,
    })
  }
  if (raw.models !== undefined && !isObject(raw.models)) logger.warn(`${source}.models：应为对象`)
  if (isObject(raw.models)) {
    for (const [pattern, item] of Object.entries(raw.models)) {
      if (Array.isArray(item)) add({ prompts: item }, [pattern], `${source}.models.${pattern}`)
      else if (isObject(item)) add(item, [pattern], `${source}.models.${pattern}`)
      else logger.warn(`${source}.models.${pattern}：无效的规则`)
    }
  }
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) logger.warn(`${source}.rules：应为数组`)
  if (Array.isArray(raw.rules)) {
    raw.rules.forEach((item: unknown, index) => {
      if (isObject(item)) {
        add(item, strings(item.models, `${source}.rules[${index}].models`, logger) ?? [], `${source}.rules[${index}]`)
      } else logger.warn(`${source}.rules[${index}]：无效的规则`)
    })
  }
  return { rules, replace: raw.replace === true, debug: raw.debug === true, source }
}
