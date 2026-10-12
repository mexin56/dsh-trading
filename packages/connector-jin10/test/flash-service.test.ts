import { describe, expect, it, vi } from 'vitest'
import { TRADING_FLASH_FEED_KEY, createJin10FlashFeed } from '../src/flash-service.js'
import { Jin10McpClient } from '../src/mcp.js'
import { Jin10Service } from '../src/service.js'

function stubFetch(): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number; params?: { name?: string } }
    const sse = (payload: unknown) => new Response('event: message\ndata: ' + JSON.stringify(payload) + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    // initialize 能力声明与实测出口一致（spikes/impl-jin10-mcp/EVIDENCE/01-initialize.json）。
    if (body.method === 'initialize') return sse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { logging: {}, resources: {}, tools: {} } } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const name = String(body.params?.name ?? '')
    const data = name === 'list_flash'
      ? { has_more: true, items: [{ content: '【快讯标题】正文不下发', time: '2026-09-13T09:00:00+08:00', url: 'https://flash.jin10.com/detail/1' }], next_cursor: 'c1' }
      : { items: [{ content: '【命中标题】正文不下发', time: '2026-09-13T09:00:00+08:00', url: 'https://flash.jin10.com/detail/2' }] }
    return sse({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { status: 200, message: '', data } } })
  }) as typeof fetch
}

function makeFeed() {
  return createJin10FlashFeed(new Jin10Service(new Jin10McpClient({ token: () => 'sk-test', fetchImpl: stubFetch() })))
}

/** hot 路径注入的网页版 fetch：断言走热度接口而非 MCP。 */
function makeHotFeed(capture: (url: URL) => void) {
  const webFetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input : new URL(String(input))
    capture(url)
    return new Response(JSON.stringify({
      status: 200,
      data: [{ id: 'hot-1', time: '2026-09-13 10:00:00', hot: '爆', data: { title: '热度标题', content: '正文不下发' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return createJin10FlashFeed(new Jin10Service(
    new Jin10McpClient({ token: () => 'sk-test', fetchImpl: stubFetch() }),
    { fetchImpl: webFetch },
  ))
}

describe('createJin10FlashFeed（GUI 桥与工具面共用取数）', () => {
  it('服务键固定 tradingFlashFeed（桥按该键解析）', () => {
    expect(TRADING_FLASH_FEED_KEY).toBe('tradingFlashFeed')
  })

  it('listFlash：透传 cursor/hasMore，条目只留标题/时间/链接（正文不下发）', async () => {
    const page = await makeFeed().listFlash({ limit: 5 })
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('c1')
    expect(page.items).toEqual([{
      source: 'jin10',
      title: '快讯标题',
      url: 'https://flash.jin10.com/detail/1',
      publishedAt: '2026-09-13T01:00:00.000Z',
    }])
    expect(JSON.stringify(page)).not.toContain('正文不下发')
  })

  it('searchFlash：关键词搜索（上游一次性返回，无翻页语义）', async () => {
    const items = await makeFeed().searchFlash('黄金', 3)
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('命中标题')
  })

  it('listFlash：hot 非空 → 走网页版热度接口（服务端过滤），条目带 hot 标签', async () => {
    const seen = vi.fn<(url: URL) => void>()
    const page = await makeHotFeed(seen).listFlash({ limit: 5, hot: ['爆'] })
    expect(page.items).toEqual([{
      source: 'jin10',
      title: '热度标题',
      url: 'https://flash.jin10.com/detail/hot-1',
      publishedAt: '2026-09-13T02:00:00.000Z',
      hot: '爆',
    }])
    expect(JSON.stringify(page)).not.toContain('正文不下发')
    expect(seen).toHaveBeenCalledTimes(1)
    const params = JSON.parse(seen.mock.calls[0]![0].searchParams.get('params') ?? '{}') as { hot?: unknown }
    expect(params.hot).toEqual(['爆'])
  })

  it('listFlash：hot 全为无效等级 → 回落 MCP 全量流（不误发热度接口）', async () => {
    const seen = vi.fn<(url: URL) => void>()
    const page = await makeHotFeed(seen).listFlash({ limit: 5, hot: ['不存在'] })
    expect(seen).not.toHaveBeenCalled()
    expect(page.items[0]?.title).toBe('快讯标题')
  })
})
