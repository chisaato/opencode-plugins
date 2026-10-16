import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { preparePublish } from "./prepare-publish.js"

function packageText(version: string): string {
  return `{
  "name": "@misakacloud/opencode-auto-retry",
  "version": "${version}",
  "description": "placeholder",
  "publishConfig": {
    "access": "public",
    "provenance": true
  },
  "extra": {
    "version": "9.9.9",
    "note": "keep"
  }
}
`
}

function writePackage(root: string, dir: string, version: string): string {
  const pkgDir = path.join(root, dir)
  mkdirSync(pkgDir, { recursive: true })
  const pkgPath = path.join(pkgDir, "package.json")
  writeFileSync(pkgPath, packageText(version))
  return pkgPath
}

describe("preparePublish", () => {
  it("占位 version 与 tag 不同时仍写成 tag 版本", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-publish-"))
    try {
      const pkgPath = writePackage(root, "auto-retry", "0.1.0")
      const result = preparePublish({
        dir: "auto-retry",
        version: "0.1.1",
        packagesRoot: root,
      })
      expect(result).toMatchObject({
        dir: "auto-retry",
        version: "0.1.1",
        prerelease: false,
        npmTag: "latest",
        packageJsonPath: pkgPath,
      })
      expect(JSON.parse(readFileSync(pkgPath, "utf8")).version).toBe("0.1.1")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("拒绝非法目录且不改动已有文件", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-publish-"))
    try {
      const pkgPath = writePackage(root, "skill-filter", "0.1.0")
      const before = readFileSync(pkgPath, "utf8")
      const outside = path.join(root, "..", "escaped-package.json")
      for (const dir of ["../skill-filter", "skill-filter/evil", "no-such-pkg", "", ".."]) {
        expect(() => preparePublish({ dir, version: "1.2.3", packagesRoot: root })).toThrow(/未知目录/)
      }
      expect(readFileSync(pkgPath, "utf8")).toBe(before)
      expect(() => readFileSync(outside, "utf8")).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("拒绝非法 semver 且不改动文件", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-publish-"))
    try {
      const pkgPath = writePackage(root, "skill-filter", "0.1.0")
      const before = readFileSync(pkgPath, "utf8")
      for (const version of ["1", "01.2.3", "v0.1.0", "latest", "", "1.0.0 "]) {
        expect(() =>
          preparePublish({ dir: "skill-filter", version, packagesRoot: root }),
        ).toThrow(/semver/)
      }
      expect(readFileSync(pkgPath, "utf8")).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("正式版 dist-tag 为 latest,预发布版为 next", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-publish-"))
    try {
      writePackage(root, "skill-filter", "0.1.0")
      expect(
        preparePublish({ dir: "skill-filter", version: "1.2.3", packagesRoot: root }),
      ).toMatchObject({ prerelease: false, npmTag: "latest", version: "1.2.3" })

      expect(
        preparePublish({ dir: "skill-filter", version: "1.2.3+exp-1", packagesRoot: root }),
      ).toMatchObject({ prerelease: false, npmTag: "latest", version: "1.2.3+exp-1" })

      expect(
        preparePublish({ dir: "skill-filter", version: "0.2.0-beta.1", packagesRoot: root }),
      ).toMatchObject({ prerelease: true, npmTag: "next", version: "0.2.0-beta.1" })

      expect(
        preparePublish({ dir: "skill-filter", version: "1.0.0-rc.1+build", packagesRoot: root }),
      ).toMatchObject({ prerelease: true, npmTag: "next", version: "1.0.0-rc.1+build" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("只改目标包的 version,其它内容与其它包保持不变", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-publish-"))
    try {
      const targetPath = writePackage(root, "skill-filter", "0.1.0")
      const otherPath = writePackage(root, "auto-retry", "0.1.0")
      const targetBefore = readFileSync(targetPath, "utf8")
      const otherBefore = readFileSync(otherPath, "utf8")

      preparePublish({
        dir: "skill-filter",
        version: "1.4.0",
        packagesRoot: root,
      })

      const targetAfter = readFileSync(targetPath, "utf8")
      expect(targetAfter).toBe(targetBefore.replace('"version": "0.1.0"', '"version": "1.4.0"'))
      expect(otherBefore).toBe(readFileSync(otherPath, "utf8"))

      const parsed = JSON.parse(targetAfter)
      expect(parsed.version).toBe("1.4.0")
      expect(parsed.name).toBe("@misakacloud/opencode-auto-retry")
      expect(parsed.publishConfig).toEqual({ access: "public", provenance: true })
      expect(parsed.extra).toEqual({ version: "9.9.9", note: "keep" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("保留非常规空白,且不改嵌套的 version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-publish-"))
    try {
      const pkgDir = path.join(root, "auto-retry")
      mkdirSync(pkgDir, { recursive: true })
      const pkgPath = path.join(pkgDir, "package.json")
      const original = '{\n  "name": "only",\n  "version" : "0.1.0",\n  "extra": { "version": "9.9.9" }\n}\n'
      writeFileSync(pkgPath, original)
      preparePublish({ dir: "auto-retry", version: "2.0.0-rc.2", packagesRoot: root })
      const after = readFileSync(pkgPath, "utf8")
      expect(after).toBe(
        '{\n  "name": "only",\n  "version" : "2.0.0-rc.2",\n  "extra": { "version": "9.9.9" }\n}\n',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("prepare-publish CLI", () => {
  const script = path.join(import.meta.dirname, "prepare-publish.js")

  it("非法目录或 semver 以非零退出,且不改仓库里的包", () => {
    const targets = [
      "packages/skill-filter/package.json",
      "packages/auto-retry/package.json",
    ].map((relative) => path.join(import.meta.dirname, "..", relative))
    const before = new Map(targets.map((file) => [file, readFileSync(file, "utf8")]))

    for (const args of [
      ["no-such-pkg", "1.2.3"],
      ["../skill-filter", "1.2.3"],
      ["skill-filter", "latest"],
      ["skill-filter", "v0.1.0"],
    ]) {
      let failed = false
      try {
        execFileSync("node", [script, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (error) {
        failed = true
        const failure = error as { status?: number; stderr?: Buffer | string }
        expect(failure.status).toBe(1)
        const stderr = String(failure.stderr ?? "")
        expect(stderr).toMatch(/未知目录|semver/)
      }
      expect(failed).toBe(true)
    }

    for (const [file, text] of before) {
      expect(readFileSync(file, "utf8")).toBe(text)
    }
  })
})
