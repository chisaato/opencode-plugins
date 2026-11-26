import { spawn } from "node:child_process"
import { once } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { readForegroundCommand } from "../src"

describe("readForegroundCommand", () => {
  it("never throws for undefined, invalid, or missing pids", () => {
    for (const pid of [undefined, -1, 0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => readForegroundCommand(pid)).not.toThrow()
      expect(readForegroundCommand(pid)).toBeUndefined()
    }
  })

  it("reads the current process best-effort", () => {
    let command: string | undefined
    expect(() => { command = readForegroundCommand(process.pid) }).not.toThrow()
    expect(command === undefined || typeof command === "string").toBe(true)
    expect(command?.length ?? 0).toBeLessThanOrEqual(400)
  })

  it.skipIf(!["linux", "darwin"].includes(process.platform))("detects a non-shell pane root", async () => {
    const child = spawn("sleep", ["60"])
    try {
      await once(child, "spawn")
      expect(readForegroundCommand(child.pid)).toContain("sleep 60")
    } finally {
      const exited = once(child, "exit")
      child.kill()
      await exited
    }
  })

  it.skipIf(!["linux", "darwin"].includes(process.platform))("walks through shell wrappers", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { detached: true })
    try {
      await once(child, "spawn")
      await vi.waitFor(() => expect(readForegroundCommand(child.pid)).toContain("sleep 60"))
    } finally {
      const exited = once(child, "exit")
      process.kill(-child.pid!, "SIGTERM")
      await exited
    }
  })
})
