import { describe, expect, it } from 'vitest'
import type { Kline } from '@dshtrading/api'
import {
  GLOBAL_MARKET,
  JIN10_PROVIDER,
  MAX_MINUTE_WINDOW,
  TRADING_GLOBAL_MARKET_DATA_KEY,
  aggregateKlines,
  createJin10GlobalMarketDataService,
  resolveIntervalMinutes,
  tickerFromQuote,
} from '../src/market-data.js'
import type { Jin10Service } from '../src/service.js'

/** 桶对齐基准（5 分钟整除），保证测试里的分钟序列落在同一聚合桶内。 */
const MINUTE_BASE = 1_700_000_000_000 - (1_700_000_000_000 % (5 * 60_000))

function minuteBar(minute: number, open: number, high: number, low: number, close: number, volume = 1): Kline {
  const openTime = MINUTE_BASE + minute * 60_000
  return { openTime, closeTime: openTime + 59_999, open, high, low, close, volume }
}

describe('global 市场数据面常亮词表', () => {
  it('市场/provider/服务键常量与 router 词汇一致', () => {
    expect(GLOBAL_MARKET).toBe('global')
    expect(JIN10_PROVIDER).toBe('jin10')
    expect(TRADING_GLOBAL_MARKET_DATA_KEY).toBe('tradingGlobalMarketData')
  })

  it('周期表只含分钟级子集（上游无日线，不假装支持 1d）', () => {
    expect(resolveIntervalMinutes('1m')).toBe(1)
    expect(resolveIntervalMinutes('3m')).toBe(3)
    expect(resolveIntervalMinutes('1h')).toBe(60)
    expect(resolveIntervalMinutes('1d')).toBeUndefined()
    expect(resolveIntervalMinutes('1w')).toBeUndefined()
  })
})

describe('aggregateKlines（分钟桶聚合）', () => {
  it('5 根 1m → 1 根 5m：首开/最高/最低/末收/量和，桶起点对齐', () => {
    const bars = [
      minuteBar(0, 10, 12, 9, 11, 1),
      minuteBar(1, 11, 13, 10, 12, 2),
      minuteBar(2, 12, 14, 11, 13, 3),
      minuteBar(3, 13, 15, 12, 14, 4),
      minuteBar(4, 14, 16, 13, 15, 5),
    ]
    const out = aggregateKlines(bars, 5)
    expect(out).toHaveLength(1)
    const bar = out[0] as Kline
    expect(bar.open).toBe(10)
    expect(bar.high).toBe(16)
    expect(bar.low).toBe(9)
    expect(bar.close).toBe(15)
    expect(bar.volume).toBe(15)
    expect(bar.openTime % (5 * 60_000)).toBe(0)
    expect(bar.closeTime).toBe(bar.openTime + 5 * 60_000 - 1)
  })

  it('1m 不聚合（原样深拷贝）；跨桶切分正确', () => {
    const bars = [minuteBar(0, 1, 1, 1, 1), minuteBar(1, 2, 2, 2, 2), minuteBar(5, 3, 3, 3, 3)]
    expect(aggregateKlines(bars, 1)).toEqual(bars)
    const five = aggregateKlines(bars, 5)
    expect(five).toHaveLength(2)
    expect(five[1]?.open).toBe(3)
  })
})

describe('tickerFromQuote（报价 → Ticker）', () => {
  it('最新价 + 昨收反推 + ISO 时间转 epoch ms', () => {
    const ticker = tickerFromQuote({
      code: 'xauusd',
      name: '现货黄金',
      close: 2400.5,
      change: 12.5,
      changePercent: 0.52,
      volume: 1000,
      time: '2026-09-12T01:00:00.000Z',
    })
    expect(ticker).toEqual({
      symbol: 'XAUUSD',
      name: '现货黄金',
      price: 2400.5,
      prevClose: 2388,
      changePercent: 0.52,
      volume: 1000,
      timestamp: Date.parse('2026-09-12T01:00:00.000Z'),
    })
  })

  it('缺最新价 = 上游形状异常（不编价格）；缺时间回退当前时刻', () => {
    expect(() => tickerFromQuote({ code: 'XAUUSD' })).toThrow(/has no latest price/)
    const ticker = tickerFromQuote({ code: 'XAUUSD', close: 1 })
    expect(Number.isFinite(ticker.timestamp)).toBe(true)
  })
})

/** 只实现数据面用到的三个方法的假 feed（结构化替身）。 */
function fakeFeed(overrides: Partial<Record<'getQuote' | 'getKlines' | 'listInstruments', unknown>> = {}): Jin10Service {
  return overrides as unknown as Jin10Service
}

describe('createJin10GlobalMarketDataService', () => {
  it('getKlines：按窗口向上游要 1m 数据并本地聚合；limit 按窗口深度收敛', async () => {
    const calls: Array<{ time?: number; count?: number }> = []
    const feed = fakeFeed({
      // 上游语义：从 time 起往后给 count 根分钟 K（假件按请求窗口生成）。
      getKlines: async (_code: string, options: { time?: number; count?: number }) => {
        calls.push(options)
        const from = options.time ?? 0
        return Array.from({ length: options.count ?? 100 }, (_, index) => ({
          time: from + index * 60,
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 1,
        }))
      },
    })
    const service = createJin10GlobalMarketDataService(feed)
    const klines = await service.getKlines('XAUUSD', '5m', 60)
    // 60 根 5m = 300 分钟 = 3 次上游调用（单次上限 100 根）
    expect(calls).toHaveLength(3)
    expect(calls[0]?.count).toBe(100)
    expect(klines).toHaveLength(60)
    expect(MAX_MINUTE_WINDOW).toBe(300)
    expect(klines[0]?.openTime % (5 * 60_000)).toBe(0)
  })

  it('getKlines：不支持的周期显式报错（不换源/不冒充）', async () => {
    const service = createJin10GlobalMarketDataService(fakeFeed({ getKlines: async () => [] }))
    await expect(service.getKlines('XAUUSD', '1d', 30)).rejects.toThrow(/unsupported interval/)
  })

  it('getKlines：休市窗口回空序列（合法结果，不是错误）', async () => {
    const service = createJin10GlobalMarketDataService(fakeFeed({ getKlines: async () => [] }))
    await expect(service.getKlines('XAUUSD', '1m', 30)).resolves.toEqual([])
  })

  it('listInstruments：金十代码 → 大写规范形 + 中文名', async () => {
    const service = createJin10GlobalMarketDataService(fakeFeed({
      listInstruments: async () => [{ code: 'XAUUSD', name: '现货黄金' }, { code: 'USOIL', name: 'WTI原油' }],
    }))
    await expect(service.listInstruments?.()).resolves.toEqual([
      { symbol: 'XAUUSD', name: '现货黄金' },
      { symbol: 'USOIL', name: 'WTI原油' },
    ])
  })

  it('管理员接线金十数据面时，常驻 ticker 订阅被显式拒绝且不消耗配额', () => {
    // Given 一个记录上游调用的假 feed
    const quotes: string[] = []
    const service = createJin10GlobalMarketDataService(fakeFeed({
      getQuote: async (code: string) => {
        quotes.push(code)
        return { code, close: 100, time: '2026-09-12T01:00:00.000Z' }
      },
    }))
    // When 订阅常驻 ticker
    // Then 立刻抛错（不是静默轮询），且上游配额一拍都没被消耗
    expect(() => service.subscribeTicker('xauusd', () => {})).toThrow(/不提供常驻 ticker 订阅/)
    expect(quotes).toEqual([])
  })

  it('管理员读拒绝原因时，错误码是 TRADING_NOT_IMPLEMENTED（可选能力缺席语义）', () => {
    // Given 任意 feed 构造的 global 数据面
    const service = createJin10GlobalMarketDataService(fakeFeed({}))
    // When 订阅并捕获抛出的错误
    let thrown: unknown
    try {
      service.subscribeTicker('XAUUSD', () => {})
    } catch (error) {
      thrown = error
    }
    // Then 错误码落在「可选方法缺席」词汇上
    expect((thrown as { code?: string }).code).toBe('TRADING_NOT_IMPLEMENTED')
  })
})
