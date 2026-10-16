// 只读 JSONC：容忍行注释、块注释和尾逗号。插件不改写用户配置。

import fs from "node:fs/promises"

/** 把注释换成等长空白，字符串里的内容原样保留。 */
export function maskJsonComments(input: string): string {
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
      if (char === '"') inString = false
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

    if (char === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") {
        out += " "
        i += 1
      }
      continue
    }

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

/** 去掉 `}` / `]` 前的尾逗号，字符串内的逗号不动。 */
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
      if (char === '"') inString = false
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
      while (j < input.length && isWhitespace(input[j] as string)) j += 1
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

/** 解析 JSONC 文本。非法 JSON 会抛出。 */
export function parseJsonc(input: string): unknown {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  return JSON.parse(stripTrailingCommas(maskJsonComments(text)))
}

/**
 * 读取 JSONC 文件。
 * 文件不存在返回 null；读失败或解析失败抛出，由调用方决定是否吞掉。
 */
export async function readJsoncFile(filePath: string): Promise<unknown | null> {
  try {
    const text = await fs.readFile(filePath, "utf-8")
    return parseJsonc(text)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r"
}
