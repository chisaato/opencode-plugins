import path from "node:path"
import os from "node:os"

export interface PathResolutionOptions {
  /** 项目目录（ctx.location.directory）。用于定位项目内的插件配置。 */
  projectDirectory?: string
  /** 显式注入的 HOME（主要用于隔离测试，避免污染宿主真实配置）。 */
  homeDirectory?: string
}

/** 插件自身的 JSON 配置文件名。保留给仍依赖单路径的调用方。 */
export const CONFIG_FILENAME = "skill-filter.json"

/** 同一目录内的配置文件名：jsonc 优先于 json，且只应选用一份。 */
export const CONFIG_FILENAMES = ["skill-filter.jsonc", CONFIG_FILENAME] as const

/**
 * 解析 OpenCode 的全局配置目录。
 * 优先级（由高到低）：
 * 1. options.homeDirectory（显式注入，例如隔离测试）
 * 2. process.env.OPENCODE_TEST_HOME（测试环境变量）
 * 3. process.env.XDG_CONFIG_HOME（存在时取 path.join(XDG_CONFIG_HOME, "opencode")）
 * 4. os.homedir()（回退：~/.config/opencode）
 */
export function getGlobalConfigDir(options?: PathResolutionOptions): string {
  if (options?.homeDirectory) {
    return path.join(options.homeDirectory, ".config", "opencode")
  }

  if (process.env.OPENCODE_TEST_HOME) {
    return path.join(process.env.OPENCODE_TEST_HOME, ".config", "opencode")
  }

  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  }

  return path.join(os.homedir(), ".config", "opencode")
}

/**
 * 全局默认 JSON 配置路径：`~/.config/opencode/skill-filter.json`。
 *
 * 实际搜索请用 `getDefaultConfigPaths`（同目录 jsonc 优先）。
 * 本函数保留为单路径兼容入口。
 */
export function getDefaultConfigPath(options?: PathResolutionOptions): string {
  return path.join(getGlobalConfigDir(options), CONFIG_FILENAME)
}

/**
 * 全局配置候选（同一目录，按优先级）：
 * `skill-filter.jsonc` → `skill-filter.json`。
 *
 * jsonc 存在时不应再读取同目录 json，即使 jsonc 无法解析。
 */
export function getDefaultConfigPaths(options?: PathResolutionOptions): string[] {
  const dir = getGlobalConfigDir(options)
  return CONFIG_FILENAMES.map((name) => path.join(dir, name))
}

/** OpenCode 主配置文件名（按查找优先级）。 */
export const OPENCODE_CONFIG_FILENAMES = ["opencode.jsonc", "opencode.json"] as const

/**
 * 全局 OpenCode 主配置候选路径（按优先级）：
 * `~/.config/opencode/opencode.jsonc` → `~/.config/opencode/opencode.json`。
 *
 * 这是内核读取 `experimental.policies` 的文件，插件据此自动同步 deny policy。
 */
export function getGlobalOpenCodeConfigPaths(options?: PathResolutionOptions): string[] {
  const dir = getGlobalConfigDir(options)
  return OPENCODE_CONFIG_FILENAMES.map((name) => path.join(dir, name))
}

/** 把以 `~` 开头的路径展开为绝对路径；其它路径按 `process.cwd()` 解析。 */
export function resolveUserPath(target: string): string {
  if (target.startsWith("~")) {
    return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", target.slice(1))
  }
  return path.resolve(target)
}

/**
 * 项目配置按目录分组。组顺序与组内顺序都是优先级从高到低。
 *
 * 组顺序：`.opencode/` → 项目根目录。
 * 组内顺序：`skill-filter.jsonc` → `skill-filter.json`。
 *
 * 加载器对每一组只选用一份：jsonc 存在时不读同目录 json。
 * 组与组之间仍是先成功解析先停，解析失败则继续下一组，不跨组做字段合并。
 */
export function getProjectConfigCandidateGroups(projectDirectory: string): string[][] {
  return [
    CONFIG_FILENAMES.map((name) => path.join(projectDirectory, ".opencode", name)),
    CONFIG_FILENAMES.map((name) => path.join(projectDirectory, name)),
  ]
}

/**
 * 项目内候选配置文件路径（按优先级扁平列出）。
 *
 * `.opencode/skill-filter.jsonc` → `.opencode/skill-filter.json`
 * → 项目根 `skill-filter.jsonc` → 项目根 `skill-filter.json`。
 *
 * 扁平列表本身不表达“损坏的 jsonc 不回退同目录 json”；
 * 该规则由 `getProjectConfigCandidateGroups` 的分组承载。
 */
export function getProjectConfigPaths(projectDirectory: string): string[] {
  return getProjectConfigCandidateGroups(projectDirectory).flat()
}
