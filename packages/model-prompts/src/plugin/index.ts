import fs from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import { loadConfig, type ResolvedConfig } from "../config/loader"
import { collectPromptPaths, resolvePromptPath } from "../match"
import { createLogger } from "../utils/logger"

type Fingerprint = string

interface Snapshot {
  config: ResolvedConfig
  stamps: ReadonlyMap<string, Fingerprint>
  contents: ReadonlyMap<string, string | undefined>
}

async function fingerprint(file: string): Promise<Fingerprint> {
  try {
    const stat = await fs.stat(file, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    return `error:${String(error)}`
  }
}

async function changed(previous: ReadonlyMap<string, Fingerprint>): Promise<boolean> {
  for (const [file, value] of previous) if (await fingerprint(file) !== value) return true
  return false
}

export const ModelPromptsPlugin = Plugin.define({
  id: "opencode-model-prompts",
  async setup(ctx) {
    const projectDirectory = ctx.location?.directory ?? process.cwd()
    const inline = ctx.options as Record<string, unknown> | undefined
    const logger = createLogger(inline?.debug === true)
    const injected = new WeakSet<object>()
    let current: Snapshot | undefined
    let refreshing: Promise<Snapshot | undefined> | undefined
    let dirty = false
    let agentList: unknown

    async function readSnapshot(): Promise<Snapshot | undefined> {
      const stamps = new Map<string, Fingerprint>()
      const contents = new Map<string, string | undefined>()
      const warnings: Parameters<typeof logger.warn>[] = []
      const pendingLogger = { ...logger, warn: (...args: Parameters<typeof logger.warn>) => { warnings.push(args) } }
      let inconsistent = false

      async function observe(file: string): Promise<Fingerprint> {
        const known = stamps.get(file)
        if (known !== undefined) return known
        const stamp = await fingerprint(file)
        stamps.set(file, stamp)
        return stamp
      }

      async function readText(file: string): Promise<string> {
        const before = await observe(file)
        try {
          const text = await fs.readFile(file, "utf8")
          if (before === "missing") inconsistent = true
          return text
        } catch (error) {
          if (before !== "missing" && (error as NodeJS.ErrnoException).code === "ENOENT") inconsistent = true
          throw error
        }
      }

      const config = await loadConfig({ projectDirectory, inline, logger: pendingLogger }, readText)
      for (const file of config.candidates) await observe(file)
      const rules: ResolvedConfig["rules"] = []
      for (const rule of config.rules) {
        const prompts: string[] = []
        for (const entry of rule.prompts) {
          // 回退判定与指纹使用同一次探测，也监测当前不存在的本地候选。
          const file = await resolvePromptPath(entry, rule, config.globalPromptsDir, async (local) => await observe(local) === "missing")
          prompts.push(file)
          if (contents.has(file)) continue
          try {
            contents.set(file, (await readText(file)).replace(/^\uFEFF/, "").trim())
          } catch (error) {
            contents.set(file, undefined)
            pendingLogger.warn(`无法读取提示词 ${file}：${String(error)}`)
          }
        }
        // 快照保存已解析的绝对路径，hook 不再根据实时文件状态重新判定回退。
        rules.push({ ...rule, prompts })
      }
      if (inconsistent || await changed(stamps)) return
      for (const args of warnings) logger.warn(...args)
      return { config: { ...config, rules }, stamps, contents }
    }

    function refresh(): Promise<Snapshot | undefined> {
      return refreshing ??= (async () => {
        if (current && !dirty && !await changed(current.stamps)) return current
        for (let attempt = 0; attempt < 3; attempt++) {
          const next = await readSnapshot()
          if (!next) continue
          dirty = false
          return current = next
        }
        // 保存尚未稳定时继续使用上一份完整快照，下次 hook 再试。
        dirty = true
        return current
      })().finally(() => { refreshing = undefined })
    }
    // 启动即验证全部路径，避免首条会话才发现缺失文件。
    await refresh()

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
      const snapshot = await refresh()
      if (!snapshot) return
      const { config, contents } = snapshot
      const paths = await collectPromptPaths(config.rules, {
        model: input.model,
        agent: input.agent,
        agents: await agentIdentifiers(input.agent),
        tools: input.tools,
      }, config.globalPromptsDir)
      // 复用同一 system 时，只替换本插件曾注入的对象，不比较正文。
      for (let index = input.system.length - 1; index >= 0; index--) {
        if (injected.has(input.system[index])) input.system.splice(index, 1)
      }
      for (const file of paths) {
        const text = contents.get(file)
        if (!text) continue
        const part = { type: "text" as const, text }
        injected.add(part)
        input.system.push(part)
      }
    })
    return async () => {
      await registration?.dispose()
    }
  },
})

export default ModelPromptsPlugin
