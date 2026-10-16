import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadConfig } from "../src/mapping/parser"

describe("V2 parser directory isolation & search order", () => {
  const testRoot = path.join(os.tmpdir(), "oc-parser-test-" + Date.now())
  const fakeHome = path.join(testRoot, "home")
  const projectDir = path.join(testRoot, "project")

  beforeEach(async () => {
    await fs.mkdir(fakeHome, { recursive: true })
    await fs.mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  it("prioritizes project directory over global directory", async () => {
    const globalConfigDir = path.join(fakeHome, ".config", "opencode")
    await fs.mkdir(globalConfigDir, { recursive: true })
    await fs.writeFile(
      path.join(globalConfigDir, "oc-auto-model-config.json"),
      JSON.stringify({ mapping: { "provider-global": { "model-g": "vendor/model-g" } } }),
    )

    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({ mapping: { "provider-project": { "model-p": "vendor/model-p" } } }),
    )

    const config = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
    expect(config).not.toBeNull()
    expect(config!.mapping["provider-project"]).toBeDefined()
    expect(config!.mapping["provider-global"]).toBeUndefined()
  })

  it("falls back to global directory when project has no config", async () => {
    const globalConfigDir = path.join(fakeHome, ".config", "opencode")
    await fs.mkdir(globalConfigDir, { recursive: true })
    await fs.writeFile(
      path.join(globalConfigDir, "oc-auto-model-config.json"),
      JSON.stringify({ mapping: { "provider-global": { "model-g": "vendor/model-g" } } }),
    )

    const config = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
    expect(config).not.toBeNull()
    expect(config!.mapping["provider-global"]).toBeDefined()
  })

  it("logs a diagnosable warning for malformed project config and still falls back to global", async () => {
    const projectConfigPath = path.join(projectDir, "oc-auto-model-config.json")
    await fs.writeFile(projectConfigPath, "{ this is not valid json")

    const globalConfigDir = path.join(fakeHome, ".config", "opencode")
    await fs.mkdir(globalConfigDir, { recursive: true })
    await fs.writeFile(
      path.join(globalConfigDir, "oc-auto-model-config.json"),
      JSON.stringify({ mapping: { "provider-global": { "model-g": "vendor/model-g" } } }),
    )

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const config = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
      expect(config).not.toBeNull()
      expect(config!.mapping["provider-global"]).toBeDefined()

      const messages = warnSpy.mock.calls.map((call) => call.join(" "))
      expect(messages.some((m) => m.includes(projectConfigPath))).toBe(true)
      expect(messages.some((m) => m.toLowerCase().includes("json"))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("does not warn about a simply absent config file", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const config = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
      expect(config).toBeNull()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("returns null when isolated fakeHome and projectDir have no config, and does not leak real HOME", async () => {
    const config = await loadConfig({ projectDirectory: projectDir, homeDirectory: fakeHome })
    expect(config).toBeNull()
  })
})
