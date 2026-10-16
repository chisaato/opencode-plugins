import fs from "node:fs/promises"
import { parseJsonc } from "./jsonc"
import {
  BUILTIN_DEFAULTS,
  isPlainObject,
  mergeDefaults,
  normalizeRules,
  type Rule,
  type RuleDefaults,
} from "./schema"
import { createLogger, type Logger } from "../utils/logger"
import { globalConfigPaths, projectConfigPaths } from "../utils/paths"

export interface LoadConfigOptions {
  projectDir: string
  homeDir?: string
  logger?: Logger
}

export interface ResolvedConfig {
  rules: Rule[]
  warnings: string[]
}

interface FileConfig {
  path: string
  enabled?: boolean
  defaults?: unknown
  /** 文件里出现了 rules 键。空数组也算出现，用来整体覆盖。 */
  rules?: unknown
  hasRules: boolean
}

/**
 * 读取全局与项目配置。
 *
 * 每个目录只读一份：先 `auto-retry.jsonc`，不存在才读 `auto-retry.json`。
 * jsonc 存在但读失败或解析失败时警告，并且不退回同目录的 json。
 * 全局和项目各自选完文件后再合并，合并方式不变：
 * 项目文件只要写了 rules（包括空数组），就整体替换全局 rules，不逐条合并。
 * 项目文件没写 rules 时，沿用全局规则，但仍套用项目的 defaults / enabled。
 * 没有文件、enabled 为 false、规则为空，都返回 rules: []。
 */
export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
  const logger = options.logger ?? createLogger()
  const warnings: string[] = []
  const report = (message: string) => {
    warnings.push(message)
    logger.warn(message)
  }

  const globalFile = await readConfigDir(globalConfigPaths({ homeDir: options.homeDir }), report)
  const projectFile = await readConfigDir(projectConfigPaths(options.projectDir), report)

  let enabled = true
  let defaults: RuleDefaults = { ...BUILTIN_DEFAULTS }
  let rawRules: unknown = []
  let hasRules = false

  for (const file of [globalFile, projectFile]) {
    if (!file) continue
    if (typeof file.enabled === "boolean") enabled = file.enabled
    defaults = mergeDefaults(defaults, file.defaults, report)
    if (file.hasRules) {
      hasRules = true
      rawRules = file.rules
    }
  }

  if (!enabled || !hasRules) return { rules: [], warnings }
  if (!Array.isArray(rawRules)) {
    report("rules 必须是数组，已忽略")
    return { rules: [], warnings }
  }

  return {
    rules: normalizeRules(rawRules, defaults, report),
    warnings,
  }
}

type ReadOutcome = { status: "missing" } | { status: "invalid" } | { status: "ok"; config: FileConfig }

/**
 * 同一目录的候选按顺序试。只有文件不存在才看下一个；
 * 读到了但内容坏掉就停，避免旧的 json 规则悄悄生效。
 */
async function readConfigDir(
  candidates: readonly string[],
  report: (message: string) => void,
): Promise<FileConfig | undefined> {
  for (const filePath of candidates) {
    const outcome = await readConfig(filePath, report)
    if (outcome.status === "missing") continue
    return outcome.status === "ok" ? outcome.config : undefined
  }
  return undefined
}

async function readConfig(filePath: string, report: (message: string) => void): Promise<ReadOutcome> {
  let text: string
  try {
    text = await fs.readFile(filePath, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
    const reason = error instanceof Error ? error.message : String(error)
    report(`无法读取配置 ${filePath}：${reason}`)
    return { status: "invalid" }
  }

  let data: unknown
  try {
    data = parseJsonc(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    report(`无法读取配置 ${filePath}：${reason}`)
    return { status: "invalid" }
  }
  if (!isPlainObject(data)) {
    report(`忽略配置 ${filePath}：根节点必须是对象`)
    return { status: "invalid" }
  }

  return {
    status: "ok",
    config: {
      path: filePath,
      ...(typeof data.enabled === "boolean" ? { enabled: data.enabled } : {}),
      ...(data.defaults !== undefined ? { defaults: data.defaults } : {}),
      hasRules: Object.prototype.hasOwnProperty.call(data, "rules"),
      ...(Object.prototype.hasOwnProperty.call(data, "rules") ? { rules: data.rules } : {}),
    },
  }
}
