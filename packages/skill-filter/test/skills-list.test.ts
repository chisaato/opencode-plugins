import { describe, it, expect } from "vitest"
import {
  buildSkillsListReport,
  createSkillsListTool,
  formatSkillsList,
  isSkillHidden,
  SKILLS_LIST_INPUT_SCHEMA,
  SKILLS_LIST_TOOL_DESCRIPTION,
  SKILLS_LIST_TOOL_NAME,
  type SkillsListReport,
} from "../src/tool/skills-list"
import type { MutableSkill } from "../src/filter/apply"

const sample: MutableSkill[] = [
  { id: "alpha", name: "alpha", description: "first", autoinvoke: true },
  { id: "beta", name: "beta", autoinvoke: false },
  { id: "gamma", name: "gamma", description: "" },
]

describe("isSkillHidden", () => {
  it("treats autoinvoke === false as hidden and everything else as active", () => {
    expect(isSkillHidden({ autoinvoke: false })).toBe(true)
    expect(isSkillHidden({ autoinvoke: true })).toBe(false)
    expect(isSkillHidden({})).toBe(false)
  })
})

describe("buildSkillsListReport", () => {
  it("counts total/active/hidden across the whole list", () => {
    const report = buildSkillsListReport(sample, "all")
    expect(report.total).toBe(3)
    expect(report.active).toBe(2)
    expect(report.hidden).toBe(1)
    expect(report.removed).toBe(0)
    expect(report.status).toBe("all")
    expect(report.skills).toHaveLength(3)
  })

  it("defaults to all when no status is given", () => {
    expect(buildSkillsListReport(sample).status).toBe("all")
  })

  it("filters the skill list by status while keeping global counts", () => {
    const hidden = buildSkillsListReport(sample, "hidden")
    expect(hidden.total).toBe(3)
    expect(hidden.hidden).toBe(1)
    expect(hidden.skills.map((e) => e.name)).toEqual(["beta"])

    const active = buildSkillsListReport(sample, "active")
    expect(active.active).toBe(2)
    expect(active.skills.map((e) => e.name)).toEqual(["alpha", "gamma"])
  })

  it("exposes autoinvoke and hidden flags, omitting empty description", () => {
    const report = buildSkillsListReport(sample, "all")
    const alpha = report.skills.find((e) => e.name === "alpha")
    const gamma = report.skills.find((e) => e.name === "gamma")
    expect(alpha).toMatchObject({
      id: "alpha",
      autoinvoke: true,
      hidden: false,
      removed: false,
      state: "active",
      description: "first",
    })
    expect(gamma).not.toHaveProperty("description")
  })

  it("falls back to id when name is missing and handles an empty list", () => {
    const report = buildSkillsListReport([{ id: "only-id" }], "all")
    expect(report.skills[0]?.name).toBe("only-id")
    expect(buildSkillsListReport([], "all")).toMatchObject({ total: 0, active: 0, hidden: 0, removed: 0 })
  })

  it("reports removed skills and folds them into the total", () => {
    const report = buildSkillsListReport(sample, "all", [
      { id: "paseo-cli", name: "paseo-cli", description: "paseo tool" },
    ])
    // 原始发现总数 = 存活 3 + 移除 1
    expect(report.total).toBe(4)
    expect(report.active).toBe(2)
    expect(report.hidden).toBe(1)
    expect(report.removed).toBe(1)
    expect(report.skills).toHaveLength(4)
    const removedEntry = report.skills.find((e) => e.name === "paseo-cli")
    expect(removedEntry).toMatchObject({
      id: "paseo-cli",
      state: "removed",
      removed: true,
      hidden: false,
      description: "paseo tool",
    })
  })

  it("filters to only removed entries when status=removed", () => {
    const report = buildSkillsListReport(sample, "removed", [{ name: "gone" }])
    expect(report.skills.map((e) => e.name)).toEqual(["gone"])
    // global counts still span everything
    expect(report.total).toBe(4)
    expect(report.removed).toBe(1)
  })

  it("does not double count a removed entry that is still live", () => {
    const report = buildSkillsListReport(sample, "all", [
      { id: "beta", name: "beta" },
      { id: "gone", name: "gone" },
    ])
    // beta 仍然存活 → 不计入 removed；gone 计入
    expect(report.total).toBe(4)
    expect(report.removed).toBe(1)
    expect(report.skills.filter((e) => e.state === "removed").map((e) => e.name)).toEqual(["gone"])
  })

  it("attaches a policies summary when provided", () => {
    const report = buildSkillsListReport(sample, "all", [], {
      patterns: ["paseo*"],
      synced: true,
      written: true,
      path: "/home/me/.config/opencode/opencode.jsonc",
    })
    expect(report.policies).toEqual({
      patterns: ["paseo*"],
      synced: true,
      written: true,
      path: "/home/me/.config/opencode/opencode.jsonc",
    })
    // 未提供时不应出现该字段
    expect(buildSkillsListReport(sample).policies).toBeUndefined()
  })
})

describe("formatSkillsList", () => {
  it("renders a header and one line per skill", () => {
    const text = formatSkillsList(buildSkillsListReport(sample, "all"))
    expect(text).toContain("total=3, active=2, hidden=1, removed=0")
    expect(text).toContain("- [active] alpha - first")
    expect(text).toContain("- [hidden] beta")
  })

  it("renders removed entries with a [removed] marker", () => {
    const text = formatSkillsList(buildSkillsListReport([], "all", [{ name: "gone" }]))
    expect(text).toContain("removed=1")
    expect(text).toContain("- [removed] gone")
  })

  it("shows an empty marker when nothing matches", () => {
    const text = formatSkillsList(buildSkillsListReport([], "all"))
    expect(text).toContain("(no skills matched)")
  })

  it("renders a policy line when a summary is present", () => {
    const text = formatSkillsList(
      buildSkillsListReport(sample, "all", [], {
        patterns: ["paseo*", "grill*"],
        synced: true,
        written: true,
        path: "/home/me/.config/opencode/opencode.jsonc",
      }),
    )
    expect(text).toContain("policy: synced=true (written)")
    expect(text).toContain("deny=[skill:paseo*, skill:grill*]")
    expect(text).toContain("/home/me/.config/opencode/opencode.jsonc")
  })
})

describe("createSkillsListTool", () => {
  it("returns a Tool.Info-shaped definition with the expected metadata", () => {
    const tool = createSkillsListTool({ listSkills: () => sample })
    expect(tool.name).toBe(SKILLS_LIST_TOOL_NAME)
    expect(tool.description).toBe(SKILLS_LIST_TOOL_DESCRIPTION)
    expect(tool.input).toBe(SKILLS_LIST_INPUT_SCHEMA)
    expect(tool.input.properties.status).toMatchObject({
      enum: ["all", "active", "hidden", "removed"],
    })
    expect(typeof tool.execute).toBe("function")
  })

  it("execute awaits listSkills and returns content + metadata", async () => {
    const tool = createSkillsListTool({
      listSkills: async () => sample,
    })
    const result = await tool.execute({ status: "all" }, {})
    expect(result.content[0]?.type).toBe("text")
    expect(result.content[0]?.text).toContain("total=3")
    const metadata = result.metadata as unknown as SkillsListReport
    expect(metadata.total).toBe(3)
    expect(metadata.skills).toHaveLength(3)
  })

  it("execute merges removed skills from getRemoved", async () => {
    const tool = createSkillsListTool({
      listSkills: async () => sample,
      getRemoved: async () => [{ id: "paseo", name: "paseo" }],
    })
    const result = await tool.execute({ status: "removed" }, {})
    const metadata = result.metadata as unknown as SkillsListReport
    expect(metadata.total).toBe(4)
    expect(metadata.removed).toBe(1)
    expect(metadata.skills.map((e) => e.name)).toEqual(["paseo"])
  })

  it("execute tolerates missing input", async () => {
    const tool = createSkillsListTool({ listSkills: () => [] })
    const result = await tool.execute(undefined, {})
    const metadata = result.metadata as unknown as SkillsListReport
    expect(metadata.status).toBe("all")
    expect(metadata.total).toBe(0)
  })

  it("execute surfaces the policy summary from getPolicies", async () => {
    const tool = createSkillsListTool({
      listSkills: () => [],
      getPolicies: () => ({ patterns: ["paseo*"], synced: true, written: false }),
    })
    const result = await tool.execute({ status: "all" }, {})
    const metadata = result.metadata as unknown as SkillsListReport
    expect(metadata.policies).toEqual({ patterns: ["paseo*"], synced: true, written: false })
    expect(result.content[0]?.text).toContain("policy: synced=true deny=[skill:paseo*]")
  })
})
