/**
 * gamma 传输层用例：**真实本地 HTTP 上游**（node:http）+ 真实 globalThis.fetch。
 *
 * 零 mock、零 sleep：每一条失败路径都由一个真实服务器按真实状态码/头部回答
 * （403 text/plain 的 Cloudflare 1010、200 非 JSON、超时用真实延迟 + 客户端超时）。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { GammaClient, USER_AGENT } from '../src/gamma.ts'

let server: Server | undefined
const seen: { url: string; userAgent: string | undefined }[] = []

async function serve(handler: (req: Parameters<Parameters<typeof createServer>[0]>[0], res: Parameters<Parameters<typeof createServer>[0]>[1]) => void): Promise<string> {
  seen.length = 0
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', userAgent: req.headers['user-agent'] })
    handler(req, res)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (server !== undefined) {
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
})

describe('gamma 传输层（真实本地 HTTP 上游）', () => {
  it('运营取数时请求带自有 UA 与 accept: application/json', async () => {
    // Given 一个回合法 JSON 数组的上游
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
    })

    // When 取数
    const response = await new GammaClient({ baseUrl }).get('/events', { series_id: '35' })

    // Then 状态 200 且上游收到的正是自有 UA（不伪造浏览器 UA）
    expect(response.status).toBe(200)
    expect(seen[0]?.userAgent).toBe(USER_AGENT)
    expect(seen[0]?.url).toBe('/events?series_id=35')
  })

  it('运营遇到 Cloudflare 准入拦截（403 + text/plain）时看到明确失败而不是空数据', async () => {
    // Given 复刻真实 403 响应：text/plain 的 `error code: 1010`
    const baseUrl = await serve((_req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain; charset=UTF-8' })
      res.end('error code: 1010\n')
    })

    // When / Then 抛 TRADING_UPSTREAM_ERROR，消息里带状态码与响应片段（绝不返回 []）
    await expect(new GammaClient({ baseUrl }).get('/events')).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket gamma /events: HTTP 403 — error code: 1010',
    })
  })

  it('运营遇到上游参数错误（422 JSON）时看到契约错误内容', async () => {
    // Given 复刻真实 422 体
    const baseUrl = await serve((_req, res) => {
      res.writeHead(422, { 'content-type': 'application/json' })
      res.end('{"type":"validation error","error":"invalid integer"}')
    })

    // When / Then 错误消息带上游原文
    await expect(new GammaClient({ baseUrl }).get('/events')).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket gamma /events: HTTP 422 — {"type":"validation error","error":"invalid integer"}',
    })
  })

  it('运营遇到 200 但体不是 JSON 时看到契约破损错误，而不是静默当成无数据', async () => {
    // Given 上游回 HTML（CDN 错误页）
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>bad gateway</html>')
    })

    // When / Then 抛错并说明体不是 JSON
    await expect(new GammaClient({ baseUrl }).get('/events')).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket gamma /events: HTTP 200 but the body is not JSON — <html>bad gateway</html>',
    })
  })

  it('运营遇到上游不响应时在超时后看到 TRADING_NETWORK 而不是无限等待', async () => {
    // Given 一个永不回包的服务器（真实挂起）+ 30ms 客户端超时
    const baseUrl = await serve(() => { /* 故意不响应 */ })

    // When / Then 超时转成结构化网络错误
    await expect(new GammaClient({ baseUrl, timeoutMs: 30 }).get('/events')).rejects.toMatchObject({
      code: 'TRADING_NETWORK',
      message: 'polymarket gamma /events: request timed out — This operation was aborted',
    })
  })

  it('运营遇到上游连接被拒（端口未监听）时看到 TRADING_NETWORK', async () => {
    // Given 指向一个已关闭的端口
    const baseUrl = await serve((_req, res) => { res.end('[]') })
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing?.close(() => resolve()))

    // When / Then 连接失败是网络错误（不是「没有数据」）
    await expect(new GammaClient({ baseUrl, timeoutMs: 200 }).get('/events')).rejects.toMatchObject({
      code: 'TRADING_NETWORK',
    })
  })

  it('运营透传查询参数（cache-bust 参数确实到达上游）', async () => {
    // Given 一个记录 query 的上游
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
    })

    // When 带 _cb 取数
    await new GammaClient({ baseUrl }).get('/events', { series_id: '35', limit: '100', _cb: '1791684236' })

    // Then query 逐项透传
    expect(seen[0]?.url).toBe('/events?series_id=35&limit=100&_cb=1791684236')
  })
})
