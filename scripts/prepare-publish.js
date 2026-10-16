import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// 与 resolve-publish-target.ts 使用同一条 semver 规则
// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

// 只允许 packages/ 下的单段目录名,避免 ../ 逃出仓库
const PACKAGE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function defaultPackagesRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages")
}

function unknownDir(dir) {
  return new Error(`未知目录: packages/${dir} 不存在`)
}

function classifyVersion(version) {
  const match = SEMVER.exec(version)
  if (!match) {
    throw new Error(`版本不是合法 semver: ${version}`)
  }
  // 只看 semver 的预发布段;构建元数据里的 '-' 不算预发布
  const prerelease = Boolean(match[4])
  const npmTag = prerelease ? "next" : "latest"
  return { prerelease, npmTag }
}

function readJsonString(text, start) {
  if (text[start] !== '"') {
    throw new Error("package.json 格式无效")
  }
  let i = start + 1
  let value = ""
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      return { value, end: i + 1 }
    }
    if (ch === "\\") {
      const next = text[i + 1]
      if (next === undefined) {
        throw new Error("package.json 字符串未结束")
      }
      const escapes = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      }
      if (next === "u") {
        const hex = text.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new Error("package.json 字符串转义无效")
        }
        value += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
        continue
      }
      if (!Object.hasOwn(escapes, next)) {
        throw new Error("package.json 字符串转义无效")
      }
      value += escapes[next]
      i += 2
      continue
    }
    if (ch === "\n" || ch === "\r") {
      throw new Error("package.json 字符串未结束")
    }
    value += ch
    i += 1
  }
  throw new Error("package.json 字符串未结束")
}

function skipContainer(text, start, open, close) {
  let depth = 0
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      i = readJsonString(text, i).end
      continue
    }
    if (ch === open) {
      depth += 1
    } else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        return i + 1
      }
    }
    i += 1
  }
  throw new Error("package.json 格式无效")
}

function skipJsonValue(text, start) {
  const ch = text[start]
  if (ch === '"') {
    return readJsonString(text, start).end
  }
  if (ch === "{") {
    return skipContainer(text, start, "{", "}")
  }
  if (ch === "[") {
    return skipContainer(text, start, "[", "]")
  }
  if (text.startsWith("true", start)) {
    return start + 4
  }
  if (text.startsWith("false", start)) {
    return start + 5
  }
  if (text.startsWith("null", start)) {
    return start + 4
  }
  if (ch === "-" || (ch >= "0" && ch <= "9")) {
    let i = start + 1
    while (i < text.length && /[0-9eE+.\-]/.test(text[i])) {
      i += 1
    }
    return i
  }
  throw new Error("package.json 格式无效")
}

function skipWhitespace(text, start) {
  let i = start
  while (i < text.length && /\s/.test(text[i])) {
    i += 1
  }
  return i
}

// 只定位顶层 version 的字符串字面量,避免改到嵌套的同名键
function findTopLevelVersionSpan(text) {
  let i = skipWhitespace(text, 0)
  if (text[i] !== "{") {
    throw new Error("package.json 不是对象")
  }
  i += 1
  while (i < text.length) {
    i = skipWhitespace(text, i)
    if (text[i] === "}") {
      throw new Error("package.json 缺少 version")
    }
    if (text[i] !== '"') {
      throw new Error("package.json 格式无效")
    }
    const key = readJsonString(text, i)
    i = skipWhitespace(text, key.end)
    if (text[i] !== ":") {
      throw new Error("package.json 格式无效")
    }
    i = skipWhitespace(text, i + 1)
    if (key.value === "version") {
      if (text[i] !== '"') {
        throw new Error("package.json 的 version 不是字符串")
      }
      const value = readJsonString(text, i)
      return { start: i, end: value.end }
    }
    i = skipJsonValue(text, i)
    i = skipWhitespace(text, i)
    if (text[i] === ",") {
      i += 1
      continue
    }
    if (text[i] === "}") {
      throw new Error("package.json 缺少 version")
    }
    throw new Error("package.json 格式无效")
  }
  throw new Error("package.json 缺少 version")
}

function replaceTopLevelVersion(text, nextVersion) {
  const span = findTopLevelVersionSpan(text)
  const encoded = JSON.stringify(nextVersion)
  return text.slice(0, span.start) + encoded + text.slice(span.end)
}

function assertOnlyVersionChanged(before, after, version) {
  if (after === null || typeof after !== "object" || Array.isArray(after)) {
    throw new Error("package.json 不是对象")
  }
  if (after.version !== version) {
    throw new Error("写入版本失败")
  }
  const beforeRest = { ...before }
  const afterRest = { ...after }
  delete beforeRest.version
  delete afterRest.version
  if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) {
    throw new Error("准备发布版本时不能改动 version 以外的内容")
  }
}

function assertContainedPackage(root, dir) {
  if (typeof dir !== "string" || !PACKAGE_DIR.test(dir)) {
    throw unknownDir(dir)
  }
  const resolvedDir = path.resolve(root, dir)
  if (resolvedDir !== path.join(root, dir)) {
    throw unknownDir(dir)
  }
  if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
    throw unknownDir(dir)
  }
  const pkgPath = path.join(resolvedDir, "package.json")
  if (!existsSync(pkgPath) || !statSync(pkgPath).isFile()) {
    throw unknownDir(dir)
  }

  let realRoot
  let realDir
  let realPkg
  try {
    realRoot = realpathSync(root)
    realDir = realpathSync(resolvedDir)
    realPkg = realpathSync(pkgPath)
  } catch {
    throw unknownDir(dir)
  }
  const relDir = path.relative(realRoot, realDir)
  if (relDir !== dir || relDir.startsWith("..") || path.isAbsolute(relDir)) {
    throw unknownDir(dir)
  }
  if (path.relative(realDir, realPkg) !== "package.json") {
    throw unknownDir(dir)
  }
  return pkgPath
}

export function preparePublish(input) {
  const dir = input?.dir
  const version = input?.version
  if (typeof dir !== "string" || typeof version !== "string") {
    throw new Error("缺少目录名或版本")
  }
  const classified = classifyVersion(version)
  const root = path.resolve(input.packagesRoot ?? defaultPackagesRoot())
  const pkgPath = assertContainedPackage(root, dir)

  const original = readFileSync(pkgPath, "utf8")
  const before = JSON.parse(original)
  if (before === null || typeof before !== "object" || Array.isArray(before)) {
    throw new Error("package.json 不是对象")
  }
  if (typeof before.version !== "string") {
    throw new Error(`packages/${dir}/package.json 缺少 version`)
  }

  // 先在内存里确认只换了顶层 version,再写入独立 checkout
  const updated = replaceTopLevelVersion(original, version)
  assertOnlyVersionChanged(before, JSON.parse(updated), version)
  writeFileSync(pkgPath, updated)

  return {
    dir,
    version,
    prerelease: classified.prerelease,
    npmTag: classified.npmTag,
    packageJsonPath: pkgPath,
  }
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

if (isDirectRun()) {
  try {
    const dir = process.argv[2]
    const version = process.argv[3]
    if (dir === undefined || version === undefined) {
      throw new Error("缺少目录名或版本")
    }
    const target = preparePublish({ dir, version })
    process.stdout.write(
      `已将 packages/${target.dir}/package.json 的 version 写为 ${target.version} (${target.npmTag})\n`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  }
}
