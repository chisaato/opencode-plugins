import { normalizePatterns } from "../matching/glob"
import type { NormalizedRules, SkillFilterConfig, SkillPatterns } from "../types"

type PlainRecord = Record<string, unknown>

export function isPlainObject(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 宽松校验并归一化一份原始配置。
 *
 * 非法字段会被忽略（并对类型明显错误的情况发出一次警告），
 * 这样单个笔误不会导致整个插件失效。
 */
export function normalizeConfig(raw: unknown, source: string): SkillFilterConfig {
  if (!isPlainObject(raw)) {
    return {}
  }

  const config: SkillFilterConfig = {}

  const hide = readPatterns(raw.hide, "hide", source)
  if (hide.length > 0) {
    config.hide = hide
  }

  const unhide = readPatterns(raw.unhide, "unhide", source)
  if (unhide.length > 0) {
    config.unhide = unhide
  }

  if (raw.patterns !== undefined) {
    if (isPlainObject(raw.patterns)) {
      const patterns: SkillPatterns = {}
      const include = readPatterns(raw.patterns.include, "patterns.include", source)
      if (include.length > 0) {
        patterns.include = include
      }
      const exclude = readPatterns(raw.patterns.exclude, "patterns.exclude", source)
      if (exclude.length > 0) {
        patterns.exclude = exclude
      }
      if (Object.keys(patterns).length > 0) {
        config.patterns = patterns
      }
    } else {
      warnInvalid(source, "patterns", "object")
    }
  }

  if (raw.restoreUnhidden !== undefined) {
    if (typeof raw.restoreUnhidden === "boolean") {
      config.restoreUnhidden = raw.restoreUnhidden
    } else {
      warnInvalid(source, "restoreUnhidden", "boolean")
    }
  }

  if (raw.debug !== undefined) {
    if (typeof raw.debug === "boolean") {
      config.debug = raw.debug
    } else {
      warnInvalid(source, "debug", "boolean")
    }
  }

  if (typeof raw.configPath === "string" || raw.configPath === false) {
    config.configPath = raw.configPath
  }

  return config
}

/**
 * 合并“文件配置”与“内联 options”。
 *
 * 内联 options 中出现的字段覆盖文件中的同名字段（数组整体替换，不做并集），
 * 未出现的字段沿用文件值。
 */
export function mergeConfigs(
  fileConfig: SkillFilterConfig,
  inlineConfig: SkillFilterConfig,
): SkillFilterConfig {
  const include = inlineConfig.patterns?.include ?? fileConfig.patterns?.include
  const exclude = inlineConfig.patterns?.exclude ?? fileConfig.patterns?.exclude

  const patterns: SkillPatterns = {}
  if (include) {
    patterns.include = include
  }
  if (exclude) {
    patterns.exclude = exclude
  }

  const merged: SkillFilterConfig = {}
  const hide = inlineConfig.hide ?? fileConfig.hide
  if (hide) {
    merged.hide = hide
  }
  const unhide = inlineConfig.unhide ?? fileConfig.unhide
  if (unhide) {
    merged.unhide = unhide
  }
  if (Object.keys(patterns).length > 0) {
    merged.patterns = patterns
  }
  const restoreUnhidden = inlineConfig.restoreUnhidden ?? fileConfig.restoreUnhidden
  if (restoreUnhidden !== undefined) {
    merged.restoreUnhidden = restoreUnhidden
  }
  const debug = inlineConfig.debug ?? fileConfig.debug
  if (debug !== undefined) {
    merged.debug = debug
  }
  const configPath = inlineConfig.configPath ?? fileConfig.configPath
  if (configPath !== undefined) {
    merged.configPath = configPath
  }

  return merged
}

/** 把合并后的配置转换为运行时规则。 */
export function toRules(config: SkillFilterConfig): NormalizedRules {
  return {
    hide: config.hide ?? [],
    unhide: config.unhide ?? [],
    include: config.patterns?.include ?? [],
    exclude: config.patterns?.exclude ?? [],
    restoreUnhidden: config.restoreUnhidden === true,
  }
}

function readPatterns(value: unknown, field: string, source: string): string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    warnInvalid(source, field, "string[]")
    return []
  }
  return normalizePatterns(value)
}

function warnInvalid(source: string, field: string, expected: string): void {
  console.warn(`[skill-filter] Ignoring invalid "${field}" in ${source}: expected ${expected}`)
}
