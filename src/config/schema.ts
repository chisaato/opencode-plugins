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
 *
 * `depth` 用于阻止 `overrides` 无限嵌套：只有顶层配置才会解析 `overrides`。
 */
export function normalizeConfig(raw: unknown, source: string, depth = 0): SkillFilterConfig {
  if (!isPlainObject(raw)) {
    return {}
  }

  const config: SkillFilterConfig = {}

  const remove = readPatterns(raw.remove, "remove", source)
  if (remove.length > 0) {
    config.remove = remove
  }

  const hide = readPatterns(raw.hide, "hide", source)
  if (hide.length > 0) {
    config.hide = hide
  }

  // `enable` 是首选字段，`unhide` 作为旧版别名等价映射进来。
  const enable = normalizePatterns([
    ...readPatterns(raw.enable, "enable", source),
    ...readPatterns(raw.unhide, "unhide", source),
  ])
  if (enable.length > 0) {
    config.enable = enable
  }

  if (depth === 0 && raw.overrides !== undefined) {
    if (isPlainObject(raw.overrides)) {
      const overrides: Record<string, SkillFilterConfig> = {}
      for (const [key, value] of Object.entries(raw.overrides)) {
        if (isPlainObject(value)) {
          overrides[key] = normalizeConfig(value, `${source} overrides["${key}"]`, depth + 1)
        } else {
          warnInvalid(source, `overrides["${key}"]`, "object")
        }
      }
      if (Object.keys(overrides).length > 0) {
        config.overrides = overrides
      }
    } else {
      warnInvalid(source, "overrides", "object")
    }
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

  if (raw.restoreUnhidden !== undefined && typeof raw.restoreUnhidden !== "boolean") {
    warnInvalid(source, "restoreUnhidden", "boolean")
  }

  if (raw.debug !== undefined) {
    if (typeof raw.debug === "boolean") {
      config.debug = raw.debug
    } else {
      warnInvalid(source, "debug", "boolean")
    }
  }

  if (raw.exposeTool !== undefined) {
    if (typeof raw.exposeTool === "boolean") {
      config.exposeTool = raw.exposeTool
    } else {
      warnInvalid(source, "exposeTool", "boolean")
    }
  }

  if (typeof raw.configPath === "string" || raw.configPath === false) {
    config.configPath = raw.configPath
  }

  return config
}

/**
 * 合并两层的配置。
 *
 * 后一层（higher）中出现的字段覆盖前一层（lower）的同名字段
 * （数组整体替换，不做并集），未出现的字段沿用前一层。
 */
export function mergeConfigs(
  lower: SkillFilterConfig,
  higher: SkillFilterConfig,
): SkillFilterConfig {
  const include = higher.patterns?.include ?? lower.patterns?.include
  const exclude = higher.patterns?.exclude ?? lower.patterns?.exclude

  const merged: SkillFilterConfig = {}

  const remove = higher.remove ?? lower.remove
  if (remove) {
    merged.remove = remove
  }
  const hide = higher.hide ?? lower.hide
  if (hide) {
    merged.hide = hide
  }
  const enable = higher.enable ?? lower.enable
  if (enable) {
    merged.enable = enable
  }

  const patterns: SkillPatterns = {}
  if (include) {
    patterns.include = include
  }
  if (exclude) {
    patterns.exclude = exclude
  }
  if (Object.keys(patterns).length > 0) {
    merged.patterns = patterns
  }

  const debug = higher.debug ?? lower.debug
  if (debug !== undefined) {
    merged.debug = debug
  }
  const exposeTool = higher.exposeTool ?? lower.exposeTool
  if (exposeTool !== undefined) {
    merged.exposeTool = exposeTool
  }
  const configPath = higher.configPath ?? lower.configPath
  if (configPath !== undefined) {
    merged.configPath = configPath
  }

  return merged
}

/** 把合并后的配置转换为运行时规则。 */
export function toRules(config: SkillFilterConfig): NormalizedRules {
  return {
    remove: config.remove ?? [],
    hide: config.hide ?? [],
    enable: config.enable ?? [],
    include: config.patterns?.include ?? [],
    exclude: config.patterns?.exclude ?? [],
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
