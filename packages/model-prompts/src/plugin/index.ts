import fs from "node:fs/promises"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { loadConfig, type ResolvedConfig } from "../config/loader"
import { collectPromptPaths, resolvePromptPath } from "../match"
import { createLogger } from "../utils/logger"

type Fingerprint = string

async function fingerprint(file: string): Promise<Fingerprint> {
  try {
    const stat = await fs.stat(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    return `error:${String(error)}`
  }
}

/** 配置候选与已解析提示词的文件指纹；新建、删除和修改都触发重新加载。 */
async function snapshot(files: Iterable<string>): Promise<Map<string, Fingerprint>> {
  const entries = await Promise.all([...files].map(async (file) => [file, await fingerprint(file)] as const))
  return new Map(entries)
}

async function changed(previous: Map<string, Fingerprint>): Promise<boolean> {
  for (const [file, value] of previous) if (await fingerprint(file) !== value) return true
  return false
}

export const ModelPromptsPlugin = Plugin.define({
  id: "opencode-model-prompts",
  async setup(ctx) {
    const projectDirectory = ctx.location?.directory ?? process.cwd()
    const inline = ctx.options as Record<string, unknown> | undefined
    const logger = createLogger(inline?.debug === true)
    const options = { projectDirectory, inline, logger }
    let config: ResolvedConfig = await loadConfig(options)
    let tracked = new Set(config.candidates)
    let stamps = new Map<string, Fingerprint>()
    let contents = new Map<string, string>()
    let agentList: unknown

    /** 启动即验证全部路径，避免首条会话才发现缺失文件。 */
    async function validate(): Promise<void> {
      const next = new Map<string, string>()
      for (const rule of config.rules) {
        for (const entry of rule.prompts) {
          // 回退全局文件时，也监测本地候选：本地文件新建后必须覆盖全局。
          if (!entry.startsWith("~/") && !path.isAbsolute(entry) && !entry.startsWith("./") && !entry.startsWith("../")) {
            tracked.add(path.resolve(rule.promptsDir, entry))
          }
          const file = await resolvePromptPath(entry, rule, config.globalPromptsDir)
          tracked.add(file)
          try {
            next.set(file, (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "").trim())
          } catch (error) {
            logger.warn(`Failed to read prompt at ${file}: ${String(error)}`)
          }
        }
      }
      contents = next
      stamps = await snapshot(tracked)
    }
    await validate()

    async function agentIdentifiers(agent: string | undefined): Promise<string[]> {
      if (!agent || !ctx.agent) return []
      const identifiers: string[] = []
      const collect = (value: unknown) => {
        if (!value || typeof value !== "object") return
        const info = value as { id?: unknown; name?: unknown }
        if (typeof info.id === "string") identifiers.push(info.id)
        if (typeof info.name === "string") identifiers.push(info.name)
      }
      try {
        const response = await ctx.agent.get({ agentID: agent })
        collect(response?.data)
      } catch {
        // 宿主可能没有公开该代理；回退到 list，不影响提示词注入。
      }
      if (identifiers.length === 0) {
        try {
          agentList ??= (await ctx.agent.list())?.data
          if (Array.isArray(agentList)) {
            for (const info of agentList) {
              if (info?.id === agent || info?.name === agent) collect(info)
            }
          }
        } catch {
          // 不要求代理查询必须成功。
        }
      }
      return identifiers
    }

    const registration = await ctx.session.hook("context", async (input) => {
      if (await changed(stamps)) {
        config = await loadConfig(options)
        tracked = new Set(config.candidates)
        await validate()
      }
      const paths = await collectPromptPaths(config.rules, {
        model: input.model,
        agent: input.agent,
        agents: await agentIdentifiers(input.agent),
        tools: input.tools,
      }, config.globalPromptsDir)
      for (const file of paths) {
        const text = contents.get(file)
        if (text && !input.system.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.includes(text))) {
          input.system.push({ type: "text", text })
        }
      }
    })
    return async () => {
      await registration?.dispose()
    }
  },
})

export default ModelPromptsPlugin
