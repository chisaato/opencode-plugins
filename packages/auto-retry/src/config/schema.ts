export interface Rule {
  models: string[]
  errors: string[]
  prompt: string
  maxRetries: number
  delayMs: number
  resetAfterToolCalls: number
  resetAfterMs: number
}

export interface RuleDefaults {
  prompt: string
  maxRetries: number
  delayMs: number
  resetAfterToolCalls: number
  resetAfterMs: number
}

/** 只作为规则缺省值，不是内置触发条件。 */
export const BUILTIN_DEFAULTS: RuleDefaults = {
  prompt: "继续",
  maxRetries: 3,
  delayMs: 2000,
  resetAfterToolCalls: 10,
  resetAfterMs: 120_000,
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function mergeDefaults(
  base: RuleDefaults,
  patch: unknown,
  report?: (message: string) => void,
): RuleDefaults {
  if (!isPlainObject(patch)) return base
  return {
    prompt: typeof patch.prompt === "string" && patch.prompt.length > 0 ? patch.prompt : base.prompt,
    maxRetries: isNonNegativeInt(patch.maxRetries) ? patch.maxRetries : base.maxRetries,
    delayMs: isNonNegativeInt(patch.delayMs) ? patch.delayMs : base.delayMs,
    resetAfterToolCalls: pickPositive(
      patch,
      "resetAfterToolCalls",
      base.resetAfterToolCalls,
      report,
    ),
    resetAfterMs: pickPositive(patch, "resetAfterMs", base.resetAfterMs, report),
  }
}

/**
 * 把原始 rules 归一成可执行规则。
 * 缺 models 或 errors（或过滤后为空）的条目被丢掉，并通过 report 说明原因。
 */
export function normalizeRules(
  rawRules: unknown,
  defaults: RuleDefaults,
  report: (message: string) => void,
): Rule[] {
  if (!Array.isArray(rawRules)) return []

  const rules: Rule[] = []
  for (let index = 0; index < rawRules.length; index += 1) {
    const normalized = normalizeRule(rawRules[index], defaults, index, report)
    if (normalized) rules.push(normalized)
  }
  return rules
}

function normalizeRule(
  raw: unknown,
  defaults: RuleDefaults,
  index: number,
  report: (message: string) => void,
): Rule | undefined {
  if (!isPlainObject(raw)) {
    report(`忽略第 ${index + 1} 条规则：不是对象`)
    return undefined
  }

  const models = readStringList(raw.models)
  const errors = readStringList(raw.errors)
  if (!models || models.length === 0 || !errors || errors.length === 0) {
    report(`忽略第 ${index + 1} 条规则：缺少 models 或 errors`)
    return undefined
  }

  return {
    models,
    errors,
    prompt: typeof raw.prompt === "string" && raw.prompt.length > 0 ? raw.prompt : defaults.prompt,
    maxRetries: isNonNegativeInt(raw.maxRetries) ? raw.maxRetries : defaults.maxRetries,
    delayMs: isNonNegativeInt(raw.delayMs) ? raw.delayMs : defaults.delayMs,
    resetAfterToolCalls: pickPositive(raw, "resetAfterToolCalls", defaults.resetAfterToolCalls, report, index),
    resetAfterMs: pickPositive(raw, "resetAfterMs", defaults.resetAfterMs, report, index),
  }
}

/** 不是数组视为缺失；数组则只保留非空字符串。 */
function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (trimmed.length === 0 || items.includes(trimmed)) continue
    items.push(trimmed)
  }
  return items
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
}

/**
 * 缺省则沿用 fallback。写了但不是正整数时提示，并回退 fallback。
 * index 有值表示这是某一条规则，否则是 defaults。
 */
function pickPositive(
  source: Record<string, unknown>,
  key: "resetAfterToolCalls" | "resetAfterMs",
  fallback: number,
  report?: (message: string) => void,
  index?: number,
): number {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return fallback
  const value = source[key]
  if (isPositiveInt(value)) return value
  const where = index === undefined ? `defaults.${key}` : `第 ${index + 1} 条规则的 ${key}`
  report?.(`${where} 不是正整数，已改用 ${fallback}`)
  return fallback
}
