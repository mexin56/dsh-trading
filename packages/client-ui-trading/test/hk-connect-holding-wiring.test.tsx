/**
 * 港股通持股比例的客户端接线（契约 §5，决策 5）：真实本地 HTTP 上游 + 真实 fetch
 * 路由，把 QuoteStage 挂进 jsdom，钉住「按市场/标的向宿主取序列」与「词条带与选择器
 * 两条 markets 过滤点」。
 *
 * K 线端点在两例里都刻意失败（klines 停在 null），因此 TvChart 不挂载：副图门控
 * （无数据整体隐藏）由 indicator-dispatch 的纯逻辑用例覆盖——jsdom 无 canvas，
 * 真实图表挂不起来，而本仓禁用通用 mock 工具（不 mock TvChart）。
 *
 * @vitest-environment jsdom
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { presetDefinitions } from '@dshtrading/indicators'
import { indicators } from '../src/client/indicator-registry.ts'
import { QuoteStage } from '../src/client/QuoteStage.tsx'
import type { SelectionState } from '../src/client/store.ts'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const HOLDING_TITLE = '港股通持股比例'

let server: Server
let baseUrl = ''
/** 收到的请求路径清单（断言客户端确实按需请求了宿主序列）。 */
let requests: string[] = []
/** 真实 fetch 引用（在替换 globalThis.fetch 之前抓住，否则替换品会调用自己）。 */
const realFetch = globalThis.fetch

beforeEach(async () => {
  requests = []
  // 真实名册：客户端注册表在插件缺席时为空，本用例按插件的注册路径装载预置定义。
  for (const definition of presetDefinitions()) indicators.register(definition)
  server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.setHeader('content-type', 'application/json')
    if (req.url?.includes('/southbound-holdings')) {
      res.statusCode = 200
      res.end(JSON.stringify({
        ok: true,
        southboundHoldings: {
          symbol: '00700.HK',
          points: [{ date: Date.UTC(2026, 9, 5), holdRatio: 11.9, holdShares: 1_234_567, holdMarketCap: 555_000_000 }],
        },
      }))
      return
    }
    // K 线端点本轮失败：图表不挂载，本用例只验接线与过滤点。
    res.statusCode = 500
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  const upstream = realFetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input).replace('/dshtrading/api', '') || '/'
    return upstream(baseUrl + (target.startsWith('/') ? target : `/${target}`), init)
  }) as typeof globalThis.fetch
})

afterEach(async () => {
  cleanup()
  globalThis.fetch = realFetch
  // 关掉 keep-alive 连接：否则 server.close() 要等 undici 的空闲 socket 超时（数秒）。
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

/** QuoteStage 的最小装配：真实 selection/chart 快照 + 记录适用范围写入。 */
function quoteStageProps(market: 'hk' | 'us', symbol: string, instances: ChartState['instances']) {
  const selection: SelectionState = { instrument: { market, symbol } }
  const chart: ChartState = { instances }
  const scopeWrites: Array<{ id: string; market: string; scope: unknown }> = []
  return {
    props: {
      t,
      useSelection: <T,>(sel: (state: SelectionState) => T): T => sel(selection),
      useChart: <T,>(sel: (state: ChartState) => T): T => sel(chart),
      toggleIndicator: () => {},
      setIndicatorParams: () => {},
      setIndicatorVisible: () => {},
      setIndicatorScope: (id: string, target: string, scope: unknown) => { scopeWrites.push({ id, market: target, scope }) },
      removeIndicator: () => {},
      deleteIndicator: async () => true,
    },
    scopeWrites,
  }
}

describe('QuoteStage 港股通持股比例接线', () => {
  it('用户在港股挂载港股通持股比例时，客户端按 market/symbol 请求宿主序列', async () => {
    // Given 港股标的 + 已挂载的港股通持股比例
    const { props } = quoteStageProps('hk', '00700.HK', [{ id: 'hk-connect-holding', params: {} }])

    // When 挂载行情面板
    render(<QuoteStage {...props} />)

    // Then 宿主桥收到带该市场与标的的取数请求
    await waitFor(() => expect(requests.some(url => url.includes('/southbound-holdings'))).toBe(true))
    expect(requests.find(url => url.includes('/southbound-holdings'))).toContain('market=hk')
    expect(requests.find(url => url.includes('/southbound-holdings'))).toContain('symbol=00700.HK')
  })

  it('用户挂载未声明外部序列的指标时，客户端不发港股通取数请求', async () => {
    // Given 港股标的 + 只挂了 MA（无 aux 声明）
    const { props } = quoteStageProps('hk', '00700.HK', [{ id: 'ma', params: {} }])

    // When 挂载行情面板
    render(<QuoteStage {...props} />)

    // Then 不产生多余的上游配额消耗
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    expect(requests.some(url => url.includes('/southbound-holdings'))).toBe(false)
  })

  it('用户在港股时，底部词条带出现港股通持股比例', () => {
    // Given 港股标的
    const { props } = quoteStageProps('hk', '00700.HK', [])

    // When 挂载行情面板
    const { getByText } = render(<QuoteStage {...props} />)

    // Then 词条带里有该指标（可点开）
    expect(getByText(HOLDING_TITLE)).toBeTruthy()
  })

  it('用户切到美股时，底部词条带与指标选择器都不出现港股通持股比例', () => {
    // Given 美股标的
    const { props } = quoteStageProps('us', 'AAPL', [])

    // When 挂载行情面板并打开指标选择器
    const { queryByText, getByText } = render(<QuoteStage {...props} />)
    expect(queryByText(HOLDING_TITLE)).toBeNull()
    fireEvent.click(getByText('indicator.picker'))

    // Then 选择器对话框里也没有该指标（面板已渲染出来）
    expect(getByText('indicator.group.sub')).toBeTruthy()
    expect(queryByText(HOLDING_TITLE)).toBeNull()
  })

  it('用户首次挂载港股通持股比例时，客户端写入仅日线及以上的默认适用范围', () => {
    // Given 港股标的 + 尚未挂载任何实例
    const { props, scopeWrites } = quoteStageProps('hk', '00700.HK', [])

    // When 点击词条带挂载该指标
    const { getByText } = render(<QuoteStage {...props} />)
    fireEvent.click(getByText(HOLDING_TITLE))

    // Then 挂载时补写了 hk 的默认级别（1d/1w/1M，分钟级不适用）
    expect(scopeWrites).toEqual([
      { id: 'hk-connect-holding', market: 'hk', scope: { enabled: true, intervals: ['1d', '1w', '1M'] } },
    ])
  })
})
