import type { HostClient } from "@openchamber/sdk"
import { describe, expect, it, vi } from "vitest"
import type { HistoryCleanResponse, HistoryPreviewResponse, SessionCloseResponse } from "../src/types"
import {
  createMuxClient,
  formatClientError,
  HISTORY_CLEAN_MAX_BODY_BYTES,
  HistoryCleanPartialError,
  ServiceApiError,
  splitHistoryCleanBatches,
} from "../src/ui/client"

function mockClient(status: number, body: string) {
  const serviceRequest = vi.fn<HostClient["serviceRequest"]>().mockResolvedValue({ status, body })
  const host: Pick<HostClient, "serviceRequest"> = { serviceRequest }
  const client = createMuxClient(host as HostClient)
  return { client, serviceRequest }
}

describe("关闭会话客户端", () => {
  const body = { cwd: "/projects/with space" }

  it("向关闭端点 POST JSON 而不是传查询参数，并返回共享响应", async () => {
    const response = { ok: true, removed: 2, sessionName: "oc-project" } satisfies SessionCloseResponse
    const { client, serviceRequest } = mockClient(200, JSON.stringify(response))

    await expect(client.closeSession(body)).resolves.toEqual(response)
    expect(serviceRequest).toHaveBeenCalledExactlyOnceWith({
      method: "POST",
      path: "/session/close",
      query: undefined,
      body: JSON.stringify(body),
    })
  })

  it("沿用共享 HTTP 错误和反馈映射", async () => {
    const { client } = mockClient(401, JSON.stringify({ error: "Unauthorized" }))
    const request = client.closeSession(body)

    await expect(request).rejects.toBeInstanceOf(ServiceApiError)
    await expect(request.catch(formatClientError)).resolves.toMatchObject({
      code: 401,
      detail: "本地服务鉴权失败",
    })
  })

  it.each([
    [200, "invalid JSON", "服务返回了无法解析的响应内容"],
    [200, "", "服务返回了空响应"],
    [404, "", "未找到对应会话，或当前本地服务不支持关闭会话"],
    [404, JSON.stringify({ error: "Not found" }), "未找到对应会话，或当前本地服务不支持关闭会话"],
  ])("保留错误反馈：HTTP %i，响应 %j", async (status, raw, message) => {
    const { client } = mockClient(status, raw)
    await expect(client.closeSession(body)).rejects.toMatchObject({ status, message })
  })
})

describe("历史清理客户端", () => {
  const cwd = "/projects/with space"

  it("预览历史向 /history/preview 发送 JSON 并透传结果", async () => {
    const response: HistoryPreviewResponse = {
      tasks: [{
        id: "task-1",
        role: "build",
        name: "lint",
        cwd,
        command: "bun run lint",
        muxKind: "tmux",
        muxSession: "oc-project",
        paneId: "%1",
        status: "gone",
        restartCount: 0,
        createdAt: "2026-11-10T00:00:00Z",
        updatedAt: "2026-11-10T00:00:00Z",
      }],
    }
    const { client, serviceRequest } = mockClient(200, JSON.stringify(response))

    await expect(client.previewHistory({ cwd, includeShell: true })).resolves.toEqual(response)
    expect(serviceRequest).toHaveBeenCalledExactlyOnceWith({
      method: "POST",
      path: "/history/preview",
      query: undefined,
      body: JSON.stringify({ cwd, includeShell: true }),
    })
  })

  it("兼容旧服务 404 与空响应错误提示", async () => {
    const { client: missingPreview } = mockClient(404, JSON.stringify({ error: "Not found" }))
    await expect(missingPreview.previewHistory({ cwd })).rejects.toMatchObject({
      status: 404,
      message: "当前本地服务不支持清理历史，请重启服务后重试",
    })

    const { client: emptyClean } = mockClient(200, "")
    await expect(emptyClean.cleanHistory({ cwd, candidates: [] })).rejects.toMatchObject({
      status: 200,
      message: "服务返回了空响应",
    })
  })

  it("候选数超出单次请求上限时按字节分批提交并合并结果", async () => {
    const candidates = Array.from({ length: 1200 }, (_, index) => ({
      id: `task-history-item-${String(index).padStart(4, "0")}-${"x".repeat(32)}`,
      updatedAt: "2026-11-01T00:00:00.000Z",
      restartCount: index % 3,
    }))
    const batches = splitHistoryCleanBatches({ cwd, includeShell: false, candidates })
    expect(batches.length).toBeGreaterThan(2)
    const encoder = new TextEncoder()
    for (const batch of batches) {
      expect(encoder.encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(HISTORY_CLEAN_MAX_BODY_BYTES)
    }

    const serviceRequest = vi.fn<HostClient["serviceRequest"]>(async (req) => {
      const parsed = JSON.parse(req.body!) as { candidates: Array<{ id: string }> }
      const ids = parsed.candidates.map((item) => item.id)
      const res: HistoryCleanResponse = {
        removed: ids.slice(0, -2),
        skipped: ids.slice(-2, -1),
        failed: ids.slice(-1).map((id) => ({ id, message: "disk error" })),
      }
      return { status: 200, body: JSON.stringify(res) }
    })
    const client = createMuxClient({ serviceRequest } as unknown as HostClient)

    const result = await client.cleanHistory({ cwd, includeShell: false, candidates })
    expect(serviceRequest).toHaveBeenCalledTimes(batches.length)
    expect(result.removed.length + result.skipped.length + result.failed.length).toBe(candidates.length)
    expect(result.skipped).toHaveLength(batches.length)
    expect(result.failed).toHaveLength(batches.length)
  })

  it("后续批次失败时保留已执行批次的部分结果并保持错误本地化", async () => {
    const candidates = Array.from({ length: 900 }, (_, index) => ({
      id: `task-${index}-${"y".repeat(36)}`,
      updatedAt: "2026-11-01T00:00:00.000Z",
      restartCount: 0,
    }))
    const serviceRequest = vi.fn<HostClient["serviceRequest"]>()
      .mockImplementationOnce(async (req) => {
        const parsed = JSON.parse(req.body!) as { candidates: Array<{ id: string }> }
        return {
          status: 200,
          body: JSON.stringify({
            removed: parsed.candidates.map((item) => item.id),
            skipped: [],
            failed: [],
          } satisfies HistoryCleanResponse),
        }
      })
      .mockResolvedValueOnce({ status: 401, body: JSON.stringify({ error: "Unauthorized" }) })

    const client = createMuxClient({ serviceRequest } as unknown as HostClient)
    let caught: unknown
    try {
      await client.cleanHistory({ cwd, candidates })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HistoryCleanPartialError)
    const partialError = caught as HistoryCleanPartialError
    expect(partialError.partial.removed.length).toBeGreaterThan(0)
    expect(partialError.partial.removed.length).toBeLessThan(candidates.length)
    expect(formatClientError(partialError)).toMatchObject({
      code: 401,
      detail: "本地服务鉴权失败",
    })
  })
})
