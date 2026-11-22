// 剥离常见 ANSI 转义序列，并模拟终端单行回车覆盖（\r）效果。
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|[PX^_][^\x1B]*\x1B\\)/g

function applyCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line
  const parts = line.split("\r")
  let buffer = ""
  for (const part of parts) {
    if (part.length >= buffer.length) {
      buffer = part
    } else {
      buffer = part + buffer.slice(part.length)
    }
  }
  return buffer
}

/** 清理日志中的 ANSI 控制码并规范化换行与回车覆盖。 */
export function cleanTerminalOutput(raw: string): string {
  if (!raw) return ""
  const withoutAnsi = raw.replace(ANSI_PATTERN, "")
  const normalizedNewlines = withoutAnsi.replace(/\r\n/g, "\n")
  const lines = normalizedNewlines.split("\n")
  return lines.map(applyCarriageReturns).join("\n")
}
