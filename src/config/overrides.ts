import path from "node:path"
import { matchesPattern } from "../matching/glob"
import type { SkillFilterConfig } from "../types"
import { mergeConfigs } from "./schema"

/**
 * 判断当前目录是否命中某个 override 键。
 *
 * 同时尝试两种目标：
 * - 规范化后的完整目录路径（分隔符统一为 `/`）
 * - 目录的 basename（仓库名），便于用 `my-project` 直接命中
 *
 * 键支持 glob：跨目录通配、绝对路径、或纯仓库名。
 */
export function matchesDirectory(directory: string, pattern: string): boolean {
  if (directory === "" || pattern === "") {
    return false
  }

  const normalized = normalizeDirectory(directory)
  const base = path.basename(normalized)

  return matchesPattern(normalized, pattern) || matchesPattern(base, pattern)
}

/**
 * 按目录命中顺序合并所有匹配的 override（后者覆盖前者）。
 * 未命中任何 override 时返回 `undefined`。
 */
export function resolveOverrides(
  overrides: Record<string, SkillFilterConfig> | undefined,
  directory: string,
): SkillFilterConfig | undefined {
  if (!overrides) {
    return undefined
  }

  let merged: SkillFilterConfig | undefined
  for (const [pattern, config] of Object.entries(overrides)) {
    if (matchesDirectory(directory, pattern)) {
      merged = mergeConfigs(merged ?? {}, config)
    }
  }
  return merged
}

/** 把目录分隔符统一为 `/`，并去掉结尾斜杠，便于 glob 匹配。 */
export function normalizeDirectory(directory: string): string {
  const normalized = directory.replace(/\\/g, "/")
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}
