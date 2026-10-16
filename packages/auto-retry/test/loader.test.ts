import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/config/loader"
import type { Logger } from "../src/utils/logger"
import { globalConfigPath, globalConfigPaths, projectConfigPath, projectConfigPaths } from "../src/utils/paths"

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-retry-"))
  temps.push(dir)
  return dir
}

function captureLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    debug() {},
    info() {},
    warn(message: string) {
      warnings.push(message)
    },
  }
}

describe("loadConfig", () => {
  it("没有配置文件时不返回任何规则", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules).toEqual([])
  })

  it("解析带注释和尾逗号的 JSONC，并补上默认值", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(homeDir, ".config", "opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      `{
        // 只重试 Gemini 的拦截
        "rules": [
          {
            "models": ["google/*"],
            "errors": ["Provider blocked the response"],
          },
        ],
      }
`,
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules).toEqual([
      {
        models: ["google/*"],
        errors: ["Provider blocked the response"],
        prompt: "继续",
        maxRetries: 3,
        delayMs: 2000,
        resetAfterToolCalls: 10,
        resetAfterMs: 120_000,
      },
    ])
  })

  it("项目 rules 整体替换全局 rules，而不是逐条合并", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const globalFile = path.join(homeDir, ".config", "opencode", "auto-retry.jsonc")
    const projectFile = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(globalFile), { recursive: true })
    await fs.mkdir(path.dirname(projectFile), { recursive: true })
    await fs.writeFile(
      globalFile,
      JSON.stringify({
        rules: [{ models: ["anthropic/*"], errors: ["blocked"] }],
      }),
    )
    await fs.writeFile(
      projectFile,
      JSON.stringify({
        rules: [{ models: ["google/*"], errors: ["Provider blocked the response"], prompt: "请继续" }],
      }),
    )
    // 项目根目录下的同名文件不是配置位置，不能混进来。
    await fs.writeFile(
      path.join(projectDir, "auto-retry.jsonc"),
      JSON.stringify({
        rules: [{ models: ["root/*"], errors: ["nope"] }],
      }),
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules.map((rule) => rule.models)).toEqual([["google/*"]])
    expect(config.rules[0]?.prompt).toBe("请继续")
  })

  it("项目显式给出空 rules 时不再使用全局规则", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const globalFile = path.join(homeDir, ".config", "opencode", "auto-retry.jsonc")
    const projectFile = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(globalFile), { recursive: true })
    await fs.mkdir(path.dirname(projectFile), { recursive: true })
    await fs.writeFile(
      globalFile,
      JSON.stringify({ rules: [{ models: ["google/*"], errors: ["blocked"] }] }),
    )
    await fs.writeFile(projectFile, JSON.stringify({ rules: [] }))

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules).toEqual([])
  })

  it("项目文件没有 rules 键时沿用全局规则", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const globalFile = path.join(homeDir, ".config", "opencode", "auto-retry.jsonc")
    const projectFile = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(globalFile), { recursive: true })
    await fs.mkdir(path.dirname(projectFile), { recursive: true })
    await fs.writeFile(
      globalFile,
      JSON.stringify({ rules: [{ models: ["google/*"], errors: ["blocked"] }] }),
    )
    await fs.writeFile(projectFile, JSON.stringify({ defaults: { maxRetries: 5 } }))

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules).toHaveLength(1)
    expect(config.rules[0]?.maxRetries).toBe(5)
    expect(config.rules[0]?.prompt).toBe("继续")
  })

  it("缺少 models 或 errors 的规则被剔除并记一条警告", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        rules: [
          { errors: ["blocked"] },
          { models: ["google/*"] },
          { models: ["google/*"], errors: ["blocked"], prompt: "留下" },
        ],
      }),
    )
    const logger = captureLogger()

    const config = await loadConfig({ projectDir, homeDir, logger })

    expect(config.rules).toEqual([
      {
        models: ["google/*"],
        errors: ["blocked"],
        prompt: "留下",
        maxRetries: 3,
        delayMs: 2000,
        resetAfterToolCalls: 10,
        resetAfterMs: 120_000,
      },
    ])
    expect(logger.warnings.length).toBe(2)
  })

  it("enabled 为 false 时即使写了规则也不响应", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        enabled: false,
        rules: [{ models: ["google/*"], errors: ["blocked"] }],
      }),
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules).toEqual([])
  })

  it("非法 JSON 不会抛出，而是当成没有这份配置", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{ this is not json")
    const logger = captureLogger()

    const config = await loadConfig({ projectDir, homeDir, logger })

    expect(config.rules).toEqual([])
    expect(logger.warnings.length).toBeGreaterThan(0)
  })

  it("文件里的 defaults 覆盖内置默认值", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        defaults: { prompt: "接着做", maxRetries: 1, delayMs: 0 },
        rules: [{ models: ["google/*"], errors: ["blocked"] }],
      }),
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules[0]).toMatchObject({ prompt: "接着做", maxRetries: 1, delayMs: 0 })
  })

  it("规则上的推进阈值覆盖 defaults，缺省字段沿用 defaults", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        defaults: { resetAfterToolCalls: 4, resetAfterMs: 5_000 },
        rules: [
          { models: ["google/*"], errors: ["blocked"], resetAfterToolCalls: 2 },
          { models: ["anthropic/*"], errors: ["blocked"] },
        ],
      }),
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules[0]).toMatchObject({ resetAfterToolCalls: 2, resetAfterMs: 5_000 })
    expect(config.rules[1]).toMatchObject({ resetAfterToolCalls: 4, resetAfterMs: 5_000 })
  })

  it("非法的推进阈值回退默认值并提示", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        defaults: { resetAfterMs: 0 },
        rules: [{ models: ["google/*"], errors: ["blocked"], resetAfterToolCalls: 1.5, resetAfterMs: -3 }],
      }),
    )
    const logger = captureLogger()

    const config = await loadConfig({ projectDir, homeDir, logger })

    expect(config.rules[0]).toMatchObject({ resetAfterToolCalls: 10, resetAfterMs: 120_000 })
    expect(logger.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it("单路径 helper 仍指向 jsonc，候选列表先 jsonc 再 json", () => {
    const homeDir = path.join("/tmp", "auto-retry-home")
    const projectDir = path.join("/tmp", "auto-retry-project")

    expect(globalConfigPath({ homeDir })).toBe(path.join(homeDir, ".config", "opencode", "auto-retry.jsonc"))
    expect(globalConfigPaths({ homeDir })).toEqual([
      path.join(homeDir, ".config", "opencode", "auto-retry.jsonc"),
      path.join(homeDir, ".config", "opencode", "auto-retry.json"),
    ])
    expect(projectConfigPath(projectDir)).toBe(path.join(projectDir, ".opencode", "auto-retry.jsonc"))
    expect(projectConfigPaths(projectDir)).toEqual([
      path.join(projectDir, ".opencode", "auto-retry.jsonc"),
      path.join(projectDir, ".opencode", "auto-retry.json"),
    ])
  })

  it("目录里只有 auto-retry.json 时可以读到规则", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(homeDir, ".config", "opencode", "auto-retry.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        rules: [{ models: ["google/*"], errors: ["Provider blocked the response"], prompt: "只来自 json" }],
      }),
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules).toHaveLength(1)
    expect(config.rules[0]?.models).toEqual(["google/*"])
    expect(config.rules[0]?.prompt).toBe("只来自 json")
  })

  it("同目录 jsonc 优先，不和 json 合并", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const dir = path.join(projectDir, ".opencode")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "auto-retry.jsonc"),
      JSON.stringify({
        rules: [{ models: ["google/*"], errors: ["blocked"], prompt: "来自 jsonc" }],
      }),
    )
    await fs.writeFile(
      path.join(dir, "auto-retry.json"),
      JSON.stringify({
        enabled: false,
        defaults: { maxRetries: 9, prompt: "来自 json" },
        rules: [{ models: ["anthropic/*"], errors: ["old"], prompt: "来自 json" }],
      }),
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules.map((rule) => rule.models)).toEqual([["google/*"]])
    expect(config.rules[0]?.prompt).toBe("来自 jsonc")
    expect(config.rules[0]?.maxRetries).toBe(3)
  })

  it("项目 json 整体覆盖全局 jsonc 的 rules，defaults 仍按原规则叠", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const globalFile = path.join(homeDir, ".config", "opencode", "auto-retry.jsonc")
    const projectFile = path.join(projectDir, ".opencode", "auto-retry.json")
    await fs.mkdir(path.dirname(globalFile), { recursive: true })
    await fs.mkdir(path.dirname(projectFile), { recursive: true })
    await fs.writeFile(
      globalFile,
      JSON.stringify({
        defaults: { maxRetries: 7, prompt: "全局默认" },
        rules: [{ models: ["anthropic/*"], errors: ["blocked"] }],
      }),
    )
    await fs.writeFile(
      projectFile,
      JSON.stringify({
        rules: [{ models: ["google/*"], errors: ["Provider blocked the response"] }],
      }),
    )
    await fs.writeFile(
      path.join(projectDir, "auto-retry.json"),
      JSON.stringify({
        rules: [{ models: ["root/*"], errors: ["nope"] }],
      }),
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.rules.map((rule) => rule.models)).toEqual([["google/*"]])
    expect(config.rules[0]).toMatchObject({ maxRetries: 7, prompt: "全局默认" })
  })

  it("带 BOM、注释和尾逗号的 JSONC 能解析，字符串里的注释符号原样保留", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const file = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      `\uFEFF{
        // 行注释
        "rules": [
          {
            "models": ["google/*"],
            "errors": ["blocked // not a comment", "keep /* block */", "tail,}"],
            "prompt": "继续 // 原文",
          },
        ],
        /* 块注释
           跨行 */
      }
`,
    )

    const config = await loadConfig({ projectDir, homeDir })

    expect(config.warnings).toEqual([])
    expect(config.rules).toHaveLength(1)
    expect(config.rules[0]?.models).toEqual(["google/*"])
    expect(config.rules[0]?.errors).toEqual(["blocked // not a comment", "keep /* block */", "tail,}"])
    expect(config.rules[0]?.prompt).toBe("继续 // 原文")
  })

  it("坏掉的 jsonc 会警告，且不读取同目录 json，避免旧 rules 生效", async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const globalFile = path.join(homeDir, ".config", "opencode", "auto-retry.jsonc")
    const projectJsonc = path.join(projectDir, ".opencode", "auto-retry.jsonc")
    const projectJson = path.join(projectDir, ".opencode", "auto-retry.json")
    await fs.mkdir(path.dirname(globalFile), { recursive: true })
    await fs.mkdir(path.dirname(projectJsonc), { recursive: true })
    await fs.writeFile(
      globalFile,
      JSON.stringify({
        rules: [{ models: ["global/*"], errors: ["blocked"] }],
      }),
    )
    await fs.writeFile(projectJsonc, "{ this is not json")
    await fs.writeFile(
      projectJson,
      JSON.stringify({
        rules: [{ models: ["stale-project/*"], errors: ["old"] }],
      }),
    )
    const logger = captureLogger()

    const config = await loadConfig({ projectDir, homeDir, logger })

    expect(config.rules.map((rule) => rule.models)).toEqual([["global/*"]])
    expect(logger.warnings).toEqual([expect.stringContaining(projectJsonc)])

    const homeOnly = await tempDir()
    const projectOnly = await tempDir()
    const badGlobal = path.join(homeOnly, ".config", "opencode", "auto-retry.jsonc")
    const staleGlobal = path.join(homeOnly, ".config", "opencode", "auto-retry.json")
    await fs.mkdir(path.dirname(badGlobal), { recursive: true })
    await fs.writeFile(badGlobal, "{ this is not json")
    await fs.writeFile(
      staleGlobal,
      JSON.stringify({
        rules: [{ models: ["stale-global/*"], errors: ["old"] }],
      }),
    )
    const globalLogger = captureLogger()

    const globalConfig = await loadConfig({ projectDir: projectOnly, homeDir: homeOnly, logger: globalLogger })

    expect(globalConfig.rules).toEqual([])
    expect(globalLogger.warnings).toEqual([expect.stringContaining(badGlobal)])
  })
})
