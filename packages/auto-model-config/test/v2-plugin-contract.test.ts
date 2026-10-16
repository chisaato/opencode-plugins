import { describe, it, expect } from "vitest"
import { AutoModelConfigPlugin } from "../src/index"
import { Plugin } from "@opencode/plugin"

describe("V2 Plugin Export & Contract", () => {
  it("exports Plugin.define result with id and setup function, including default export", async () => {
    const mod = await import("../src/index")
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe("opencode-auto-model-config")
    expect(typeof mod.default.setup).toBe("function")
    expect(mod.default).toBe(AutoModelConfigPlugin)
    expect(AutoModelConfigPlugin).toBeDefined()
    expect(AutoModelConfigPlugin.id).toBe("opencode-auto-model-config")
    expect(typeof AutoModelConfigPlugin.setup).toBe("function")
  })
})
