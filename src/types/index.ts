// opencode-skill-filter 插件共享类型

/**
 * 插件配置。
 *
 * 同时用于两处来源：
 * - `opencode.jsonc` 中 plugin options（内联传参）
 * - `skill-filter.json` 配置文件
 */
export interface SkillFilterConfig {
  /**
   * 需要隐藏的 skill 名称 / glob 规则。
   *
   * 命中的 skill 会被设置 `autoinvoke = false`，从而不出现在模型的
   * available_skills 列表中，但仍可通过 `@name` 主动调用。
   */
  hide?: string[]

  /**
   * 白名单：命中的 skill 永不被隐藏（优先级高于 `hide`）。
   *
   * 若同时开启 `restoreUnhidden`，命中项还会被主动设置 `autoinvoke = true`。
   */
  unhide?: string[]

  /** 高级过滤规则（include 收窄作用范围，exclude 排除干扰项）。 */
  patterns?: SkillPatterns

  /** 是否对命中 `unhide` 的 skill 主动把 `autoinvoke` 设为 true（默认 false）。 */
  restoreUnhidden?: boolean

  /** 是否输出调试日志（默认 true，走 `console.debug`，不影响正常输出）。 */
  debug?: boolean

  /**
   * 显式指定配置文件路径。
   * - 字符串：直接读取该文件，跳过默认搜索顺序
   * - `false`：完全跳过文件加载（仅使用内联 options）
   */
  configPath?: string | false
}

/** 高级过滤规则 */
export interface SkillPatterns {
  /**
   * 只有命中这些规则的 skill 才会被纳入过滤（为空表示不限制）。
   * 用于把插件作用范围收窄到某几个前缀。
   */
  include?: string[]

  /** 永不处理这些 skill（优先级低于 `unhide`，高于 `hide`）。 */
  exclude?: string[]
}

/** 归一化后的规则：无空值、已去重、字段必填。 */
export interface NormalizedRules {
  hide: string[]
  unhide: string[]
  include: string[]
  exclude: string[]
  restoreUnhidden: boolean
}
