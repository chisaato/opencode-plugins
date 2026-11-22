import { mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const flags = process.argv.slice(2).filter((arg) => arg !== "--")
if (flags.some((flag) => flag !== "--service-only")) {
  throw new Error("Usage: bun scripts/build.ts [--service-only]")
}

interface Entry {
  source: string
  output: string
  target: "node" | "browser"
  optional?: boolean
}

const entries: Entry[] = [
  { source: "service/main.ts", output: "service/main.js", target: "node" },
]
if (!flags.includes("--service-only")) {
  entries.push(
    { source: "panel/main.ts", output: "panel/main.js", target: "browser", optional: true },
    { source: "status/main.ts", output: "status/main.js", target: "browser", optional: true },
    { source: "../mux/src/index.ts", output: "opencode-plugin/index.js", target: "node", optional: true },
  )
}

for (const { source, output, target, optional } of entries) {
  const entry = resolve(root, source)
  try {
    if (!(await stat(entry)).isFile()) throw new Error(`Expected a file: ${source}`)
  } catch (error) {
    if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    console.log(`Skip ${source} (entry not found)`)
    continue
  }
  const isNode = target === "node"
  const result = await Bun.build({
    entrypoints: [entry],
    target,
    format: isNode ? "esm" : "iife",
    minify: !isNode,
    external: isNode ? ["node:*"] : [],
    // 不设置 outdir，产物留在内存，由脚本写入清单指定的路径。
    throw: false,
  })
  if (!result.success || !result.outputs[0]) {
    throw new Error(`Failed to build ${source}\n${result.logs.join("\n")}`)
  }
  const outfile = resolve(root, output)
  await mkdir(dirname(outfile), { recursive: true })
  await writeFile(outfile, await result.outputs[0].text())
  console.log(`Built ${source} → ${output}`)
}
