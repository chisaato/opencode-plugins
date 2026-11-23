import fs from "node:fs/promises"
import path from "node:path"
import type { Rule } from "./config/schema"
import { resolveUserPath } from "./utils/paths"

/** 星号匹配任意字符（包括斜线），问号匹配单个字符。 */
export function matchesGlob(value: string, pattern: string): boolean {
  const source = [...pattern].map((char) => {
    if (char === "*") return ".*"
    if (char === "?") return "."
    return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }).join("")
  return new RegExp(`^${source}$`).test(value)
}

export interface MatchInput {
  model: { providerID: string; id: string; variant?: string }
  agent?: string
  agents?: readonly string[]
  tools?: Record<string, unknown>
}

export function matchesRule(rule: Rule, input: MatchInput): boolean {
  const model = `${input.model.providerID}/${input.model.id}`
  if (!rule.models.some((pattern) => matchesGlob(pattern.includes("@") && input.model.variant ? `${model}@${input.model.variant}` : model, pattern))) return false
  const agents = new Set([input.agent, ...(input.agents ?? [])].filter((value): value is string => typeof value === "string"))
  if (rule.agents !== undefined && !rule.agents.some((pattern) => [...agents].some((candidate) => matchesGlob(candidate, pattern)))) return false
  if (rule.excludeAgents?.some((pattern) => [...agents].some((candidate) => matchesGlob(candidate, pattern)))) return false
  if (rule.requireTools?.some((tool) => !Object.hasOwn(input.tools ?? {}, tool))) return false
  return true
}

async function missing(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

export async function resolvePromptPath(
  entry: string,
  rule: Rule,
  globalPromptsDir: string,
  isMissing = missing,
): Promise<string> {
  if (entry.startsWith("~/") || path.isAbsolute(entry)) return resolveUserPath(entry)
  if (entry.startsWith("./") || entry.startsWith("../")) return path.resolve(rule.configDir, entry)
  const local = path.resolve(rule.promptsDir, entry)
  if (rule.promptsDir !== globalPromptsDir && await isMissing(local)) return path.resolve(globalPromptsDir, entry)
  return local
}

/** 命中规则按层/声明顺序叠加，以解析后的文件路径去重。 */
export async function collectPromptPaths(rules: readonly Rule[], input: MatchInput, globalPromptsDir: string): Promise<string[]> {
  const paths = new Set<string>()
  for (const rule of rules) {
    if (!matchesRule(rule, input)) continue
    for (const entry of rule.prompts) paths.add(await resolvePromptPath(entry, rule, globalPromptsDir))
  }
  return [...paths]
}
