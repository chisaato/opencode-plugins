import { describe, it, expect, beforeEach, afterEach } from "vitest"
import path from "node:path"
import os from "node:os"
import { getGlobalConfigDir, getDefaultCachePath, getDefaultDumpPath } from "../src/utils/paths"

describe("Unified Path Resolution and XDG / Test Isolation", () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.XDG_CONFIG_HOME
    delete process.env.OPENCODE_TEST_HOME
  })

  afterEach(() => {
    process.env = { ...origEnv }
  })

  it("respects injected homeDirectory option", () => {
    const fakeHome = "/custom/fake/home"
    const dir = getGlobalConfigDir({ homeDirectory: fakeHome })
    expect(dir).toBe(path.join(fakeHome, ".config", "opencode"))
    expect(getDefaultCachePath({ homeDirectory: fakeHome })).toBe(path.join(fakeHome, ".config", "opencode", "models-dev.json"))
  })

  it("respects XDG_CONFIG_HOME when no explicit home option given", () => {
    process.env.XDG_CONFIG_HOME = "/custom/xdg/config"
    const dir = getGlobalConfigDir()
    expect(dir).toBe(path.join("/custom/xdg/config", "opencode"))
    expect(getDefaultCachePath()).toBe(path.join("/custom/xdg/config", "opencode", "models-dev.json"))
    expect(getDefaultDumpPath()).toBe(path.join("/custom/xdg/config", "opencode", "expanded-config.json"))
  })

  it("prefers OPENCODE_TEST_HOME over XDG_CONFIG_HOME when both are set", () => {
    process.env.OPENCODE_TEST_HOME = "/custom/test/home"
    process.env.XDG_CONFIG_HOME = "/custom/xdg/config"
    const dir = getGlobalConfigDir()
    expect(dir).toBe(path.join("/custom/test/home", ".config", "opencode"))
  })

  it("falls back to os.homedir()/.config/opencode in standard environment", () => {
    const dir = getGlobalConfigDir()
    expect(dir).toBe(path.join(os.homedir(), ".config", "opencode"))
  })
})
