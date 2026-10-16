import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { resolvePublishTarget } from "./resolve-publish-target"

describe("resolvePublishTarget", () => {
  it("解析合法 tag 为 packages 目录名与 semver", () => {
    expect(resolvePublishTarget("skill-filter@0.1.0")).toEqual({
      dir: "skill-filter",
      version: "0.1.0",
      prerelease: false,
      npmTag: "latest",
    })
    expect(resolvePublishTarget("auto-model-config@1.1.0")).toEqual({
      dir: "auto-model-config",
      version: "1.1.0",
      prerelease: false,
      npmTag: "latest",
    })
    expect(resolvePublishTarget("skill-filter@0.2.1-beta.1")).toEqual({
      dir: "skill-filter",
      version: "0.2.1-beta.1",
      prerelease: true,
      npmTag: "next",
    })
  })

  it("正式版使用 latest,预发布版使用 next", () => {
    expect(resolvePublishTarget("skill-filter@1.2.3")).toMatchObject({
      prerelease: false,
      npmTag: "latest",
    })
    expect(resolvePublishTarget("skill-filter@1.2.3+exp-1")).toMatchObject({
      prerelease: false,
      npmTag: "latest",
    })
    expect(resolvePublishTarget("refs/tags/skill-filter@0.2.1-beta")).toMatchObject({
      prerelease: true,
      npmTag: "next",
    })
    expect(resolvePublishTarget("skill-filter@1.0.0-rc.1+build")).toMatchObject({
      version: "1.0.0-rc.1+build",
      prerelease: true,
      npmTag: "next",
    })
  })

  it("缺版本时抛出中文错误", () => {
    expect(() => resolvePublishTarget("skill-filter")).toThrow(/缺少版本/)
    expect(() => resolvePublishTarget("skill-filter@")).toThrow(/缺少版本/)
    expect(() => resolvePublishTarget("")).toThrow(/缺少版本/)
    expect(() => resolvePublishTarget("   ")).toThrow(/缺少版本/)
  })

  it("目录名为空或未知时抛出中文错误", () => {
    expect(() => resolvePublishTarget("@0.1.0")).toThrow(/目录名为空/)
    expect(() => resolvePublishTarget("no-such-pkg@1.0.0")).toThrow(/未知目录/)
    expect(() => resolvePublishTarget("../skill-filter@1.0.0")).toThrow(/未知目录/)
    expect(() => resolvePublishTarget("skill-filter/evil@1.0.0")).toThrow(/未知目录/)
  })

  it("版本不是 semver 时抛出中文错误", () => {
    expect(() => resolvePublishTarget("skill-filter@1")).toThrow(/semver/)
    expect(() => resolvePublishTarget("skill-filter@01.2.3")).toThrow(/semver/)
    expect(() => resolvePublishTarget("skill-filter@v0.1.0")).toThrow(/semver/)
    expect(() => resolvePublishTarget("skill-filter@latest")).toThrow(/semver/)
  })

  it("含多个 @ 时抛出中文错误", () => {
    expect(() => resolvePublishTarget("skill-filter@0.1.0@1")).toThrow(/多个 @/)
    expect(() => resolvePublishTarget("@misakacloud/opencode-skill-filter@0.1.0")).toThrow(
      /多个 @/,
    )
  })

  it("版本取自 tag,不要求等于 package.json 的占位 version", () => {
    expect(resolvePublishTarget("skill-filter@9.9.9")).toMatchObject({
      dir: "skill-filter",
      version: "9.9.9",
      prerelease: false,
      npmTag: "latest",
    })
    expect(resolvePublishTarget("auto-retry@0.2.0-rc.1")).toMatchObject({
      dir: "auto-retry",
      version: "0.2.0-rc.1",
      prerelease: true,
      npmTag: "next",
    })
  })

  it("剥离 refs/tags/ 前缀后再解析", () => {
    expect(resolvePublishTarget("refs/tags/auto-model-config@1.1.0")).toEqual({
      dir: "auto-model-config",
      version: "1.1.0",
      prerelease: false,
      npmTag: "latest",
    })
    expect(resolvePublishTarget("refs/tags/skill-filter@0.2.1-beta")).toEqual({
      dir: "skill-filter",
      version: "0.2.1-beta",
      prerelease: true,
      npmTag: "next",
    })
    expect(() => resolvePublishTarget("refs/tags/@0.1.0")).toThrow(/目录名为空/)
    expect(() => resolvePublishTarget("refs/tags/skill-filter")).toThrow(/缺少版本/)
  })
})

describe("resolve-publish-target CLI", () => {
  const script = path.join(import.meta.dirname, "resolve-publish-target.ts")

  it("未设置 GITHUB_OUTPUT 时把 dir 与 version 打到 stdout", () => {
    const stdout = execFileSync("bun", [script, "skill-filter@0.1.0"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "" },
    })
    expect(stdout).toContain("dir=skill-filter\n")
    expect(stdout).toContain("version=0.1.0\n")
    expect(stdout).toContain("prerelease=false\n")
    expect(stdout).toContain("npmTag=latest\n")
  })

  it("预发布版把 prerelease=true 与 npmTag=next 打到 stdout", () => {
    const stdout = execFileSync("bun", [script, "skill-filter@0.2.1-beta.1"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "" },
    })
    expect(stdout).toContain("dir=skill-filter\n")
    expect(stdout).toContain("version=0.2.1-beta.1\n")
    expect(stdout).toContain("prerelease=true\n")
    expect(stdout).toContain("npmTag=next\n")
  })

  it("设置 GITHUB_OUTPUT 时写入该文件", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "publish-target-"))
    const output = path.join(dir, "github_output")
    try {
      execFileSync("bun", [script, "refs/tags/auto-model-config@1.1.0"], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: output },
      })
      const text = readFileSync(output, "utf8")
      expect(text).toContain("dir=auto-model-config\n")
      expect(text).toContain("version=1.1.0\n")
      expect(text).toContain("prerelease=false\n")
      expect(text).toContain("npmTag=latest\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
