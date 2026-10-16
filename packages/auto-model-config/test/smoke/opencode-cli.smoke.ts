#!/usr/bin/env bun
/**
 * 真实 OpenCode CLI smoke（环境变量门控，默认跳过）
 * ---------------------------------------------------------------
 * 目的：
 *   在完全隔离的临时 HOME / XDG / 临时项目中，用真实 OpenCode CLI 加载本仓库插件，
 *   验证插件确实被宿主加载。
 *
 * 为什么默认关闭：
 *   OpenCode CLI 的插件加载相关子命令（`plugin list`、`debug config`）会连接或拉起
 *   后台服务；在多进程/服务未就绪时可能长时间阻塞。普通 `bunx vitest run` 不应因此挂起。
 *   本文件命名为 `*.smoke.ts`，vitest 默认不会收集它。
 *
 * 使用：
 *   OPENCODE_CLI_SMOKE=1 bun run test/smoke/opencode-cli.smoke.ts
 *   可选：
 *     OPENCODE_CLI_SMOKE_TIMEOUT_MS=60000   子进程硬超时（默认 60000ms）
 *     OPENCODE_CLI_SMOKE_BIN=/path/to/opencode
 *     OPENCODE_CLI_SMOKE_KEEP=1              失败时保留临时目录以便排查
 *
 * 隔离保证：
 *   所有 HOME / XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME
 *   都指向新建的临时目录；绝不读写真实 ~/.config/opencode。
 *
 * 退出码：
 *   0 = 通过或跳过（未设置门控变量时为跳过）
 *   1 = 失败（超时、CLI 非零退出、未生成可解析的 dump、或 dump 中无任何实际填充记录）
 *
 * PASS 判据（强判据，无弱回退）：
 *   CLI 正常退出后，debug dump 必须存在且可 JSON 解析，并且满足以下之一：
 *     - `_meta.summary.modelsFilled > 0`
 *     - 任一 provider/model 条目存在非空 `_filled` 数组
 *   仅凭输出包含仓库 basename（opencode-auto-model-config）不再视为通过。
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..")

function log(msg: string) {
  console.log(`[smoke] ${msg}`)
}

/** 同步 sleep（避免依赖 Bun 专有全局，保持 tsc 类型安全）。 */
function sleepSync(ms: number) {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

if (process.env.OPENCODE_CLI_SMOKE !== "1") {
  log("SKIPPED（默认关闭）。设置 OPENCODE_CLI_SMOKE=1 后重跑以执行真实 CLI smoke。")
  process.exit(0)
}

const timeoutMs = Number(process.env.OPENCODE_CLI_SMOKE_TIMEOUT_MS ?? 60_000)
const opencodeBin = process.env.OPENCODE_CLI_SMOKE_BIN || "opencode"
const keep = process.env.OPENCODE_CLI_SMOKE_KEEP === "1"

const realHome = path.resolve(os.homedir())

// 临时根目录在创建后赋值，保证任何失败路径都能清理
let root = ""

function cleanup() {
  if (!root) return
  if (keep) {
    log(`保留临时目录以便排查: ${root}`)
    return
  }
  fs.rmSync(root, { recursive: true, force: true })
}

function fail(msg: string): never {
  cleanup()
  console.error(`[smoke] FAIL: ${msg}`)
  process.exit(1)
}

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  fail(`OPENCODE_CLI_SMOKE_TIMEOUT_MS 非法: ${process.env.OPENCODE_CLI_SMOKE_TIMEOUT_MS}`)
}

root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cli-smoke-"))
const home = path.join(root, "home")
const project = path.join(root, "project")

const xdgConfig = path.join(home, ".config")
const xdgData = path.join(home, ".local", "share")
const xdgState = path.join(home, ".local", "state")
const xdgCache = path.join(home, ".cache")

// 硬性隔离断言：绝不能把 HOME 指向真实主目录
if (path.resolve(home) === realHome || path.resolve(home).startsWith(realHome + path.sep)) {
  fail(`隔离 HOME 解析到真实主目录下: ${home}（realHome=${realHome}）`)
}

const pluginConfigDir = path.join(xdgConfig, "opencode")
const modelsDevCache = path.join(root, "models-dev.json")
const dumpPath = path.join(root, "expanded-config.json")

try {
  // 1. 临时目录结构
  fs.mkdirSync(pluginConfigDir, { recursive: true })
  fs.mkdirSync(xdgData, { recursive: true })
  fs.mkdirSync(xdgState, { recursive: true })
  fs.mkdirSync(xdgCache, { recursive: true })
  fs.mkdirSync(project, { recursive: true })

  // 2. 隔离的全局 OpenCode 配置：通过本地包路径加载本仓库插件
  fs.writeFileSync(
    path.join(pluginConfigDir, "opencode.json"),
    JSON.stringify(
      {
        plugins: [REPO_ROOT],
        providers: {
          "smoke-provider": {
            name: "Smoke Provider",
            npm: "@ai-sdk/openai-compatible",
            models: { "smoke-gpt4o": {} },
          },
        },
      },
      null,
      2,
    ),
  )

  // 3. 本地 models.dev 缓存夹具（不发网络请求）
  const fakeModelsDevData = {
    openai: {
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      env: [],
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          name: "GPT-4o Official",
          family: "gpt",
          attachment: true,
          reasoning: false,
          tool_call: true,
          release_date: "2024-05-13",
          last_updated: "2024-08-06",
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          open_weights: false,
          cost: { input: 2.5, output: 10, cache_read: 1.25 },
          limit: { context: 128000, output: 16384 },
        },
      },
    },
  }
  fs.writeFileSync(
    modelsDevCache,
    JSON.stringify({ _fetchedAt: Date.now(), data: fakeModelsDevData }),
  )

  // 4. 项目级插件映射配置（含 debug dump，便于观察 transform 是否执行）
  fs.writeFileSync(
    path.join(project, "oc-auto-model-config.json"),
    JSON.stringify(
      {
        cachePath: modelsDevCache,
        mapping: { "smoke-provider": { "smoke-gpt4o": "openai/gpt-4o" } },
        debug: { enabled: true, dumpPath, diffOnly: false },
      },
      null,
      2,
    ),
  )

  // 5. 最小、完全隔离的子进程环境
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    TMPDIR: root,
    TERM: "dumb",
  }
  fs.mkdirSync(childEnv.XDG_RUNTIME_DIR, { recursive: true })
  if (process.env.LANG) childEnv.LANG = process.env.LANG

  log(`启动真实 CLI: ${opencodeBin} plugin list --print-logs`)
  log(`隔离 HOME=${home} timeout=${timeoutMs}ms`)

  const startedAt = Date.now()
  const result = spawnSync(opencodeBin, ["plugin", "list", "--print-logs"], {
    cwd: project,
    env: childEnv,
    timeout: timeoutMs,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  })
  const elapsed = Date.now() - startedAt

  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  const combined = `${stdout}\n${stderr}`

  // 6a. 超时 → 快速失败并说明原因
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    fail(
      `CLI 在 ${timeoutMs}ms 内未完成（实际 ${elapsed}ms），疑似后台服务/多进程启动超时。` +
        `真实 smoke 未验证。若本机服务正常，可增大 OPENCODE_CLI_SMOKE_TIMEOUT_MS 重试。` +
        `\n--- 已捕获输出 ---\n${combined.slice(0, 4000)}`,
    )
  }
  if (result.signal) {
    fail(
      `CLI 被信号 ${result.signal} 终止（实际 ${elapsed}ms）。真实 smoke 未验证。` +
        `\n--- 已捕获输出 ---\n${combined.slice(0, 4000)}`,
    )
  }
  if (result.error) {
    fail(`无法启动 CLI（${opencodeBin}）: ${result.error.message}`)
  }

  // 6b. 非零退出 → 失败
  if (result.status !== 0) {
    fail(
      `CLI 退出码 ${result.status}（实际 ${elapsed}ms）。` +
        `\n--- stdout ---\n${stdout.slice(0, 4000)}\n--- stderr ---\n${stderr.slice(0, 4000)}`,
    )
  }

  // 7. 观察 transform 是否真正执行：必须存在可解析的 dump 且实际填充了模型。
  //    删除了仅凭输出包含仓库 basename 的弱回退（会假阳性）。
  const observedInOutput = combined.includes("opencode-auto-model-config")
  if (!observedInOutput) {
    log("输出中未包含 opencode-auto-model-config（不单独作为判据，仅记录）")
  }

  // dump 由 transform 内部的异步 fire-and-forget 写入，CLI 退出后可能尚未落盘，
  // 因此在有限时间内轮询等待（最多 2s）。
  const dumpWaitMs = Math.min(2000, timeoutMs)
  const dumpDeadline = Date.now() + dumpWaitMs
  while (!fs.existsSync(dumpPath) && Date.now() < dumpDeadline) {
    sleepSync(50)
  }
  const dumpExists = fs.existsSync(dumpPath)

  if (!dumpExists) {
    fail(
      `未生成 debug dump，无法证明 transform 执行。期望文件: ${dumpPath}` +
        `\n--- stdout ---\n${stdout.slice(0, 4000)}\n--- stderr ---\n${stderr.slice(0, 4000)}`,
    )
  }

  let dumpData: any
  try {
    dumpData = JSON.parse(fs.readFileSync(dumpPath, "utf-8"))
  } catch (err) {
    fail(
      `debug dump 存在但无法解析为 JSON: ${err instanceof Error ? err.message : String(err)}` +
        `\n文件: ${dumpPath}`,
    )
  }

  const modelsFilled = Number(dumpData?._meta?.summary?.modelsFilled ?? 0)
  let hasFilledRecords = false
  const providers = dumpData?.provider ?? {}
  for (const providerEntry of Object.values<any>(providers)) {
    const models = providerEntry?.models ?? {}
    for (const modelEntry of Object.values<any>(models)) {
      if (Array.isArray(modelEntry?._filled) && modelEntry._filled.length > 0) {
        hasFilledRecords = true
      }
    }
  }

  if (!(modelsFilled > 0 || hasFilledRecords)) {
    fail(
      `dump 已生成但未观察到任何实际填充证据（modelsFilled=${modelsFilled}, hasFilledRecords=${hasFilledRecords}）。` +
        `\n文件: ${dumpPath}\n--- dump 片段 ---\n${fs.readFileSync(dumpPath, "utf-8").slice(0, 4000)}`,
    )
  }

  log(
    `PASS（${elapsed}ms）：dump=${dumpPath} modelsFilled=${modelsFilled} hasFilledRecords=${hasFilledRecords}`,
  )
  log(`dump 内容片段：\n${fs.readFileSync(dumpPath, "utf-8").slice(0, 2000)}`)
  cleanup()
  process.exit(0)
} catch (err) {
  cleanup()
  fail(`未捕获异常: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
}
