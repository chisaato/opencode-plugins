import fs from "node:fs/promises"
import path from "node:path"
import type {
  AutoModelConfig,
  ResolvedModel,
} from "../types"
import { getDefaultDumpPath, type PathResolutionOptions } from "../utils/paths"

export interface ConfigDumperOptions extends NonNullable<AutoModelConfig["debug"]>, PathResolutionOptions {}

export interface EnhancedModelResult {
  source: string
  filledFields: string[]
  warning?: string
  skipped?: boolean
  model?: Record<string, any>
}

export class ConfigDumper {
  private config: NonNullable<AutoModelConfig["debug"]>
  private dumpPath: string

  constructor(options: ConfigDumperOptions) {
    this.config = options
    this.dumpPath = options.dumpPath || getDefaultDumpPath(options)
  }

  /**
   * V2 输出：仅输出模型增强差异或完整结果，不依赖 V1 config。
   * 支持 diffOnly 配置。
   */
  async dumpV2(
    enhancedModels: Record<string, Record<string, EnhancedModelResult>>,
    resolvedModels: Map<string, Map<string, ResolvedModel>>,
    cacheAge: number,
  ): Promise<void> {
    const diffOnly = this.config.diffOnly !== false
    const meta = this.buildMeta(enhancedModels, resolvedModels, cacheAge)
    const output: Record<string, any> = {
      _meta: meta,
      provider: {},
    }

    for (const [providerKey, models] of Object.entries(enhancedModels)) {
      output.provider[providerKey] = { models: {} }

      for (const [modelId, res] of Object.entries(models)) {
        const entry: Record<string, any> = {
          _source: res.source,
          _filled: res.filledFields,
        }

        if (res.warning) {
          entry._warning = res.warning
        } else if (res.skipped) {
          entry._skipped = true
        } else if (res.model) {
          if (diffOnly) {
            // 仅输出实际被自动填充的字段
            for (const field of res.filledFields) {
              if (field in res.model) {
                entry[field] = res.model[field]
              }
            }
          } else {
            // 完整输出当前 model 字段
            Object.assign(entry, res.model)
          }
        }

        output.provider[providerKey].models[modelId] = entry
      }
    }

    await fs.mkdir(path.dirname(this.dumpPath), { recursive: true })
    await fs.writeFile(
      this.dumpPath,
      JSON.stringify(output, null, 2),
      "utf-8",
    )
    console.log(`[auto-model-config] Debug dump written to: ${this.dumpPath}`)
  }

  private buildMeta(
    enhancedModels: Record<string, Record<string, EnhancedModelResult>>,
    resolvedModels: Map<string, Map<string, ResolvedModel>>,
    cacheAge: number,
  ): Record<string, any> {
    let modelsFilled = 0
    let modelsNotFound = 0
    let modelsSkipped = 0
    const mappingsUsed: Record<string, string> = {}

    for (const [providerKey, models] of Object.entries(enhancedModels)) {
      for (const [modelId, res] of Object.entries(models)) {
        mappingsUsed[`${providerKey}/${modelId}`] = res.source
        if (res.warning) {
          modelsNotFound++
        } else if (res.skipped) {
          modelsSkipped++
        } else if (res.filledFields.length > 0) {
          modelsFilled++
        }
      }
    }

    return {
      plugin: "@misakacloud/opencode-auto-model-config",
      timestamp: new Date().toISOString(),
      modelsDevCacheAge: cacheAge,
      summary: {
        providersProcessed: Object.keys(enhancedModels).length,
        modelsFilled,
        modelsNotFound,
        modelsSkipped,
        mappingsUsed,
      },
    }
  }
}
