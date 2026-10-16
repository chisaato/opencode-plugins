// opencode-auto-model-config 插件的共享类型

/**
 * models.dev API 顶层响应（按 provider ID 索引）
 */
export interface ModelsDevData {
  [providerId: string]: ModelsDevProvider
}

/**
 * models.dev 中的 provider 条目
 */
export interface ModelsDevProvider {
  id: string
  name: string
  npm: string
  env: string[]
  api?: string
  doc?: string
  models: Record<string, ModelsDevModel>
}

/**
 * models.dev 中的单个模型条目
 */
export interface ModelsDevModel {
  id: string
  name: string
  family?: string
  attachment: boolean
  reasoning: boolean
  tool_call: boolean
  structured_output?: boolean
  temperature?: boolean
  knowledge?: string
  release_date: string
  last_updated: string
  modalities: {
    input: string[]
    output: string[]
  }
  open_weights: boolean
  cost?: ModelsDevCost
  limit: {
    context: number
    input?: number
    output: number
  }
  interleaved?: boolean | { field: string }
  status?: string
  provider?: string
  experimental?: boolean
}

export interface ModelsDevCost {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
  context_over_200k?: {
    input: number
    output: number
    cache_read?: number
  }
}

/**
 * 插件配置（来自 oc-auto-model-config.json）
 */
export interface AutoModelConfig {
  /** 缓存 TTL，单位为秒（默认：86400 = 24 小时） */
  cacheTTL?: number
  /** 自定义缓存路径；null/未设置时使用 XDG 配置目录下的 models-dev.json */
  cachePath?: string | null
  /** 映射关系：provider -> { modelId -> "modelsdev-provider/modelsdev-modelId" } */
  mapping: Record<string, Record<string, string>>
  /** 调试模式配置 */
  debug?: DebugConfig
  /** 覆盖行为配置 */
  override?: OverrideConfig
}

/**
 * 字段强制覆盖配置
 */
export interface OverrideConfig {
  /** 是否强行覆盖模型价格（即使用户或宿主已显式设置 cost） */
  cost?: boolean
}

/**
 * 调试模式配置
 */
export interface DebugConfig {
  /** 启用调试输出 */
  enabled: boolean
  /** 输出文件路径（默认：XDG 配置目录下的 expanded-config.json） */
  dumpPath?: string
  /** 仅输出变更的字段（默认：true） */
  diffOnly?: boolean
}

/**
 * 单个模型映射的解析结果
 */
export interface ResolvedModel {
  /** models.dev 中的数据源（如 "opencode-go/gpt-5.4"） */
  source: string
  /** 完整的 models.dev 模型数据 */
  modelData: ModelsDevModel
  /** 需要填充到 OpenCode V2 模型元数据中的字段 */
  filledFields: string[]
  /** 警告信息（如有） */
  warning?: string
}
