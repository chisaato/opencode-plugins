import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadConfig } from "../src/mapping/parser"
import { parseJsonc } from "../src/mapping/jsonc"

const specialJsonc = [
  "{",
  "  // line comment with , } and /*",
  '  "mapping": {',
  '    "p//k": {',
  '      "m/*x*/": "vendor/model//extra",',
  '      "brace": "keep,}",',
  '      "url": "http:\\/\\/example.com//a/*b*/",',
  '      "quote": "say \\"hi\\" \\\\ // still",',
  "    },",
  "  },",
  "  /* block",
  "     comment , } */",
  '  "cacheTTL": 7,',
  "}",
].join("\n")

const specialParsed = {
  mapping: {
    "p//k": {
      "m/*x*/": "vendor/model//extra",
      brace: "keep,}",
      url: "http://example.com//a/*b*/",
      quote: 'say "hi" \\ // still',
    },
  },
  cacheTTL: 7,
}

function commented(provider: string): string {
  return `{
    // ${provider}
    "mapping": { "${provider}": { "m": "vendor/model", }, },
  }
`
}

describe("parseJsonc", () => {
  it("parses comments, trailing commas, and a leading BOM", () => {
    const text = `{
      // leading
      "a": 1,
      "b": [2, 3,],
    } /* trailing */
`
    expect(parseJsonc(text)).toEqual({ a: 1, b: [2, 3] })
    expect(parseJsonc(`\uFEFF${text}`)).toEqual({ a: 1, b: [2, 3] })
  })

  it("keeps comment markers, commas, and braces inside strings", () => {
    expect(parseJsonc(specialJsonc)).toEqual(specialParsed)
    expect(parseJsonc(`\uFEFF${specialJsonc}`)).toEqual(specialParsed)
    const withBomInString = '{ "a": "\uFEFFhttp://x/*y*/,}" }'
    expect(parseJsonc(withBomInString)).toEqual({ a: "\uFEFFhttp://x/*y*/,}" })
  })

  it("throws on syntactically invalid jsonc", () => {
    expect(() => parseJsonc("{ this is not valid")).toThrow()
  })
})

describe("loadConfig JSONC search order", () => {
  const testRoot = path.join(os.tmpdir(), `oc-amc-jsonc-${process.pid}-${Date.now()}`)
  const fakeHome = path.join(testRoot, "home")
  const projectDir = path.join(testRoot, "project")
  const globalDir = path.join(fakeHome, ".config", "opencode")
  const projectJsonc = path.join(projectDir, "oc-auto-model-config.jsonc")
  const projectJson = path.join(projectDir, "oc-auto-model-config.json")

  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await fs.mkdir(fakeHome, { recursive: true })
    await fs.mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  async function writeConfig(dir: string, ext: "json" | "jsonc", contents: string | Buffer): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `oc-auto-model-config.${ext}`), contents)
  }

  function load() {
    return loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
  }

  function warnings(): string[] {
    return warnSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" "))
  }

  it("loads strict json, including special characters inside strings", async () => {
    const payload = {
      mapping: { plain: { m: "openai/gpt-4o", note: "keep // /* ,}" } },
      cacheTTL: 10,
      costMapping: { "claude-code": { "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6" } },
    }
    await writeConfig(projectDir, "json", JSON.stringify(payload))

    const result = await load()
    expect(result).toMatchObject(payload)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("loads jsonc with comments, trailing commas, and a UTF-8 BOM", async () => {
    const text = commented("from-jsonc")
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])
    await writeConfig(projectDir, "jsonc", bytes)

    const result = await load()
    expect(result).not.toBeNull()
    expect(result!.mapping["from-jsonc"]!.m).toBe("vendor/model")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("preserves comment-like characters inside jsonc strings", async () => {
    await writeConfig(projectDir, "jsonc", specialJsonc)

    const result = await load()
    expect(result).not.toBeNull()
    expect(result!.mapping).toEqual(specialParsed.mapping)
    expect(result!.cacheTTL).toBe(7)
  })

  it("prefers jsonc over json in the same directory", async () => {
    await writeConfig(projectDir, "jsonc", commented("from-jsonc"))
    await writeConfig(projectDir, "json", JSON.stringify({ mapping: { "from-json": { m: "vendor/json" } } }))
    await writeConfig(globalDir, "jsonc", commented("from-global-jsonc"))

    const result = await load()
    expect(result!.mapping["from-jsonc"]).toBeDefined()
    expect(result!.mapping["from-json"]).toBeUndefined()
    expect(result!.mapping["from-global-jsonc"]).toBeUndefined()
    expect(logSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).some((message: string) => message.includes(projectJsonc))).toBe(true)
  })

  it("prefers project json over global jsonc when the project jsonc is absent", async () => {
    await writeConfig(projectDir, "json", JSON.stringify({ mapping: { "project-json": { m: "vendor/json" } } }))
    await writeConfig(globalDir, "jsonc", commented("global-jsonc"))
    await writeConfig(globalDir, "json", JSON.stringify({ mapping: { "global-json": { m: "vendor/global" } } }))

    const result = await load()
    expect(result!.mapping["project-json"]).toBeDefined()
    expect(result!.mapping["global-jsonc"]).toBeUndefined()
    expect(result!.mapping["global-json"]).toBeUndefined()
  })

  it("does not read same-directory json when jsonc is syntactically invalid, but falls back to the next directory", async () => {
    await writeConfig(projectDir, "jsonc", "{ this is not valid")
    await writeConfig(projectDir, "json", JSON.stringify({ mapping: { "project-json": { m: "vendor/json" } } }))
    await writeConfig(globalDir, "jsonc", commented("global-jsonc"))
    await writeConfig(globalDir, "json", JSON.stringify({ mapping: { "global-json": { m: "vendor/global" } } }))

    const result = await load()
    expect(result!.mapping["global-jsonc"]).toBeDefined()
    expect(result!.mapping["project-json"]).toBeUndefined()
    expect(result!.mapping["global-json"]).toBeUndefined()
    expect(warnings().some((message) => message.includes(projectJsonc))).toBe(true)
    expect(warnings().some((message) => message.includes(`${projectJson}:`))).toBe(false)
  })

  it("returns null when invalid jsonc has no later directory to fall back to", async () => {
    await writeConfig(projectDir, "jsonc", "{ this is not valid")
    await writeConfig(projectDir, "json", JSON.stringify({ mapping: { "project-json": { m: "vendor/json" } } }))

    expect(await load()).toBeNull()
    expect(warnings().some((message) => message.includes(projectJsonc))).toBe(true)
    expect(warnings().some((message) => message.includes(`${projectJson}:`))).toBe(false)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("does not fall back from a semantically empty jsonc to another file", async () => {
    await writeConfig(projectDir, "jsonc", '{ "mapping": {} }')
    await writeConfig(projectDir, "json", JSON.stringify({ mapping: { "project-json": { m: "vendor/json" } } }))
    await writeConfig(globalDir, "jsonc", commented("global-jsonc"))

    expect(await load()).toBeNull()
    expect(warnings().some((message) => message.includes("No mapping configured") && message.includes(projectJsonc))).toBe(true)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("falls back to global jsonc when the project directory has no config", async () => {
    await writeConfig(globalDir, "jsonc", commented("global-jsonc"))
    await writeConfig(globalDir, "json", JSON.stringify({ mapping: { "global-json": { m: "vendor/global" } } }))

    const result = await load()
    expect(result!.mapping["global-jsonc"]).toBeDefined()
    expect(result!.mapping["global-json"]).toBeUndefined()
  })

  it("falls back to global json when project files and global jsonc are absent", async () => {
    await writeConfig(globalDir, "json", JSON.stringify({ mapping: { "global-json": { m: "vendor/global" } } }))

    const result = await load()
    expect(result!.mapping["global-json"]).toBeDefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("returns null and does not warn when every candidate is missing", async () => {
    expect(await load()).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("keeps valid costMapping entries and ignores invalid ones in jsonc", async () => {
    await writeConfig(
      projectDir,
      "jsonc",
      `{
        "costMapping": {
          "p": { "good": "a/b", "bad": "", },
        },
      }`,
    )

    const result = await load()
    expect(result).not.toBeNull()
    expect(result!.mapping).toEqual({})
    expect(result!.costMapping).toEqual({ p: { good: "a/b" } })
    expect(warnings().some((message) => message.includes("invalid costMapping"))).toBe(true)
  })
})
