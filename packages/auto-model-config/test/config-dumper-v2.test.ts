import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ConfigDumper } from "../src/debug/config-dumper"
import type { ResolvedModel } from "../src/types"

describe("V2 ConfigDumper statistics and diffOnly", () => {
  const tmpDir = path.join(os.tmpdir(), "oc-dumper-v2-test-" + Date.now())
  const dumpPath = path.join(tmpDir, "dump.json")

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("accurately records filled, skipped, and warning models in meta statistics, honoring diffOnly", async () => {
    const dumper = new ConfigDumper({ enabled: true, dumpPath, diffOnly: true })
    const resolvedModels = new Map<string, Map<string, ResolvedModel>>()

    const enhancedModels = {
      "custom-provider": {
        "gpt-4o-filled": {
          source: "openai/gpt-4o",
          filledFields: ["family", "cost"],
          model: {
            name: "Explicit User Name",
            family: "gpt",
            cost: [{ input: 2.5, output: 10, cache: { read: 1.25, write: 0 } }],
          },
        },
        "gpt-4o-skipped": {
          source: "openai/gpt-4o",
          filledFields: [],
          skipped: true,
        },
        "gpt-4o-warn": {
          source: "openai/not-found",
          filledFields: [],
          warning: "Model not found",
        },
      },
    }

    await dumper.dumpV2(enhancedModels, resolvedModels, 10)

    const raw = await fs.readFile(dumpPath, "utf-8")
    const parsed = JSON.parse(raw)

    expect(parsed._meta.summary.providersProcessed).toBe(1)
    expect(parsed._meta.summary.modelsFilled).toBe(1)
    expect(parsed._meta.summary.modelsSkipped).toBe(1)
    expect(parsed._meta.summary.modelsNotFound).toBe(1)

    // diffOnly 验证：只包含实际自动填充的 family 和 cost，不包含用户显式提供的 name
    const filledEntry = parsed.provider["custom-provider"].models["gpt-4o-filled"]
    expect(filledEntry.family).toBe("gpt")
    expect(filledEntry.cost).toBeDefined()
    expect(filledEntry.name).toBeUndefined()
    expect(filledEntry._filled).toEqual(["family", "cost"])

    const skippedEntry = parsed.provider["custom-provider"].models["gpt-4o-skipped"]
    expect(skippedEntry._skipped).toBe(true)

    const warnEntry = parsed.provider["custom-provider"].models["gpt-4o-warn"]
    expect(warnEntry._warning).toBe("Model not found")
  })
})
