import { beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AutoModelConfigPlugin } from "../../src/index"

let home: string
const cleanups: (() => unknown)[] = []

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oc-plugin-home-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("OPENCODE_TEST_HOME", home)
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(home, { recursive: true, force: true })
})

export async function setupPlugin(ctx: Parameters<typeof AutoModelConfigPlugin.setup>[0]) {
  const cleanup = await AutoModelConfigPlugin.setup(ctx)
  if (typeof cleanup === "function") cleanups.push(cleanup)
  return cleanup
}
