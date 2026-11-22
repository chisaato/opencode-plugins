import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { createMuxManager, type MuxManagerOptions } from "@misakacloud/opencode-mux-core"
import { createMuxTools, MAX_MUX_INTEGER, type MuxToolDefaults } from "./tools"

export { createMuxTools } from "./tools"
export type { MuxToolDefaults } from "./tools"

type MuxPluginOptions = Pick<MuxManagerOptions,
  "preferred" | "socketName" | "stateDir" | "keepShellOnExit" | "byobuKeys" | "statusTheme"> & MuxToolDefaults
type MuxPluginContext = {
  tool: Pick<Plugin.Context["tool"], "transform">
  location?: { directory?: string }
  options?: unknown
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0") ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_MUX_INTEGER
    ? value : undefined
}

/** 读取内联选项；忽略未知字段与无效值，由工具或核心层提供默认值。 */
export function parseMuxOptions(options: unknown): MuxPluginOptions {
  const values = options && typeof options === "object" ? options as Record<string, unknown> : {}
  return {
    preferred: values.preferred === "tmux" || values.preferred === "psmux" ? values.preferred : undefined,
    socketName: nonEmptyString(values.socketName),
    stateDir: nonEmptyString(values.stateDir),
    keepShellOnExit: typeof values.keepShellOnExit === "boolean" ? values.keepShellOnExit : undefined,
    byobuKeys: typeof values.byobuKeys === "boolean" ? values.byobuKeys : undefined,
    statusTheme: values.statusTheme === "powerline" || values.statusTheme === "ascii" || values.statusTheme === "off"
      ? values.statusTheme : undefined,
    defaultTimeoutMs: nonNegativeInteger(values.defaultTimeoutMs),
    defaultTailLines: nonNegativeInteger(values.defaultTailLines),
  }
}

/** 注册工具时不启动复用器；首次执行工具时由核心层探测可用后端。 */
export const MuxPlugin = {
  id: "opencode-mux",
  async setup(ctx: MuxPluginContext) {
    const cwd = resolve(ctx.location?.directory ?? process.cwd())
    const { preferred, socketName, stateDir, keepShellOnExit, byobuKeys, statusTheme, ...defaults } = parseMuxOptions(ctx.options)
    const manager = createMuxManager({
      preferred, socketName, stateDir: stateDir && resolve(cwd, stateDir), keepShellOnExit, byobuKeys, statusTheme,
    })
    const tools = createMuxTools(manager, cwd, defaults)

    await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        if (!editor.list().some((entry) => entry.name === tool.name)) editor.add(tool)
      }
    })
  },
} satisfies Plugin.Plugin

export default MuxPlugin
