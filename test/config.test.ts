import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadConfig } from "../src/config/loader"

describe("loadConfig", () => {
  let root: string
  let projectDir: string
  let home: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-filter-config-"))
    projectDir = path.join(root, "project")
    home = path.join(root, "home")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  async function writeProjectConfig(contents: unknown, relative = ".opencode/skill-filter.json") {
    const target = path.join(projectDir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify(contents))
    return target
  }

  it("loads project .opencode/skill-filter.json with highest priority", async () => {
    const configPath = await writeProjectConfig({
      hide: ["ask-matt", "to-*"],
      unhide: ["to-spec"],
      patterns: { exclude: ["to-keep"] },
    })
    // A global config exists too, but the project one should win.
    await fs.writeFile(
      path.join(home, ".config", "opencode", "skill-filter.json"),
      JSON.stringify({ hide: ["global-only"] }),
    )

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })

    expect(resolved.rules.hide).toEqual(["ask-matt", "to-*"])
    expect(resolved.rules.unhide).toEqual(["to-spec"])
    expect(resolved.rules.exclude).toEqual(["to-keep"])
    expect(resolved.sources).toContain(configPath)
  })

  it("falls back to the global config when no project config exists", async () => {
    const globalPath = path.join(home, ".config", "opencode", "skill-filter.json")
    await fs.writeFile(globalPath, JSON.stringify({ hide: ["grill*"] }))

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })

    expect(resolved.rules.hide).toEqual(["grill*"])
    expect(resolved.sources).toContain(globalPath)
  })

  it("honours XDG_CONFIG_HOME / OPENCODE_TEST_HOME via env", async () => {
    const envHome = path.join(root, "env-home")
    const globalDir = path.join(envHome, ".config", "opencode")
    await fs.mkdir(globalDir, { recursive: true })
    await fs.writeFile(path.join(globalDir, "skill-filter.json"), JSON.stringify({ hide: ["env-*"] }))

    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = envHome
    try {
      const resolved = await loadConfig({ projectDirectory: projectDir })
      expect(resolved.rules.hide).toEqual(["env-*"])
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCODE_TEST_HOME
      } else {
        process.env.OPENCODE_TEST_HOME = prev
      }
    }
  })

  it("merges inline options with the file, inline winning per field", async () => {
    await writeProjectConfig({
      hide: ["from-file"],
      unhide: ["from-file-unhide"],
      restoreUnhidden: false,
    })

    const resolved = await loadConfig({
      projectDirectory: projectDir,
      homeDirectory: home,
      inline: { hide: ["inline-*"], restoreUnhidden: true },
    })

    expect(resolved.rules.hide).toEqual(["inline-*"])
    // Fields absent inline fall back to the file.
    expect(resolved.rules.unhide).toEqual(["from-file-unhide"])
    expect(resolved.rules.restoreUnhidden).toBe(true)
    expect(resolved.sources).toContain("inline plugin options")
  })

  it("supports inline configPath:false to skip file loading entirely", async () => {
    await writeProjectConfig({ hide: ["should-not-be-read"] })

    const resolved = await loadConfig({
      projectDirectory: projectDir,
      homeDirectory: home,
      inline: { hide: ["only-inline"], configPath: false },
    })

    expect(resolved.rules.hide).toEqual(["only-inline"])
    expect(resolved.sources).toEqual(["inline plugin options"])
  })

  it("supports an explicit configPath and skips the default search", async () => {
    await writeProjectConfig({ hide: ["ignored"] })
    const explicit = path.join(root, "custom.json")
    await fs.writeFile(explicit, JSON.stringify({ hide: ["explicit-*"] }))

    const resolved = await loadConfig({
      projectDirectory: projectDir,
      homeDirectory: home,
      inline: { configPath: explicit },
    })

    expect(resolved.rules.hide).toEqual(["explicit-*"])
    expect(resolved.sources).toContain(explicit)
  })

  it("returns empty rules when no config exists anywhere", async () => {
    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(resolved.rules.hide).toEqual([])
    expect(resolved.rules.unhide).toEqual([])
    // Default debug remains on so first-run guidance is visible.
    expect(resolved.debug).toBe(true)
  })

  it("ignores a malformed JSON file without throwing", async () => {
    const target = path.join(projectDir, ".opencode", "skill-filter.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "{ not valid json ")

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(resolved.rules.hide).toEqual([])
  })

  it("ignores invalid field types but keeps valid ones", async () => {
    await writeProjectConfig({ hide: "not-an-array", unhide: ["to-spec"] })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(resolved.rules.hide).toEqual([])
    expect(resolved.rules.unhide).toEqual(["to-spec"])
  })
})
