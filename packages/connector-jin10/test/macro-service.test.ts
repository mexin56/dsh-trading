import { describe, expect, it, vi } from 'vitest'
import { TRADING_MACRO_FEED_KEY, createJin10MacroFeed } from '../src/macro-service.js'
import { Jin10McpClient } from '../src/mcp.js'
import { Jin10Service } from '../src/service.js'

/** MCP 半 stub：list_calendar 回当周两条（标题带地区前缀）。 */
function stubFetch(): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number; params?: { name?: string } }
    const sse = (payload: unknown) => new Response('event: message\ndata: ' + JSON.stringify(payload) + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    // initialize 能力声明与实测出口一致（spikes/impl-jin10-mcp/EVIDENCE/01-initialize.json）。
    if (body.method === 'initialize') return sse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { logging: {}, resources: {}, tools: {} } } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const data = body.params?.name === 'list_calendar'
      ? [
          { pub_time: '2026-09-14 20:30', star: 3, title: '美国9月核心CPI年率', previous: '3.2', consensus: '3.1', actual: null, affect_txt: null },
          { pub_time: '2026-09-15 07:50', star: 2, title: '日本8月机械工具订单同比', previous: '-1.5', actual: '2.0', affect_txt: '利多' },
        ]
      : []
    return sse({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { status: 200, message: '', data } } })
  }) as typeof fetch
}

/** 网页版半 stub：利率接口回一条美、一条日。 */
function ratesFetch(capture: (url: URL) => void): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input : new URL(String(input))
    capture(url)
    return new Response(JSON.stringify({
      status: 200,
      data: { list: [{ id: 1, bankName: '美国联邦储备局', flagImgUrl: '//cdn.jin10.com/flag/美国.png', interestRate: '3.75', publishTime: '2025-12-11' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
}

function makeFeed(captureRates: (url: URL) => void = () => {}) {
  return createJin10MacroFeed(new Jin10Service(
    new Jin10McpClient({ token: () => 'sk-test', fetchImpl: stubFetch() }),
    { fetchImpl: ratesFetch(captureRates) },
  ))
}

describe('createJin10MacroFeed（GUI 宏观/利率桥面）', () => {
  it('服务键固定 tradingMacroFeed（桥按该键解析）', () => {
    expect(TRADING_MACRO_FEED_KEY).toBe('tradingMacroFeed')
  })

  it('listCalendar：当周条目带地区推断（标题前缀），actual 缺省 = 未公布', async () => {
    const entries = await makeFeed().listCalendar()
    expect(entries).toEqual([
      { publishedAt: '2026-09-14T12:30:00.000Z', star: 3, title: '美国9月核心CPI年率', region: '美国', previous: '3.2', consensus: '3.1' },
      { publishedAt: '2026-09-14T23:50:00.000Z', star: 2, title: '日本8月机械工具订单同比', region: '日本', previous: '-1.5', actual: '2.0', affect: '利多' },
    ])
  })

  it('listRates：走网页版利率接口（非 MCP），条目只留元数据', async () => {
    const seen = vi.fn<(url: URL) => void>()
    const rates = await makeFeed(seen).listRates()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(rates).toEqual([{ region: '美国', bankName: '美国联邦储备局', rate: '3.75', publishedAt: '2025-12-11' }])
  })
})
