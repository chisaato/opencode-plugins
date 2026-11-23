import type { HostClient } from "@openchamber/sdk"
import { describe, expect, it, vi } from "vitest"
import type { SessionCloseResponse } from "../src/types"
import { createMuxClient, formatClientError, ServiceApiError } from "../src/ui/client"

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
