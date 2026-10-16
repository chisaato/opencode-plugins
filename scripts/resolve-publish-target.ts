import { appendFileSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

// 只允许 packages/ 下的单段目录名,避免 ../ 逃出仓库
const PACKAGE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const TAG_PREFIX = "refs/tags/"

function stripTagPrefix(tag: string): string {
  if (tag.startsWith(TAG_PREFIX)) {
    return tag.slice(TAG_PREFIX.length)
  }
  return tag
}

function packagesRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages")
}

function isKnownPackageDir(dir: string): boolean {
  if (!PACKAGE_DIR.test(dir)) {
    return false
  }
  const root = packagesRoot()
  const resolved = path.resolve(root, dir)
  if (resolved !== path.join(root, dir)) {
    return false
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return false
  }
  return existsSync(path.join(resolved, "package.json"))
}

// 版本只来自 tag。仓库 package.json 的 version 是开发占位,调用方不得拿它比对。
export function resolvePublishTarget(tag: string): {
  dir: string
  version: string
  prerelease: boolean
  npmTag: "latest" | "next"
} {
  const normalized = stripTagPrefix(tag.trim())
  if (!normalized) {
    throw new Error("发布 tag 缺少版本")
  }

  const atCount = normalized.split("@").length - 1
  if (atCount === 0) {
    throw new Error(`发布 tag 缺少版本: ${normalized}`)
  }
  if (atCount !== 1) {
    throw new Error(`发布 tag 含有多个 @: ${normalized}`)
  }

  const separator = normalized.indexOf("@")
  const dir = normalized.slice(0, separator)
  const version = normalized.slice(separator + 1)
  if (!dir) {
    throw new Error(`发布 tag 的目录名为空: ${normalized}`)
  }
  if (!version) {
    throw new Error(`发布 tag 缺少版本: ${normalized}`)
  }
  const match = SEMVER.exec(version)
  if (!match) {
    throw new Error(`发布 tag 的版本不是合法 semver: ${version}`)
  }
  if (!isKnownPackageDir(dir)) {
    throw new Error(`未知目录: packages/${dir} 不存在`)
  }

  // 只看 semver 的预发布段;构建元数据里的 '-' 不算预发布
  const prerelease = Boolean(match[4])
  const npmTag: "latest" | "next" = prerelease ? "next" : "latest"
  return { dir, version, prerelease, npmTag }
}

function writeResult(target: {
  dir: string
  version: string
  prerelease: boolean
  npmTag: "latest" | "next"
}): void {
  const lines = [
    `dir=${target.dir}`,
    `version=${target.version}`,
    `prerelease=${target.prerelease ? "true" : "false"}`,
    `npmTag=${target.npmTag}`,
    "",
  ].join("\n")
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    appendFileSync(output, lines)
    return
  }
  process.stdout.write(lines)
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

if (isDirectRun()) {
  try {
    const tag = process.argv[2]
    if (tag === undefined) {
      throw new Error("发布 tag 缺少版本")
    }
    const target = resolvePublishTarget(tag)
    writeResult(target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  }
}
