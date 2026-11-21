/** JSONC 解析：掩码注释、去除结构尾逗号，不触碰字符串字面量。 */
export function parseJsonc(input: string): unknown {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  let masked = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (char === '"' && (i === 0 || countBackslashes(text, i) % 2 === 0)) inString = !inString
    if (!inString && char === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const block = text[i + 1] === "*"
      masked += "  "
      i++
      while (i + 1 < text.length) {
        const next = text[i + 1] as string
        if ((!block && next === "\n") || (block && text[i + 1] === "*" && text[i + 2] === "/")) break
        masked += next === "\n" ? "\n" : " "
        i++
      }
      if (block && text[i + 1] === "*" && text[i + 2] === "/") {
        masked += "  "
        i += 2
      }
      continue
    }
    masked += char
  }
  let result = ""
  inString = false
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i] as string
    if (char === '"' && countBackslashes(masked, i) % 2 === 0) inString = !inString
    if (!inString && char === "," && /^[\s]*[}\]]/.test(masked.slice(i + 1))) {
      result += " "
    } else {
      result += char
    }
  }
  return JSON.parse(result)
}

function countBackslashes(text: string, index: number): number {
  let count = 0
  while (text[index - count - 1] === "\\") count++
  return count
}
