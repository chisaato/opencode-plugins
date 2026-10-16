import { describe, expect, it } from "vitest"
import { createState } from "../src/state"

describe("createState", () => {
  it("同一会话同一规则的连续失败递增，有进展后清零", () => {
    const state = createState()

    expect(state.recordFailure("ses_1", 0)).toBe(1)
    expect(state.recordFailure("ses_1", 0)).toBe(2)
    state.recordProgress("ses_1")
    expect(state.recordFailure("ses_1", 0)).toBe(1)
  })

  it("不同会话、不同规则的计数互不影响", () => {
    const state = createState()

    expect(state.recordFailure("ses_1", 0)).toBe(1)
    expect(state.recordFailure("ses_2", 0)).toBe(1)
    expect(state.recordFailure("ses_1", 1)).toBe(1)
    state.recordProgress("ses_1")
    expect(state.recordFailure("ses_2", 0)).toBe(2)
    expect(state.recordFailure("ses_1", 0)).toBe(1)
  })

  it("同一会话只占一条计数，进展后把条目清掉", () => {
    const state = createState()

    state.recordFailure("ses_1", 0)
    state.recordFailure("ses_1", 0)
    expect(state.size()).toBe(1)
    state.recordFailure("ses_2", 0)
    expect(state.size()).toBe(2)
    state.recordProgress("ses_1")
    expect(state.size()).toBe(1)
    state.recordProgress("ses_2")
    expect(state.size()).toBe(0)
  })
})
