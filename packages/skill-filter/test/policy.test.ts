import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  extractPolicies,
  generatePolicies,
  isManagedPolicy,
  mergePolicies,
  syncPolicies,
  toPolicyRule,
} from "../src/policy/sync"
import { parseJsonc } from "../src/config/jsonc"

const deny = (resource: string) => ({
  action: "integration.use" as const,
  resource: `skill:${resource}`,
  effect: "deny" as const,
})

describe("policy generation", () => {
  it("toPolicyRule builds an integration.use deny policy", () => {
    expect(toPolicyRule("paseo*")).toEqual({
      action: "integration.use",
      resource: "skill:paseo*",
      effect: "deny",
    })
  })

  it("generatePolicies dedupes and keeps order", () => {
    expect(generatePolicies(["a", "b", "a", ""])).toEqual([deny("a"), deny("b")])
    expect(generatePolicies([])).toEqual([])
  })

  it("isManagedPolicy only accepts skill:* integration.use deny", () => {
    expect(isManagedPolicy(deny("paseo*"))).toBe(true)
    expect(isManagedPolicy({ action: "integration.use", resource: "other", effect: "deny" })).toBe(false)
    expect(isManagedPolicy({ action: "integration.use", resource: "skill:a", effect: "allow" })).toBe(false)
    expect(isManagedPolicy({ action: "tool.use", resource: "skill:a", effect: "deny" })).toBe(false)
    expect(isManagedPolicy(null)).toBe(false)
  })

  it("mergePolicies replaces managed entries and keeps the rest", () => {
    const allow = { action: "tool.use", resource: "bash", effect: "allow" }
    const merged = mergePolicies([deny("old*"), allow], [deny("new*")])
    expect(merged).toEqual([allow, deny("new*")])
  })

  it("extractPolicies reads experimental.policies safely", () => {
    expect(extractPolicies({ experimental: { policies: [deny("a")] } })).toEqual([deny("a")])
    expect(extractPolicies({ experimental: {} })).toEqual([])
    expect(extractPolicies({})).toEqual([])
    expect(extractPolicies(null)).toEqual([])
    expect(extractPolicies({ experimental: { policies: "nope" } })).toEqual([])
  })
})

describe("syncPolicies", () => {
  let root: string
  let home: string
  let globalDir: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-filter-policy-"))
    home = path.join(root, "home")
    globalDir = path.join(home, ".config", "opencode")
    await fs.mkdir(globalDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it("skips when no target config exists", async () => {
    const result = await syncPolicies({ homeDirectory: home, patterns: ["paseo*"] })
    expect(result.synced).toBe(false)
    expect(result.written).toBe(false)
    expect(result.reason).toContain("no opencode config")
  })

  it("skips when there is nothing to sync", async () => {
    await fs.writeFile(path.join(globalDir, "opencode.jsonc"), "{}\n")
    const result = await syncPolicies({ homeDirectory: home, patterns: [] })
    expect(result.synced).toBe(false)
    expect(result.reason).toContain("no remove patterns")
  })

  it("writes deny policies into the global opencode.jsonc and preserves comments", async () => {
    const target = path.join(globalDir, "opencode.jsonc")
    await fs.writeFile(
      target,
      '{\n  // my config\n  "model": "x",\n  "experimental": {\n    "policies": [\n      { "action": "tool.use", "resource": "bash", "effect": "allow" }\n    ]\n  }\n}\n',
    )

    const result = await syncPolicies({ homeDirectory: home, patterns: ["paseo*", "grill*"] })

    expect(result.synced).toBe(true)
    expect(result.written).toBe(true)
    expect(result.path).toBe(target)

    const after = await fs.readFile(target, "utf-8")
    expect(after).toContain("// my config")
    const parsed = parseJsonc(after)
    expect(parsed).toEqual({
      model: "x",
      experimental: {
        policies: [
          { action: "tool.use", resource: "bash", effect: "allow" },
          deny("paseo*"),
          deny("grill*"),
        ],
      },
    })
  })

  it("is idempotent on a second run", async () => {
    const target = path.join(globalDir, "opencode.jsonc")
    await fs.writeFile(target, '{\n  "model": "x"\n}\n')

    const first = await syncPolicies({ homeDirectory: home, patterns: ["paseo*"] })
    expect(first.written).toBe(true)

    const second = await syncPolicies({ homeDirectory: home, patterns: ["paseo*"] })
    expect(second.written).toBe(false)
    expect(second.reason).toContain("already in sync")
  })

  it("replaces stale managed policies when patterns change", async () => {
    const target = path.join(globalDir, "opencode.jsonc")
    await fs.writeFile(target, '{\n  "model": "x"\n}\n')

    await syncPolicies({ homeDirectory: home, patterns: ["old*"] })
    await syncPolicies({ homeDirectory: home, patterns: ["new*"] })

    const parsed = parseJsonc(await fs.readFile(target, "utf-8")) as {
      experimental: { policies: unknown[] }
    }
    expect(parsed.experimental.policies).toEqual([deny("new*")])
  })

  it("creates the target file when an explicit path is given", async () => {
    const explicit = path.join(root, "nested", "opencode.json")
    const result = await syncPolicies({
      homeDirectory: home,
      patterns: ["paseo*"],
      targetPath: explicit,
    })
    expect(result.written).toBe(true)
    expect(result.path).toBe(explicit)
    const parsed = parseJsonc(await fs.readFile(explicit, "utf-8"))
    expect(parsed).toEqual({ experimental: { policies: [deny("paseo*")] } })
  })

  it("prefers opencode.jsonc over opencode.json", async () => {
    const jsonc = path.join(globalDir, "opencode.jsonc")
    const json = path.join(globalDir, "opencode.json")
    await fs.writeFile(jsonc, "{}\n")
    await fs.writeFile(json, "{}\n")

    const result = await syncPolicies({ homeDirectory: home, patterns: ["paseo*"] })
    expect(result.path).toBe(jsonc)
    expect(await fs.readFile(json, "utf-8")).toBe("{}\n")
  })

  it("supports an explicit targetPath with a leading tilde", async () => {
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const result = await syncPolicies({
        homeDirectory: home,
        patterns: ["paseo*"],
        targetPath: "~/.config/opencode/custom.jsonc",
      })
      expect(result.written).toBe(true)
      expect(result.path).toBe(path.join(home, ".config/opencode/custom.jsonc"))
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = prevHome
      }
    }
  })
})
