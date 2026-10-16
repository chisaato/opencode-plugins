// JSONC（带注释的 JSON）读写辅助。
//
// OpenCode 的主配置 `opencode.jsonc` 允许 `//`、`/* */` 注释与尾逗号，
// 直接 `JSON.parse` / `JSON.stringify` 往返会**抹掉用户注释**。
// 因此这里：
// - 解析：把注释掩码为等长空白后再 `JSON.parse`（额外容忍尾逗号）；
// - 写入：只做外科手术式文本替换，仅改动目标数组 / 对象，其余字节原样保留。

import fs from "node:fs/promises"

/**
 * 把 JSONC 中的注释替换为**等长空白**，并保留换行。
 *
 * 之所以保持长度不变，是为了让掩码文本与原始文本的下标一一对应，
 * 从而可以在掩码文本上定位、在原始文本上做替换。
 * 字符串字面量内的内容（含 `//`、`/*`）原样保留。
 */
export function maskJsonComments(input: string): string {
  let out = ""
  let i = 0
  let inString = false

  while (i < input.length) {
    const char = input[i] as string

    if (inString) {
      if (char === "\\") {
        // 转义序列：整段原样保留（保持字符串内容与长度）。
        out += char
        const next = input[i + 1]
        if (next !== undefined) {
          out += next
          i += 2
        } else {
          i += 1
        }
        continue
      }
      if (char === '"') {
        inString = false
      }
      out += char
      i += 1
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      i += 1
      continue
    }

    // 行注释：直到行尾（不含换行）。
    if (char === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") {
        out += " "
        i += 1
      }
      continue
    }

    // 块注释：直到 `*/`（换行保留为换行）。
    if (char === "/" && input[i + 1] === "*") {
      out += "  "
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        out += input[i] === "\n" ? "\n" : " "
        i += 1
      }
      if (i < input.length) {
        out += "  "
        i += 2
      }
      continue
    }

    out += char
    i += 1
  }

  return out
}

/**
 * 去掉结构化文本中的尾逗号（字符串字面量内的逗号不受影响）。
 *
 * JSONC 允许 `[1, 2,]` / `{ "a": 1, }`，而 `JSON.parse` 不允许，
 * 因此解析前需要做一遍清理。
 */
export function stripTrailingCommas(input: string): string {
  let out = ""
  let i = 0
  let inString = false

  while (i < input.length) {
    const char = input[i] as string

    if (inString) {
      if (char === "\\") {
        out += char
        const next = input[i + 1]
        if (next !== undefined) {
          out += next
          i += 2
        } else {
          i += 1
        }
        continue
      }
      if (char === '"') {
        inString = false
      }
      out += char
      i += 1
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      i += 1
      continue
    }

    if (char === ",") {
      let j = i + 1
      while (j < input.length && isWhitespace(input[j] as string)) {
        j += 1
      }
      const next = input[j]
      if (next === "}" || next === "]") {
        out += " "
        i += 1
        continue
      }
    }

    out += char
    i += 1
  }

  return out
}

/**
 * 去掉文件开头的 UTF-8 BOM（U+FEFF）。
 *
 * 只处理首字符，字符串内部的 U+FEFF 原样保留。
 * 写入路径不调用本函数，因此不会改动 policy 同步的外科手术式替换。
 */
function stripLeadingBom(input: string): string {
  if (input.charCodeAt(0) === 0xfeff) {
    return input.slice(1)
  }
  return input
}

/**
 * 解析 JSONC 文本。
 *
 * 容忍注释、尾逗号，以及文件开头的 BOM。字符串字面量（含注释样文本）原样保留。
 */
export function parseJsonc(input: string): unknown {
  return JSON.parse(stripTrailingCommas(maskJsonComments(stripLeadingBom(input))))
}

export interface JsoncFile {
  path: string
  text: string
  data: unknown
}

/** 读取并解析一个 JSONC 文件；文件不存在返回 `null`，解析失败抛错。 */
export async function readJsoncFile(configPath: string): Promise<JsoncFile | null> {
  let text: string
  try {
    text = await fs.readFile(configPath, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }
  return { path: configPath, text, data: parseJsonc(text) }
}

/** 值在文本中的下标区间（`[valueStart, valueEnd)`）。 */
export interface ValueSpan {
  /** 键（字符串字面量，含引号）的起始下标。 */
  keyStart: number
  /** 值的起始下标（含）。 */
  valueStart: number
  /** 值的结束下标（不含）。 */
  valueEnd: number
}

/** 对象自身的下标区间（`{` 与 `}` 的位置）。 */
export interface ObjectSpan {
  start: number
  end: number
}

/** 找到根对象；根不是对象时返回 `undefined`。 */
export function findRootObject(masked: string): ObjectSpan | undefined {
  let start = 0
  while (start < masked.length && isWhitespace(masked[start] as string)) {
    start += 1
  }
  if (masked[start] !== "{") {
    return undefined
  }
  return { start, end: findValueEnd(masked, start, masked.length) }
}

/**
 * 在某个对象的**直接**属性中查找指定键，返回其值区间。
 *
 * 只匹配处于该对象第一层深度的键，嵌套对象里的同名键不会被误判。
 */
export function findPropertyInObject(
  masked: string,
  object: ObjectSpan,
  key: string,
): ValueSpan | undefined {
  let i = object.start + 1
  let depth = 1

  while (i < object.end) {
    const char = masked[i] as string

    if (char === '"') {
      const strEnd = readString(masked, i)
      const name = parseStringLiteral(masked.slice(i, strEnd))
      let j = strEnd
      while (j < object.end && isWhitespace(masked[j] as string)) {
        j += 1
      }
      if (depth === 1 && masked[j] === ":" && name === key) {
        let valueStart = j + 1
        while (valueStart < object.end && isWhitespace(masked[valueStart] as string)) {
          valueStart += 1
        }
        const valueEnd = trimEnd(masked, valueStart, findValueEnd(masked, valueStart, object.end))
        return { keyStart: i, valueStart, valueEnd }
      }
      i = strEnd
      continue
    }

    if (char === "{" || char === "[") {
      depth += 1
    } else if (char === "}" || char === "]") {
      depth -= 1
    }
    i += 1
  }

  return undefined
}

/** 在根对象的直接属性中查找指定键。 */
export function findTopLevelProperty(masked: string, key: string): ValueSpan | undefined {
  const root = findRootObject(masked)
  if (!root) {
    return undefined
  }
  return findPropertyInObject(masked, root, key)
}

export interface UpsertResult {
  /** 更新后的完整文本。 */
  text: string
  /** 是否发生了实质改动。 */
  changed: boolean
}

/**
 * 把一组 policy 写入 / 更新到 `experimental.policies`。
 *
 * 行为：
 * - 根对象不存在 → 原样返回；
 * - 已有 `experimental.policies` → 只替换该数组，其余注释与格式保留；
 * - 已有 `experimental` 但无 `policies` → 在对象内追加；
 * - 无 `experimental` → 在根对象末尾追加 `"experimental": { "policies": [...] }`。
 *
 * 注意：`experimental.policies` 数组**内部**的注释不会保留（数组会被重排），
 * 文件其余部分（包括数组以外的所有注释）逐字节保留。
 */
export function upsertExperimentalPolicies(
  text: string,
  policies: readonly unknown[],
): UpsertResult {
  const masked = maskJsonComments(text)
  const root = findRootObject(masked)
  if (!root) {
    return { text, changed: false }
  }

  const unit = detectIndentUnit(masked)
  const rootIndent = detectObjectIndent(masked, root)
  const experimental = findPropertyInObject(masked, root, "experimental")

  if (!experimental) {
    const expIndent = rootIndent
    const policiesIndent = rootIndent + unit
    const value = `{\n${policiesIndent}"policies": ${renderPolicyArray(policies, policiesIndent, unit)}\n${expIndent}}`
    const next = insertProperty(text, masked, root, `"experimental": ${value}`, expIndent)
    return { text: next, changed: next !== text }
  }

  const experimentalObject: ObjectSpan = {
    start: experimental.valueStart,
    end: experimental.valueEnd,
  }
  const isObject = masked[experimental.valueStart] === "{"

  if (!isObject) {
    // `experimental` 不是对象（异常配置）：整体替换为 `{ "policies": [...] }`。
    const expIndent = indentAt(masked, experimental.keyStart)
    const policiesIndent = expIndent + unit
    const value = `{\n${policiesIndent}"policies": ${renderPolicyArray(policies, policiesIndent, unit)}\n${expIndent}}`
    const next =
      text.slice(0, experimental.valueStart) + value + text.slice(experimental.valueEnd)
    return { text: next, changed: next !== text }
  }

  const policiesSpan = findPropertyInObject(masked, experimentalObject, "policies")
  if (policiesSpan) {
    const rendered = renderPolicyArray(policies, indentAt(masked, policiesSpan.keyStart), unit)
    const next = text.slice(0, policiesSpan.valueStart) + rendered + text.slice(policiesSpan.valueEnd)
    return { text: next, changed: next !== text }
  }

  const expIndent = indentAt(masked, experimental.keyStart)
  const policiesIndent = expIndent + unit
  const property = `"policies": ${renderPolicyArray(policies, policiesIndent, unit)}`
  const next = insertProperty(text, masked, experimentalObject, property, policiesIndent)
  return { text: next, changed: next !== text }
}

/**
 * 把一个属性插入对象的末尾。
 *
 * `object.start` 指向 `{`，`object.end` 指向 `}` 之后。
 */
function insertProperty(
  text: string,
  masked: string,
  object: ObjectSpan,
  property: string,
  propertyIndent: string,
): string {
  const innerStart = object.start + 1
  const innerEnd = object.end - 1
  const inner = text.slice(innerStart, innerEnd)
  const trimmedRight = inner.replace(/\s+$/, "")

  if (trimmedRight.trim() === "") {
    // 空对象：用换行 + 缩进填充。
    const objectIndent = indentAt(masked, object.start)
    const insert = `\n${propertyIndent}${property}\n${objectIndent}`
    return text.slice(0, innerStart) + insert + text.slice(innerEnd)
  }

  const contentEnd = innerStart + trimmedRight.length
  const comma = trimmedRight.endsWith(",") ? "" : ","
  const insert = `${comma}\n${propertyIndent}${property}`
  return text.slice(0, contentEnd) + insert + text.slice(contentEnd)
}

/** 渲染 policy 数组（多行、按给定缩进）。 */
function renderPolicyArray(
  policies: readonly unknown[],
  baseIndent: string,
  unit: string,
): string {
  if (policies.length === 0) {
    return "[]"
  }
  const inner = baseIndent + unit
  const lines = policies.map((policy) => `${inner}${renderPolicy(policy)}`)
  return `[\n${lines.join(",\n")}\n${baseIndent}]`
}

/** 渲染单条 policy：标准三字段用可读写法，其它值回退到紧凑 JSON。 */
function renderPolicy(policy: unknown): string {
  if (isPolicyLike(policy)) {
    const action = JSON.stringify(policy.action)
    const resource = JSON.stringify(policy.resource)
    const effect = JSON.stringify(policy.effect)
    return `{ "action": ${action}, "resource": ${resource}, "effect": ${effect} }`
  }
  return JSON.stringify(policy) ?? "null"
}

function isPolicyLike(
  value: unknown,
): value is { action: string; resource: string; effect: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.action === "string" &&
    typeof record.resource === "string" &&
    typeof record.effect === "string"
  )
}

/** 找到 value 的结束下标（不含）。 */
function findValueEnd(masked: string, start: number, limit: number): number {
  const first = masked[start]

  if (first === "{" || first === "[") {
    let depth = 0
    let i = start
    while (i < limit) {
      const char = masked[i] as string
      if (char === '"') {
        i = readString(masked, i)
        continue
      }
      if (char === "{" || char === "[") {
        depth += 1
      } else if (char === "}" || char === "]") {
        depth -= 1
        if (depth === 0) {
          return i + 1
        }
      }
      i += 1
    }
    return limit
  }

  if (first === '"') {
    return readString(masked, start)
  }

  let i = start
  while (i < limit) {
    const char = masked[i] as string
    if (char === "," || char === "}" || char === "]") {
      return i
    }
    i += 1
  }
  return limit
}

/** 从 `"` 开始读取一个字符串字面量，返回闭合引号之后的下标。 */
function readString(masked: string, start: number): number {
  let i = start + 1
  while (i < masked.length) {
    const char = masked[i] as string
    if (char === "\\") {
      i += 2
      continue
    }
    if (char === '"') {
      return i + 1
    }
    i += 1
  }
  return masked.length
}

/** 解析一个完整的字符串字面量（含引号）。 */
function parseStringLiteral(literal: string): string {
  try {
    const parsed = JSON.parse(literal)
    return typeof parsed === "string" ? parsed : literal
  } catch {
    return literal
  }
}

function trimEnd(masked: string, start: number, end: number): number {
  let result = end
  while (result > start && isWhitespace(masked[result - 1] as string)) {
    result -= 1
  }
  return result
}

/** 推断缩进单位（首个被缩进的顶层行）。 */
function detectIndentUnit(masked: string): string {
  const match = /(?:^|\n)([ \t]+)\S/.exec(masked)
  return match?.[1] ?? "  "
}

/** 对象 `{` 所在行的缩进。 */
function detectObjectIndent(masked: string, object: ObjectSpan): string {
  let i = object.start + 1
  while (i < object.end && isWhitespace(masked[i] as string)) {
    i += 1
  }
  if (i >= object.end) {
    return indentAt(masked, object.start)
  }
  return indentAt(masked, i)
}

/** 某个下标所在行的前导空白。 */
function indentAt(masked: string, index: number): string {
  const lineStart = masked.lastIndexOf("\n", Math.max(index - 1, 0)) + 1
  const match = /^[ \t]*/.exec(masked.slice(lineStart, index))
  return match ? match[0] : ""
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r"
}

/** 稳定的结构比较 / 序列化（对象键排序）。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** 判断两个值在结构上是否相等（忽略对象键顺序）。 */
export function structurallyEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}
