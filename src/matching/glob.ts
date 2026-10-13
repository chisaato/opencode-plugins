/**
 * 轻量 glob 匹配（无第三方依赖）。
 *
 * 支持：
 * - `*`  任意长度字符（含空串，可跨越 `/`）
 * - `?`  单个字符
 * - 其它字符按字面量匹配，正则元字符会被转义
 *
 * 匹配为整串锚定（`^...$`），因此 `to-*` 不会命中 `atto`。
 * 匹配区分大小写，与 skill 名称本身的大小写语义一致。
 */

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/** 把 glob 规则编译为正则表达式。 */
export function globToRegExp(pattern: string): RegExp {
  let source = "^"
  for (const char of pattern) {
    if (char === "*") {
      source += ".*"
    } else if (char === "?") {
      source += "."
    } else {
      source += char.replace(REGEX_SPECIAL, "\\$&")
    }
  }
  source += "$"
  return new RegExp(source)
}

/** 判断单个值是否命中 glob 规则。 */
export function matchesPattern(value: string, pattern: string): boolean {
  if (value === "" || pattern === "") {
    return false
  }
  if (value === pattern) {
    return true
  }
  return globToRegExp(pattern).test(value)
}

/** 判断值是否命中任一规则，返回第一个命中的规则（未命中返回 undefined）。 */
export function firstMatchingPattern(
  value: string,
  patterns: readonly string[],
): string | undefined {
  return patterns.find((pattern) => matchesPattern(value, pattern))
}

/**
 * 归一化规则数组：仅保留字符串、去除首尾空白、丢弃空串、去重并保持顺序。
 */
export function normalizePatterns(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return []
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of input) {
    if (typeof item !== "string") {
      continue
    }
    const trimmed = item.trim()
    if (trimmed === "" || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}
