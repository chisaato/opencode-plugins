// opencode-skill-filter 插件共享类型

/**
 * 插件配置。
 *
 * 同时用于两处来源：
 * - `opencode.jsonc` 中 plugin options（内联传参）
 * - `skill-filter.json` 配置文件
 *
 * 动作分两层：
 * - `remove` 硬剔除：调用 `editor.remove(id)`，把 skill 从运行时注册表彻底拔除。
 * - `hide` 软隐藏：保留注册，仅设 `autoinvoke = false`（仍可 `@name` 手动调用）。
 * - `enable` 显式激活：保证不被 remove / hide，并设 `autoinvoke = true`。
 *
 * 优先级：`enable` > `remove` > `hide` > 默认保持。
 */
export interface SkillFilterConfig {
  /**
   * 需要**彻底移除**的 skill 名称 / glob。
   *
   * 命中的 skill 会通过 `editor.remove(id)` 从 OpenCode 运行时注册表中拔除，
   * 从而在模型 Prompt、补全、API 中完全消失。改回配置即可无损复原。
   */
  remove?: string[]

  /**
   * 需要**软隐藏**的 skill 名称 / glob。
   *
   * 命中的 skill 会被设置 `autoinvoke = false`，从而不出现在模型的
   * available_skills 列表中，但仍可通过 `@name` 主动调用。
   */
  hide?: string[]

  /**
   * 需要**显式激活**的 skill 名称 / glob（优先级最高）。
   *
   * 命中的 skill 保证不被 remove / hide，且 `autoinvoke` 会被设为 `true`。
   */
  enable?: string[]

  /**
   * @deprecated `enable` 的旧版别名，等价映射为 `enable`（显式激活）。
   */
  unhide?: string[]

  /**
   * 全局配置内的目录级 override。
   *
   * 键为针对当前项目目录（完整路径或仓库名）的 glob，命中时把对应配置
   * 合并进当前规则。例如用通配符命中仓库名 `my-paseo-project` 的目录。
   */
  overrides?: Record<string, SkillFilterConfig>

  /** 高级过滤规则（include 收窄作用范围，exclude 排除干扰项）。 */
  patterns?: SkillPatterns

  /**
   * @deprecated `enable` 现在总会被主动设为 `autoinvoke = true`，此字段保留仅用于兼容旧配置。
   */
  restoreUnhidden?: boolean

  /** 是否输出调试日志（默认 true，走 `console.debug`，不影响正常输出）。 */
  debug?: boolean

  /**
   * 是否注册 `skills_list` 自定义工具（默认 true）。
   *
   * 关闭后插件只做 skill 过滤，不向工具域暴露查询工具。
   */
  exposeTool?: boolean

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

  /** 永不处理这些 skill（优先级低于 `enable`，高于 `remove` / `hide`）。 */
  exclude?: string[]
}

/** 归一化后的规则：无空值、已去重、字段必填。 */
export interface NormalizedRules {
  /** 命中后硬剔除（editor.remove）。 */
  remove: string[]
  /** 命中后软隐藏（autoinvoke = false）。 */
  hide: string[]
  /** 命中后显式激活（autoinvoke = true，且压过 remove / hide）。 */
  enable: string[]
  /** 作用范围门槛：非空时只有命中的 skill 才会被处理。 */
  include: string[]
  /** 排除项：命中的 skill 完全不处理。 */
  exclude: string[]
}
