import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadConfig, getMappedProviders, getMappingTarget } from "../src/mapping/parser"
import type { AutoModelConfig } from "../src/types"

describe("loadConfig", () => {
  const tmpDir = path.join(os.tmpdir(), "oc-test-" + Date.now())
  const fakeHome = path.join(tmpDir, "fakehome")
  const projectDir = path.join(tmpDir, "project")

  beforeEach(async () => {
    await fs.mkdir(fakeHome, { recursive: true })
    await fs.mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("returns null when no config file exists in isolated directories", async () => {
    expect(await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })).toBeNull()
  })

  it("loads config from project directory", async () => {
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({ mapping: { "misaka-newapi": { "gpt-5.4": "opencode-go/gpt-5.4" } } }),
    )
    const result = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
    expect(result).not.toBeNull()
    expect(result!.mapping["misaka-newapi"]["gpt-5.4"]).toBe("opencode-go/gpt-5.4")
  })

  it("returns null when config has empty mapping", async () => {
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({ mapping: {} }),
    )
    expect(await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })).toBeNull()
  })

  it("parses cacheTTL and debug options", async () => {
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({
        mapping: { p: { m: "t/m" } },
        cacheTTL: 3600,
        debug: { enabled: true, dumpPath: "/tmp/dump.json", diffOnly: false },
      }),
    )
    const result = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
    expect(result!.cacheTTL).toBe(3600)
    expect(result!.debug).toEqual({ enabled: true, dumpPath: "/tmp/dump.json", diffOnly: false })
  })

  it("debug is undefined when not enabled", async () => {
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({ mapping: { p: { m: "t/m" } }, debug: { enabled: false } }),
    )
    const result = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
    expect(result!.debug).toBeUndefined()
  })

  it("parses override config correctly", async () => {
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({
        mapping: { p: { m: "t/m" } },
        override: { cost: true },
      }),
    )
    const result = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
    expect(result!.override).toEqual({ cost: true })
  })

  it("parses top-level overrideCost fallback correctly", async () => {
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({
        mapping: { p: { m: "t/m" } },
        overrideCost: true,
      }),
    )
    const result = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
    expect(result!.override).toEqual({ cost: true })
  })
})

describe("getMappedProviders", () => {
  it("returns provider names from mapping", () => {
    const config: AutoModelConfig = {
      mapping: { openai: { "gpt-4o": "openai/gpt-4o" }, anthropic: { "claude-3": "anthropic/claude-3" } },
    }
    expect(getMappedProviders(config)).toEqual(["openai", "anthropic"])
  })
})

describe("getMappingTarget", () => {
  const config: AutoModelConfig = { mapping: { openai: { "gpt-4o": "openai/gpt-4o" } } }

  it("returns mapping target", () => {
    expect(getMappingTarget(config, "openai", "gpt-4o")).toBe("openai/gpt-4o")
  })

  it("returns null for unmapped model", () => {
    expect(getMappingTarget(config, "openai", "gpt-3")).toBeNull()
    expect(getMappingTarget(config, "unknown", "gpt-4o")).toBeNull()
  })
})
