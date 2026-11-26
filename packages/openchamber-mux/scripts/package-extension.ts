import { execFileSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// 用法：bun scripts/package-extension.ts [--version <semver>]
// 未给 --version 时，尝试从 npm 上已发布的最新版本推导。
const args = process.argv.slice(2).filter((arg) => arg !== "--")
let version: string | undefined
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version") version = args[++i]
  else throw new Error(`未知参数：${args[i]}`)
}
if (version !== undefined && !VERSION_RE.test(version)) throw new Error(`无效版本：${version}`)

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  name: string
  version: string
  files?: string[]
}

if (version === undefined && !manifest.name.includes("{{")) {
  try {
    version = execFileSync("npm", ["view", manifest.name, "version"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    version = undefined
  }
}
if (version === undefined) {
  throw new Error("无法确定版本，请用 --version <semver> 指定（例如 0.1.4）")
}
if (!VERSION_RE.test(version)) throw new Error(`推导出的版本无效：${version}`)

// 构建运行产物（panel/main.js、status/main.js、service/main.js、opencode-plugin/index.js）。
execFileSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" })

// 在临时目录组装，不在工作区里改 package.json 的占位版本。
const stage = await mkdtemp(join(tmpdir(), "oc-ext-"))
try {
  const entries = ["package.json", ...(manifest.files ?? [])]
  for (const entry of entries) {
    const dest = join(stage, entry)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(root, entry), dest)
  }
  const stagedManifest = JSON.parse(await readFile(join(stage, "package.json"), "utf8")) as Record<string, unknown>
  stagedManifest.version = version
  await writeFile(join(stage, "package.json"), JSON.stringify(stagedManifest, null, 2) + "\n")

  const outfile = join(root, `openchamber-mux-${version}.zip`)
  await rm(outfile, { force: true })
  // 在 stage 内执行，archive 里路径为 package.json / panel/... 等，无前缀目录。
  execFileSync("zip", ["-q", "-r", outfile, ...entries], { cwd: stage, stdio: "inherit" })
  console.log(`已打包 ${outfile}（version=${version}）`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
