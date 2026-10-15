/**
 * 上游错误到交易错误码的映射（请求侧 + 行级两份信号）。
 *
 * 判据（均来自实测原始响应）：
 *   ① fetch 抛错 → `TRADING_NETWORK`；
 *   ② HTTP 404 → `TRADING_SYMBOL_NOT_FOUND`（coinbase 不存在的 product）；
 *   ③ HTTP 400 且 JSON 正文 `label` 以 `INVALID_` 开头 → `TRADING_SYMBOL_NOT_FOUND`
 *      （gateio 的 `INVALID_CURRENCY_PAIR` / `INVALID_CURRENCY`）；
 *   ④ 其余非 2xx → `TRADING_UPSTREAM_ERROR`，message 里带**单行截断**的正文片段；
 *   ⑤ 非 JSON 正文不得让映射崩掉（实测 bybit 403 正文是 CloudFront 的地域拦截片段）。
 *
 * fetch 走契约化注入缝（本仓零 mock 纪律）。
 */
import { describe, expect, it } from 'vitest'
import { CcxtRestClient } from '../src/rest.ts'

/** 原始正文（不 JSON.stringify）：非 JSON 正文是必须支持的输入。 */
function rawResponse(body: string, status: number, statusText: string): Response {
  return new Response(body, { status, statusText, headers: { 'content-type': 'application/json' } })
}

interface Route {
  match: string
  status: number
  statusText: string
  body: string
}

function routeFetch(routes: Route[]): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return rawResponse(route.body, route.status, route.statusText)
  }) as typeof fetch
  return { impl, urls }
}

/** 连不上/超时的注入缝：fetch 本身抛错。 */
function failingFetch(message: string): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    throw new TypeError(message)
  }) as typeof fetch
  return { impl, urls }
}

describe('CCXT 上游 HTTP 错误映射', () => {
  it('用户请求 gateio 上不存在的 pair 时上游 400 的 INVALID_ 标签被判为符号不存在', async () => {
    // Given gateio 实测的两条 400 响应（INVALID_CURRENCY_PAIR / INVALID_CURRENCY）
    const pairRoute = routeFetch([{
      match: '/api/v4/spot/tickers',
      status: 400,
      statusText: 'Bad Request',
      body: '{"label":"INVALID_CURRENCY_PAIR","message":"invalid currency pair"}',
    }])
    const currencyRoute = routeFetch([{
      match: '/api/v4/spot/tickers',
      status: 400,
      statusText: 'Bad Request',
      body: '{"label":"INVALID_CURRENCY","message":"invalid currency"}',
    }])
    // When 用户请求这两个不存在的 pair（base 能切出来、但上游没有该币种）
    const badPair = await new CcxtRestClient({ fetchImpl: pairRoute.impl }).getTicker('ZZZUSDT', 'gateio')
      .catch((e: unknown) => e as Error & { code?: string })
    const badCurrency = await new CcxtRestClient({ fetchImpl: currencyRoute.impl }).getTicker('QQQUSDT', 'gateio')
      .catch((e: unknown) => e as Error & { code?: string })
    // Then 两者都报 TRADING_SYMBOL_NOT_FOUND（上游明确说符号不存在，不是上游故障）
    expect(badPair).toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
    expect(badCurrency).toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
    expect(String(badPair?.message)).toContain('INVALID_CURRENCY_PAIR')
  })

  it('用户请求 gateio 时上游 400 但标签不是 INVALID_ 就仍算上游故障', async () => {
    // Given 一条 400 但 label 不是 INVALID_ 前缀的响应
    const route = routeFetch([{
      match: '/api/v4/spot/tickers',
      status: 400,
      statusText: 'Bad Request',
      body: '{"label":"REQUEST_DENIED","message":"too many parameters"}',
    }])
    // When 用户请求该 pair 的 ticker
    const err = await new CcxtRestClient({ fetchImpl: route.impl }).getTicker('BTCUSDT', 'gateio')
      .catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_UPSTREAM_ERROR（400 本身不是符号不存在的判据）且正文片段进 message
    expect(err).toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    expect(String(err?.message)).toContain('CCXT HTTP 400 Bad Request')
    expect(String(err?.message)).toContain('REQUEST_DENIED')
  })

  it('用户请求 coinbase 上不存在的 product 时上游 404 被判为符号不存在', async () => {
    // Given coinbase 实测的 404 形态
    const route = routeFetch([{
      match: '/products/XXX-USD/ticker',
      status: 404,
      statusText: 'Not Found',
      body: '{"message":"NotFound"}',
    }])
    // When 用户请求不存在的 product
    const err = await new CcxtRestClient({ fetchImpl: route.impl }).getTicker('XXXUSD', 'coinbase')
      .catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_SYMBOL_NOT_FOUND，message 带状态行与失败 URL
    expect(err).toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
    expect(String(err?.message)).toContain('CCXT HTTP 404 Not Found')
    expect(String(err?.message)).toContain('XXX-USD')
  })

  it('用户遇到区域拦截的 bybit 403 时得到上游故障且非 JSON 正文被单行截断带进 message', async () => {
    // Given bybit 实测的 403 非 JSON 正文（CloudFront 地域拦截片段）
    const intercepted = '{ error: The Amazon CloudFront distribution is configured to block access from your country }'
    const route = routeFetch([{ match: '/v5/market/tickers', status: 403, statusText: 'Forbidden', body: intercepted }])
    // When 用户请求 bybit 的 ticker
    const err = await new CcxtRestClient({ fetchImpl: route.impl }).getTicker('BTCUSDT', 'bybit')
      .catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_UPSTREAM_ERROR（不是 NETWORK、也不是 SYMBOL_NOT_FOUND），正文片段原样可见
    expect(err).toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    expect(String(err?.message)).toContain('CCXT HTTP 403 Forbidden')
    expect(String(err?.message)).toContain('Amazon CloudFront')
    expect(String(err?.message)).not.toContain('\n')
  })

  it('用户遇到超长多行正文的上游错误时 message 片段被压成单行并截断', async () => {
    // Given 一条 500 且正文是多行长文本的响应
    const longBody = `${'x'.repeat(600)}\n${'y'.repeat(600)}`
    const route = routeFetch([{ match: '/api/v1/market/stats', status: 500, statusText: 'Internal Server Error', body: longBody }])
    // When 用户请求 kucoin 的 ticker
    const err = await new CcxtRestClient({ fetchImpl: route.impl }).getTicker('BTCUSDT', 'kucoin')
      .catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_UPSTREAM_ERROR，片段单行且不超过约 200 字符
    expect(err).toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    const message = String(err?.message)
    expect(message).not.toContain('\n')
    expect(message).toContain('CCXT HTTP 500 Internal Server Error')
    expect(message.length).toBeLessThan(300)
    expect(message.slice(message.indexOf(': ') + 2).length).toBe(200)
  })

  it('用户遇到连不上上游的传输失败时得到网络错误而不是上游故障', async () => {
    // Given fetch 本身抛 TypeError 的注入缝
    const { impl, urls } = failingFetch('fetch failed')
    // When 用户请求 binance 的 ticker
    const err = await new CcxtRestClient({ fetchImpl: impl }).getTicker('BTCUSDT', 'binance')
      .catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_NETWORK（与「到达了上游、上游明确报错」区分）且确实发过一次请求
    expect(err).toMatchObject({ code: 'TRADING_NETWORK' })
    expect(String(err?.message)).toContain('fetch failed')
    expect(urls).toHaveLength(1)
  })
})
