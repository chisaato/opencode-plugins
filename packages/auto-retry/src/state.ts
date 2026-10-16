/**
 * 会话内的连续失败计数。
 *
 * 按 sessionID + 规则下标分开记。recordProgress 删掉该会话的条目，
 * 所以成功之后表不会越积越大。同一次失败的去重不在这里，由处理器的会话闩负责。
 */
export function createState() {
  const counts = new Map<string, number>()

  return {
    recordFailure(sessionID: string, ruleIndex: number): number {
      const key = countKey(sessionID, ruleIndex)
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return next
    },

    recordProgress(sessionID: string): void {
      const prefix = `${sessionID}\0`
      for (const key of counts.keys()) {
        if (key.startsWith(prefix)) counts.delete(key)
      }
    },

    /** 只清掉一条规则的连续失败，推进量够了但还没正常结束时用。 */
    clearRule(sessionID: string, ruleIndex: number): void {
      counts.delete(countKey(sessionID, ruleIndex))
    },

    /** 当前还留着的计数条目。测试用来确认进展之后会清掉。 */
    size(): number {
      return counts.size
    },
  }
}

export type RetryState = ReturnType<typeof createState>

function countKey(sessionID: string, ruleIndex: number): string {
  return `${sessionID}\0${ruleIndex}`
}
