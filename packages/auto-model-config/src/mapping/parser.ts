import fs from "node:fs/promises"
import path from "node:path"
import type { AutoModelConfig } from "../types"
import { getGlobalConfigDir, type PathResolutionOptions } from "../utils/paths"

const CONFIG_FILENAME = "oc-auto-model-config.json"

export interface LoadConfigOptions extends PathResolutionOptions {}

export async function loadConfig(options?: LoadConfigOptions): Promise<AutoModelConfig | null> {
  const searchPaths: string[] = []

  // 1. 项目目录优先（若提供）
  if (options?.projectDirectory) {
    searchPaths.push(path.join(options.projectDirectory, CONFIG_FILENAME))
  } else {
    // 兼容无参数时的工作目录
    searchPaths.push(path.join(process.cwd(), CONFIG_FILENAME))
  }

  // 2. 全局目录回退（遵循 XDG_CONFIG_HOME / injected home / default ~/.config/opencode）
  const globalDir = getGlobalConfigDir(options)
  searchPaths.push(path.join(globalDir, CONFIG_FILENAME))

  for (const configPath of searchPaths) {
    try {
      const raw = await fs.readFile(configPath, "utf-8")
      const parsed = JSON.parse(raw)
      return parseAutoModelConfig(parsed, configPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // 文件不存在（ENOENT）是正常回退场景，不产生噪音；其它读取/解析失败则记录可诊断信息。
      if (code !== "ENOENT") {
        const reason = error instanceof Error ? error.message : String(error)
        console.warn(`[auto-model-config] Failed to read config at ${configPath}: ${reason}`)
      }
      continue
    }
  }

  return null
}

function parseAutoModelConfig(
  raw: any,
  configPath: string,
): AutoModelConfig | null {
  if (!raw || typeof raw !== "object") {
    console.warn(`[auto-model-config] Invalid config in ${configPath}`)
    return null
  }

  const mapping = parseStringMapping(raw.mapping)
  const costMapping = parseCostMapping(raw.costMapping, configPath)
  // 历史行为：没有非空 metadata mapping 且没有可用 costMapping 时不启用。
  // override.cost 单独出现不能启用插件，也不能代替 costMapping。
  if (!mapping && !costMapping) {
    console.warn(`[auto-model-config] No mapping configured in ${configPath}`)
    return null
  }

  console.log(`[auto-model-config] Loaded config from ${configPath}`)

  return {
    cacheTTL: typeof raw.cacheTTL === "number" ? raw.cacheTTL : undefined,
    cachePath: raw.cachePath ?? undefined,
    mapping: mapping ?? {},
    costMapping,
    debug: parseDebugConfig(raw.debug),
    override: parseOverrideConfig(raw.override, raw.overrideCost),
  }
}

function parseStringMapping(raw: unknown): Record<string, Record<string, string>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  if (Object.keys(raw).length === 0) return undefined
  return raw as Record<string, Record<string, string>>
}

function parseCostMapping(
  raw: unknown,
  configPath: string,
): Record<string, Record<string, string>> | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`[auto-model-config] Invalid costMapping in ${configPath}`)
    return undefined
  }

  const result: Record<string, Record<string, string>> = {}
  let invalid = 0
  for (const [provider, models] of Object.entries(raw)) {
    if (!models || typeof models !== "object" || Array.isArray(models)) {
      invalid++
      continue
    }
    const entries: Record<string, string> = {}
    for (const [modelId, target] of Object.entries(models)) {
      if (typeof target !== "string" || target.length === 0) {
        invalid++
        continue
      }
      entries[modelId] = target
    }
    if (Object.keys(entries).length > 0) result[provider] = entries
  }

  if (invalid > 0) {
    console.warn(
      `[auto-model-config] Ignored ${invalid} invalid costMapping entr${invalid === 1 ? "y" : "ies"} in ${configPath}`,
    )
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseOverrideConfig(rawOverride: any, rawOverrideCost: any): AutoModelConfig["override"] {
  const cost =
    typeof rawOverride === "object" && rawOverride !== null && typeof rawOverride.cost === "boolean"
      ? rawOverride.cost
      : typeof rawOverrideCost === "boolean"
        ? rawOverrideCost
        : undefined

  if (cost === undefined) {
    return undefined
  }

  return { cost }
}

function parseDebugConfig(raw: any): AutoModelConfig["debug"] {
  if (!raw || typeof raw !== "object" || raw.enabled !== true) {
    return undefined
  }
  return {
    enabled: true,
    dumpPath: typeof raw.dumpPath === "string" ? raw.dumpPath : undefined,
    diffOnly: raw.diffOnly !== undefined ? !!raw.diffOnly : true,
  }
}

export function getMappedProviders(config: AutoModelConfig): string[] {
  return Object.keys(config.mapping)
}

export function getMappingTarget(
  config: AutoModelConfig,
  provider: string,
  modelId: string,
): string | null {
  return config.mapping[provider]?.[modelId] ?? null
}
