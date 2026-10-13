import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadConfig } from "../src/config/loader"
import { matchesDirectory, resolveOverrides } from "../src/config/overrides"

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

  async function writeGlobalConfig(contents: unknown) {
    const target = path.join(home, ".config", "opencode", "skill-filter.json")
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
    await writeGlobalConfig({ hide: ["global-only"] })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })

    expect(resolved.rules.hide).toEqual(["ask-matt", "to-*"])
    expect(resolved.rules.enable).toEqual(["to-spec"])
    expect(resolved.rules.exclude).toEqual(["to-keep"])
    expect(resolved.sources).toContain(configPath)
  })

  it("falls back to the global config when no project config exists", async () => {
    const globalPath = await writeGlobalConfig({ hide: ["grill*"] })

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

  it("parses remove and enable actions", async () => {
    await writeProjectConfig({
      remove: ["paseo*"],
      hide: ["to-*"],
      enable: ["paseo-keep"],
    })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })

    expect(resolved.rules.remove).toEqual(["paseo*"])
    expect(resolved.rules.hide).toEqual(["to-*"])
    expect(resolved.rules.enable).toEqual(["paseo-keep"])
  })

  it("maps the legacy unhide field to enable", async () => {
    await writeProjectConfig({ hide: ["to-*"], unhide: ["to-spec"] })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })

    expect(resolved.rules.enable).toEqual(["to-spec"])
    expect(resolved.rules.hide).toEqual(["to-*"])
  })

  it("merges enable + legacy unhide into one enable list", async () => {
    await writeProjectConfig({ enable: ["a"], unhide: ["b"] })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(resolved.rules.enable).toEqual(["a", "b"])
  })

  it("merges inline options with the file, inline winning per field", async () => {
    await writeProjectConfig({
      hide: ["from-file"],
      unhide: ["from-file-unhide"],
    })

    const resolved = await loadConfig({
      projectDirectory: projectDir,
      homeDirectory: home,
      inline: { hide: ["inline-*"] },
    })

    expect(resolved.rules.hide).toEqual(["inline-*"])
    // Fields absent inline fall back to the file (unhide → enable alias).
    expect(resolved.rules.enable).toEqual(["from-file-unhide"])
    expect(resolved.sources).toContain("inline plugin options")
  })

  it("lets project config fields fill in what the global config did not set", async () => {
    await writeGlobalConfig({ hide: ["global-hide"], remove: ["global-remove"] })
    await writeProjectConfig({ hide: ["project-hide"] })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })

    // project hide replaces global hide; global remove survives (per-field merge)
    expect(resolved.rules.hide).toEqual(["project-hide"])
    expect(resolved.rules.remove).toEqual(["global-remove"])
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
    await fs.writeFile(explicit, JSON.stringify({ remove: ["explicit-*"] }))

    const resolved = await loadConfig({
      projectDirectory: projectDir,
      homeDirectory: home,
      inline: { configPath: explicit },
    })

    expect(resolved.rules.remove).toEqual(["explicit-*"])
    expect(resolved.sources).toContain(explicit)
  })

  it("returns empty rules when no config exists anywhere", async () => {
    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(resolved.rules.remove).toEqual([])
    expect(resolved.rules.hide).toEqual([])
    expect(resolved.rules.enable).toEqual([])
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
    expect(resolved.rules.enable).toEqual(["to-spec"])
  })

  it("defaults exposeTool to true and lets inline options disable it", async () => {
    const byDefault = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(byDefault.exposeTool).toBe(true)

    const disabled = await loadConfig({
      projectDirectory: projectDir,
      homeDirectory: home,
      inline: { exposeTool: false },
    })
    expect(disabled.exposeTool).toBe(false)
  })

  it("reads exposeTool from the file and lets an invalid value fall back to default", async () => {
    await writeProjectConfig({ exposeTool: false })
    const fromFile = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(fromFile.exposeTool).toBe(false)

    await writeProjectConfig({ exposeTool: "yes" })
    const invalid = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(invalid.exposeTool).toBe(true)
  })
})

describe("global overrides by directory", () => {
  let root: string
  let home: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-filter-override-"))
    home = path.join(root, "home")
    await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  async function writeGlobalConfig(contents: unknown) {
    const target = path.join(home, ".config", "opencode", "skill-filter.json")
    await fs.writeFile(target, JSON.stringify(contents))
    return target
  }

  it("matches a directory glob and merges the override into the rules", async () => {
    const projectDir = path.join(root, "my-paseo-project")
    await fs.mkdir(projectDir, { recursive: true })
    await writeGlobalConfig({
      hide: ["base-hide"],
      overrides: {
        "*/my-paseo-project": { remove: ["paseo*"], enable: ["base-hide"] },
      },
    })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })

    expect(resolved.rules.remove).toEqual(["paseo*"])
    expect(resolved.rules.enable).toEqual(["base-hide"])
    expect(resolved.sources.some((s) => s.startsWith("overrides"))).toBe(true)
  })

  it("matches an override by repository basename", async () => {
    const projectDir = path.join(root, "paseo-tools")
    await fs.mkdir(projectDir, { recursive: true })
    await writeGlobalConfig({
      overrides: { "paseo-tools": { remove: ["paseo*"] } },
    })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(resolved.rules.remove).toEqual(["paseo*"])
  })

  it("does not apply an override whose directory does not match", async () => {
    const projectDir = path.join(root, "other-project")
    await fs.mkdir(projectDir, { recursive: true })
    await writeGlobalConfig({
      hide: ["base-hide"],
      overrides: { "*/my-paseo-project": { remove: ["paseo*"] } },
    })

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })
    expect(resolved.rules.remove).toEqual([])
    expect(resolved.rules.hide).toEqual(["base-hide"])
  })

  it("lets the project config win over a global override (project > global rules)", async () => {
    const projectDir = path.join(root, "my-paseo-project")
    await fs.mkdir(projectDir, { recursive: true })
    await writeGlobalConfig({
      overrides: { "*/my-paseo-project": { remove: ["global-paseo*"] } },
    })
    const target = path.join(projectDir, ".opencode", "skill-filter.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify({ hide: ["project-hide"] }))

    const resolved = await loadConfig({ projectDirectory: projectDir, homeDirectory: home })

    // global override remove is superseded by project rules only per-field;
    // here project sets hide (different field) so remove stays, hide is added.
    expect(resolved.rules.remove).toEqual(["global-paseo*"])
    expect(resolved.rules.hide).toEqual(["project-hide"])
  })

  it("lets inline options win over a global override", async () => {
    const projectDir = path.join(root, "my-paseo-project")
    await fs.mkdir(projectDir, { recursive: true })
    await writeGlobalConfig({
      overrides: { "*/my-paseo-project": { remove: ["global-paseo*"] } },
    })

    const resolved = await loadConfig({
      projectDirectory: projectDir,
      homeDirectory: home,
      inline: { remove: ["inline-paseo*"] },
    })
    expect(resolved.rules.remove).toEqual(["inline-paseo*"])
  })
})

describe("overrides helpers", () => {
  it("matchesDirectory handles paths, basenames and backslashes", () => {
    expect(matchesDirectory("/home/me/my-paseo-project", "*/my-paseo-project")).toBe(true)
    expect(matchesDirectory("/home/me/my-paseo-project", "my-paseo-project")).toBe(true)
    expect(matchesDirectory("C:\\work\\paseo", "paseo")).toBe(true)
    expect(matchesDirectory("/home/me/other", "*/my-paseo-project")).toBe(false)
    expect(matchesDirectory("", "*")).toBe(false)
  })

  it("resolveOverrides merges every matching override in order", () => {
    const merged = resolveOverrides(
      {
        "*/project": { hide: ["a"] },
        "project": { enable: ["b"] },
        "*/nope": { remove: ["z"] },
      },
      "/tmp/project",
    )
    expect(merged).toMatchObject({ hide: ["a"], enable: ["b"] })
    expect(merged?.remove).toBeUndefined()
  })

  it("resolveOverrides returns undefined when nothing matches", () => {
    expect(resolveOverrides({ "*/nope": { hide: ["x"] } }, "/tmp/project")).toBeUndefined()
    expect(resolveOverrides(undefined, "/tmp/project")).toBeUndefined()
  })
})
