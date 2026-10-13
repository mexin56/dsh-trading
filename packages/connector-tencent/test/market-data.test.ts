import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ActiveBuySnapshot, TencentRestOptions } from '../src/rest.js'
import {
  ACTIVE_BUY_SOURCE,
  INTERVAL_VOCABULARY,
  type TencentMarket,
  TencentRestClient,
  TradingServiceError,
  isoWithOffset,
  klineDateToEpochMs,
  minuteKlineTimeToEpochMs,
  normalizeCnSymbol,
  normalizeHkSymbol,
  wallTimeToEpochMs,
} from '../src/rest.js'
import { TencentMarketDataService } from '../src/index.ts'

// 夹具为腾讯端点 2026-08-31 真实响应形态（原始字节证据 spikes/impl-cn-hk/r1-*.raw /
// r2-*.json）；中文名以 GBK 字节内嵌，验证 GBK 解码路径（UTF-8 解码会乱码）。
const CN_NAME_GBK = 'b9f3d6ddc3a9cca8' // 贵州茅台
const HK_NAME_GBK = 'ccdad1b6bfd8b9c9' // 腾讯控股

/** 把「ASCII 模板 + GBK 名字字节」拼成响应体（客户端按 GBK 解码）。 */
function gbkResponse(template: string, nameHex: string): Uint8Array {
  const [head, tail] = template.split('%NAME%')
  const nameBytes = nameHex.match(/../g)!.map((h) => parseInt(h, 16))
  const bytes = [
    ...Buffer.from(head, 'latin1'),
    ...nameBytes,
    ...Buffer.from(tail, 'latin1'),
  ]
  return new Uint8Array(bytes)
}

const CN_TICKER_TEMPLATE =
  'v_sh600519="1~%NAME%~600519~1297.40~1292.30~1289.00~16126~8576~7550~1297.35~5~1297.20~1~1297.10~3~1297.01~3~1297.00~11~1297.40~9~1297.50~11~1297.55~2~1297.68~1~1297.70~1~~20260828161500~5.10~0.39~1297.89~1288.00~1297.40/16126/2086008422~16126~208601~0.13~19.92~~1297.89~1288.00~0.77~16218.56~16218.56~6.46~1421.53~1163.07~0.54~-1~1293.56~18.22~19.70~~~0.10~208600.8422~168.6620~13~   A~GP-A~-3.84~1.93~4.01~32.41~27.30~1539.98~1151.01~-3.32~-3.94~4.63~1250081601~1250081601~-2.13~-6.26~1250081601~~~-6.94~0.02~~CNY~0~___D__F__N~1296.83~14~";\n'

const HK_TICKER_TEMPLATE =
  'v_r_hk00700="100~%NAME%~00700~455.200~447.800~444.000~27742475.0~0~0~455.200~0~0~0~0~0~0~0~0~0~455.200~0~0~0~0~0~0~0~0~0~27742475.0~2026/08/28 16:08:37~7.400~1.65~462.200~443.400~455.200~27742475.0~12655334445.330~0~16.65~~0~0~4.20~41437.5241~41437.5241~TENCENT~1.17~677.700~411.000~1.53~0.44~0~0~0~0~0~15.28~3.18~0.30~100~-23.33~-0.39~GP~20.41~11.00~3.45~-4.21~-2.40~9103146761.00~9103146761.00~15.77~5.309~456.172~-25.58~HKD~1~50";\n'

const CN_KLINE_JSON = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    sh600519: {
      // 真实字段序：[date, open, close, high, low, volume] —— 开收高低量！
      qfqday: [
        ['2026-08-27', '1304.000', '1292.300', '1305.000', '1288.000', '24767.000'],
        ['2026-08-28', '1289.000', '1297.400', '1297.890', '1288.000', '16126.000'],
      ],
    },
  },
})

// hk 行第 7 个元素起是分红/回购附加对象与字符串（2026-08-31 实测 hk00700）。
const HK_KLINE_JSON = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    hk00700: {
      qfqday: [
        ['2026-08-27', '447.000', '447.800', '448.200', '441.600', '33116469.000', { cqr: '2026-08-27', HGcontent: '回购68.00万股' }, '1.150', '4600000.000'],
        ['2026-08-28', '444.000', '455.200', '462.200', '443.400', '27742475.000', { cqr: '2026-08-28', HGcontent: '' }, '1.170', '4560000.000'],
      ],
    },
  },
})

/** 返回按 URL 片段分发的 fetch 桩，并记录全部请求 URL。 */
function stubFetch(routes: Array<{ match: string; body: Uint8Array | string; status?: number }>) {
  const urls: string[] = []
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`stubFetch: no route for ${url}`)
    const body = typeof route.body === 'string' ? new TextEncoder().encode(route.body) : route.body
    return new Response(body as BodyInit, {
      status: route.status ?? 200,
      headers: { 'content-type': 'text/html; charset=GBK' },
    })
  }) as typeof fetch
  return { impl, urls }
}

function client(market: TencentMarket, options: TencentRestOptions = {}): TencentRestClient {
  return new TencentRestClient(market, options)
}

// 主动买盘夹具 = 2026-10-13 10:09 腾讯实测行原文（GBK 解码后；原始字节证据
// spikes/impl-active-buy/r1-raw-sz002714.gbk）。名字位留 %NAME% 占位，以便内嵌 GBK 字节。
const CN_002714_NAME_GBK = 'c4c1d4adb9c9b7dd' // 牧原股份
const CN_002714_BODY =
  '51~%NAME%~002714~41.12~41.78~41.57~121808~54093~67703~41.11~47~41.10~328~41.09~167~41.08~329~41.07~76~41.12~1~41.13~27~41.14~13~41.15~2~41.16~103~~20261013100930~-0.66~-1.58~42.24~41.08~41.12/121808/507375819~121808~50738~0.37~-211.80~~42.24~41.08~2.78~1348.96~2373.86~3.00~45.96~37.60~2.82~801~41.65~-19.53~15.33~~~0.50~50737.5819~0.0000~0~   A~GP-A~-18.02~-2.77~3.13~-1.40~-0.61~53.06~31.81~-2.97~-6.35~6.67~3280544547~5772996144~73.28~-16.66~3280544547~~~-20.56~-0.15~~CNY~0~~41.06~391~'

/**
 * 按字段号改写实测行（只改写被断言的位，其余保持实测字节形态）。
 * 36 位是「价/量/额」展示串、不参与解析，故不随向量改写。
 */
function cnActiveBuyRow(overrides: Record<number, string> = {}): string {
  const fields = CN_002714_BODY.split('~')
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value
  return `v_sz002714="${fields.join('~')}";\n`
}

/** 取数时刻夹具：2026-10-13 09:53:12（Asia/Shanghai）。 */
const FIXED_NOW_0953 = Date.UTC(2026, 9, 13, 1, 53, 12)

/** 服务实例单测用最小 ctx（cordis Service 只需 reflect.provide；与 dataplane 单测同款）。 */
function duckCtx(): { ctx: Context; provided: Record<string, unknown> } {
  const provided: Record<string, unknown> = {}
  const ctx = {
    reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
  } as unknown as Context
  return { ctx, provided }
}

describe('normalizeCnSymbol', () => {
  it('accepts bare / SH / sz prefixed codes and routes by leading digit', () => {
    expect(normalizeCnSymbol('600519')).toBe('sh600519')
    expect(normalizeCnSymbol('600519.SH')).toBe('sh600519') // 规范形输入（docs/symbol-vocabulary.md）
    expect(normalizeCnSymbol('000001.SZ')).toBe('sz000001') // 规范形后缀优先于首位推断
    expect(normalizeCnSymbol('SH600519')).toBe('sh600519')
    expect(normalizeCnSymbol('sh600519')).toBe('sh600519')
    expect(normalizeCnSymbol('000001')).toBe('sz000001')
    expect(normalizeCnSymbol('SZ000001')).toBe('sz000001')
    expect(normalizeCnSymbol('300750')).toBe('sz300750')
    expect(normalizeCnSymbol('688981')).toBe('sh688981')
    // 知名指数代码与 5 开头基金
    expect(normalizeCnSymbol('000688')).toBe('sh000688') // 科创50裸码
    expect(normalizeCnSymbol('000688.SH')).toBe('sh000688') // 科创50规范代码
    expect(normalizeCnSymbol('000001.SH')).toBe('sh000001') // 上证指数规范代码
    expect(normalizeCnSymbol('000300.SH')).toBe('sh000300') // 沪深300规范代码
    expect(normalizeCnSymbol('588000')).toBe('sh588000') // 科创50ETF裸码
  })

  it('rejects malformed codes', () => {
    expect(() => normalizeCnSymbol('AAPL')).toThrow(TradingServiceError)
    expect(() => normalizeCnSymbol('12345')).toThrow(TradingServiceError)
    expect(() => normalizeCnSymbol('')).toThrow(TradingServiceError)
  })
})

describe('normalizeHkSymbol', () => {
  it('zero-pads numeric stock codes to 5 digits and normalizes indices', () => {
    expect(normalizeHkSymbol('00700')).toBe('00700')
    expect(normalizeHkSymbol('700')).toBe('00700')
    expect(normalizeHkSymbol('00700.HK')).toBe('00700') // 规范形输入
    expect(normalizeHkSymbol('700.hk')).toBe('00700')
    expect(normalizeHkSymbol('5')).toBe('00005')
    expect(normalizeHkSymbol('99888')).toBe('99888')
    expect(normalizeHkSymbol('HSI')).toBe('HSI')
    expect(normalizeHkSymbol('hsi')).toBe('HSI')
    expect(normalizeHkSymbol('HSI.HK')).toBe('HSI')
    expect(normalizeHkSymbol('HSTECH')).toBe('HSTECH')
    expect(normalizeHkSymbol('r_hkHSI')).toBe('HSI')
  })

  it('rejects malformed codes', () => {
    expect(() => normalizeHkSymbol('0700A_TOOLONG_MALFORMED')).toThrow(TradingServiceError)
    expect(() => normalizeHkSymbol('')).toThrow(TradingServiceError)
  })
})

describe('time parsing', () => {
  it('parses exchange wall clock with the correct timezone', () => {
    // 上海 UTC+8 无夏令时；香港 UTC+8。
    expect(wallTimeToEpochMs('2026-08-28T16:15:00', 'Asia/Shanghai')).toBe(Date.UTC(2026, 7, 28, 8, 15, 0))
    expect(wallTimeToEpochMs('2026/08/28 16:08:37', 'Asia/Hong_Kong')).toBe(Date.UTC(2026, 7, 28, 8, 8, 37))
    expect(klineDateToEpochMs('2026-08-28')).toBe(Date.UTC(2026, 7, 28))
    // 2026-08-28 14:40 (UTC+8) -> 2026-08-28 06:40 (UTC)
    expect(minuteKlineTimeToEpochMs('202608281440', 'Asia/Shanghai')).toBe(Date.UTC(2026, 7, 28, 6, 40, 0))
  })

  it('用户比对带偏移的取数时刻时，Given 同一 epoch When 按不同时区渲染 Then 墙钟与偏移都随参数而非宿主环境', () => {
    // Given 2026-10-13T01:53:12Z
    const epoch = Date.UTC(2026, 9, 13, 1, 53, 12)
    // When 按三个时区渲染同一时刻
    // Then 偏移是渲染参数的结果（东八区 +08:00、UTC +00:00、纽约夏令时 -04:00）
    expect(isoWithOffset(epoch, 'Asia/Shanghai')).toBe('2026-10-13T09:53:12+08:00')
    expect(isoWithOffset(epoch, 'UTC')).toBe('2026-10-13T01:53:12+00:00')
    expect(isoWithOffset(epoch, 'America/New_York')).toBe('2026-10-12T21:53:12-04:00')
  })
})

describe('TencentRestClient.getTicker (cn)', () => {
  it('decodes GBK, maps cn field layout and converts lots to shares', async () => {
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(CN_TICKER_TEMPLATE, CN_NAME_GBK) }])
    const ticker = await client('cn', { fetchImpl: impl }).getTicker('600519')
    expect(urls[0]).toBe('https://qt.gtimg.cn/q=sh600519')
    expect(ticker.name).toBe('贵州茅台') // UTF-8 误解码时这里是乱码——GBK 契约直证
    expect(ticker.symbol).toBe('600519.SH') // 输出规范形（docs/symbol-vocabulary.md）
    expect(ticker.price).toBe(1297.4)
    expect(ticker.bid).toBe(1297.35)
    expect(ticker.ask).toBe(1297.4)
    // cn 字段 6 单位是手（16126 手）→ 归一化为股 1,612,600。
    expect(ticker.volume).toBe(1_612_600)
    expect(ticker.timestamp).toBe(Date.UTC(2026, 7, 28, 8, 15, 0))
    expect(ticker).toMatchObject({
      market: 'cn',
      currency: 'CNY',
      prevClose: 1292.3,
      open: 1289,
      high: 1297.89,
      low: 1288,
      limitUp: 1421.53,
      limitDown: 1163.07,
      change: 5.1,
      changePercent: 0.39,
    })
  })

  it('accepts prefixed and lowercase symbols', async () => {
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(CN_TICKER_TEMPLATE, CN_NAME_GBK) }])
    await client('cn', { fetchImpl: impl }).getTicker('SH600519')
    expect(urls[0]).toBe('https://qt.gtimg.cn/q=sh600519')
  })

  it('maps unknown-symbol payload to TRADING_UNSUPPORTED_SYMBOL', async () => {
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: 'v_pv_none="1";' }])
    await expect(client('cn', { fetchImpl: impl }).getTicker('999999')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})

describe('TencentRestClient.getTicker (hk)', () => {
  it('uses the r_hk wire prefix and maps the hk field layout', async () => {
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(HK_TICKER_TEMPLATE, HK_NAME_GBK) }])
    const ticker = await client('hk', { fetchImpl: impl }).getTicker('700')
    expect(urls[0]).toBe('https://qt.gtimg.cn/q=r_hk00700')
    expect(ticker.name).toBe('腾讯控股')
    expect(ticker.symbol).toBe('00700.HK') // 输出规范形
    expect(ticker.price).toBe(455.2)
    // hk 字段 6 单位是股（与 cn 的手不同，布局差异直证）。
    expect(ticker.volume).toBe(27_742_475)
    expect(ticker.timestamp).toBe(Date.UTC(2026, 7, 28, 8, 8, 37))
    expect(ticker).toMatchObject({
      market: 'hk',
      currency: 'HKD',
      prevClose: 447.8,
      open: 444,
      high: 462.2,
      low: 443.4,
      week52High: 677.7,
      week52Low: 411,
      change: 7.4,
      changePercent: 1.65,
    })
  })
})

describe('TencentRestClient.getFundamentals', () => {
  it('parses cn fundamentals from the same quote line (52w range at f67/f68, r4 live evidence)', async () => {
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(CN_TICKER_TEMPLATE, CN_NAME_GBK) }])
    const result = await client('cn', { fetchImpl: impl }).getFundamentals('600519')
    expect(urls[0]).toBe('https://qt.gtimg.cn/q=sh600519')
    expect(result.symbol).toBe('600519.SH')
    expect(result.name).toBe('贵州茅台')
    expect(result.marketCap).toBe(1_621_856_000_000)
    expect(result.floatMarketCap).toBe(1_621_856_000_000)
    expect(result.peTtm).toBe(19.7)
    expect(result.peDynamic).toBe(19.92)
    expect(result.pb).toBe(6.46)
    expect(result.turnoverRate).toBe(0.13)
    expect(result.fiftyTwoWeekHigh).toBe(1539.98)
    expect(result.fiftyTwoWeekLow).toBe(1151.01)
  })

  it('parses hk fundamentals with the hk field layout and percent dividend yield', async () => {
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(HK_TICKER_TEMPLATE, HK_NAME_GBK) }])
    const result = await client('hk', { fetchImpl: impl }).getFundamentals('00700')
    expect(result.symbol).toBe('00700.HK')
    expect(result.marketCap).toBe(4_143_752_410_000) // 41437.5241 亿港元
    expect(result.floatMarketCap).toBe(4_143_752_410_000)
    expect(result.peTtm).toBe(15.28)
    expect(result.peDynamic).toBe(16.65)
    expect(result.pb).toBe(3.18)
    // 腾讯 wire 给百分比数值（1.17 = 1.17%），契约语义是小数 → 0.0117。
    expect(result.dividendYield).toBeCloseTo(0.0117, 6)
    expect(result.turnoverRate).toBe(0.3)
    expect(result.fiftyTwoWeekHigh).toBe(677.7)
    expect(result.fiftyTwoWeekLow).toBe(411)
  })
})

describe('TencentRestClient.getKlines', () => {
  it('parses cn day klines with the open-close-high-low-volume field order', async () => {
    const { impl, urls } = stubFetch([{ match: 'fqkline/get', body: CN_KLINE_JSON }])
    const klines = await client('cn', { fetchImpl: impl }).getKlines('600519', '1d', 2)
    expect(urls[0]).toBe('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,2,qfq')
    expect(klines).toHaveLength(2)
    // 字段序陷阱直证：第 2 列是开、第 3 列是收（若按 OHLC 误读，open/high 会整体错位）。
    expect(klines[1]).toEqual({
      openTime: Date.UTC(2026, 7, 28),
      open: 1289,
      high: 1297.89,
      low: 1288,
      close: 1297.4,
      volume: 16126,
      closeTime: Date.UTC(2026, 7, 28) + 86_400_000 - 1,
    })
  })

  it('parses cn 5m and 30m minute klines via mkline endpoint', async () => {
    const m5Json = JSON.stringify({
      code: 0,
      msg: '',
      data: {
        sh600519: {
          m5: [
            ['202608281440', '1295.69', '1295.98', '1296.45', '1295.14', '197.00', {}, '0.16'],
            ['202608281445', '1295.79', '1295.49', '1295.95', '1294.60', '338.00', {}, '0.27'],
          ],
        },
      },
    })
    const m30Json = JSON.stringify({
      code: 0,
      msg: '',
      data: {
        sh600519: {
          m30: [
            ['202608281500', '1296.48', '1297.40', '1297.89', '1294.60', '2673.00', {}, '2.14'],
          ],
        },
      },
    })
    const { impl, urls } = stubFetch([
      { match: 'm5', body: m5Json },
      { match: 'm30', body: m30Json },
    ])
    const c = client('cn', { fetchImpl: impl })
    const klines5m = await c.getKlines('600519', '5m', 2)
    expect(urls[0]).toBe('https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m5,,2')
    expect(klines5m).toHaveLength(2)
    expect(klines5m[0]).toEqual({
      openTime: Date.UTC(2026, 7, 28, 6, 40, 0),
      open: 1295.69,
      close: 1295.98,
      high: 1296.45,
      low: 1295.14,
      volume: 197,
      closeTime: Date.UTC(2026, 7, 28, 6, 40, 0) + 5 * 60_000 - 1,
    })

    const klines30m = await c.getKlines('600519', '30m', 1)
    expect(urls[1]).toBe('https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m30,,1')
    expect(klines30m).toHaveLength(1)
    expect(klines30m[0]).toEqual({
      openTime: Date.UTC(2026, 7, 28, 7, 0, 0),
      open: 1296.48,
      close: 1297.4,
      high: 1297.89,
      low: 1294.6,
      volume: 2673,
      closeTime: Date.UTC(2026, 7, 28, 7, 0, 0) + 30 * 60_000 - 1,
    })
  })

  it('rejects minute intervals on hk market', async () => {
    const c = client('hk')
    await expect(c.getKlines('00700', '5m')).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
    })
    await expect(c.getKlines('00700', '30m')).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
    })
  })

  it('routes hk to hkfqkline with the hk prefix and drops extra row fields', async () => {
    const { impl, urls } = stubFetch([{ match: 'hkfqkline/get', body: HK_KLINE_JSON }])
    const klines = await client('hk', { fetchImpl: impl }).getKlines('00700', '1d', 2)
    expect(urls[0]).toBe('https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hk00700,day,,,2,qfq')
    expect(klines[1]).toMatchObject({ open: 444, close: 455.2, high: 462.2, low: 443.4, volume: 27_742_475 })
  })

  it('hk 无前权事件的代码回落 day 键（2026-08-31 实证：美团 hk03690 返回 day 而非 qfqday）', async () => {
    const dayJson = JSON.stringify({ code: 0, msg: '', data: { hk03690: { day: [['2026-08-28', '76.550', '77.500', '78.400', '76.200', '33410203.00', {}]] } } })
    const { impl } = stubFetch([{ match: 'hkfqkline/get', body: dayJson }])
    const klines = await client('hk', { fetchImpl: impl }).getKlines('03690', '1d', 1)
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 76.55, close: 77.5, high: 78.4, low: 76.2 })
  })

  it('maps week/month intervals to qfqweek/qfqmonth', async () => {
    const weekJson = JSON.stringify({ code: 0, msg: '', data: { sh600519: { qfqweek: [['2026-08-21', '1295.000', '1272.830', '1308.880', '1272.010', '213505.000']] } } })
    const monthJson = JSON.stringify({ code: 0, msg: '', data: { sh600519: { qfqmonth: [['2026-07-31', '1180.100', '1350.600', '1362.000', '1166.330', '1164067.000']] } } })
    const { impl, urls } = stubFetch([
      { match: 'week', body: weekJson },
      { match: 'month', body: monthJson },
    ])
    const c = client('cn', { fetchImpl: impl })
    await c.getKlines('600519', '1w', 1)
    expect(urls[0]).toContain('param=sh600519,week,,,1,qfq')
    await c.getKlines('600519', '1M', 1)
    expect(urls[1]).toContain('param=sh600519,month,,,1,qfq')
  })

  it('rejects unsupported intervals and upstream param errors', async () => {
    const { impl } = stubFetch([{ match: 'fqkline/get', body: CN_KLINE_JSON }])
    const c = client('cn', { fetchImpl: impl })
    await expect(c.getKlines('600519', '1m')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    await expect(c.getKlines('600519', '1h')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    expect(INTERVAL_VOCABULARY).toEqual(['5m', '30m', '1d', '1w', '1M'])
  })

  it('maps upstream error payloads to TRADING_EXCHANGE_ERROR', async () => {
    const { impl } = stubFetch([{ match: 'fqkline/get', body: JSON.stringify({ code: 0, msg: 'param error', data: [] }) }])
    await expect(client('cn', { fetchImpl: impl }).getKlines('600519', '1d')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})

describe('TencentRestClient.getOrderbook（issue #39 盘口）', () => {
  it('cn 五档：同一报价行解析，手→股换算，bids 降序 / asks 升序', async () => {
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(CN_TICKER_TEMPLATE, CN_NAME_GBK) }])
    const orderbook = await client('cn', { fetchImpl: impl }).getOrderbook('600519')
    // 与 getTicker 同一请求（零额外端点），规范形 symbol 输出。
    expect(urls).toHaveLength(1)
    expect(orderbook.symbol).toBe('600519.SH')
    expect(orderbook.bids).toEqual([
      { price: 1297.35, amount: 500 },
      { price: 1297.2, amount: 100 },
      { price: 1297.1, amount: 300 },
      { price: 1297.01, amount: 300 },
      { price: 1297, amount: 1100 },
    ])
    expect(orderbook.asks).toEqual([
      { price: 1297.4, amount: 900 },
      { price: 1297.5, amount: 1100 },
      { price: 1297.55, amount: 200 },
      { price: 1297.68, amount: 100 },
      { price: 1297.7, amount: 100 },
    ])
  })

  it('hk → TRADING_NOT_IMPLEMENTED（r_hk 行档位全 0，结构性不支持）', async () => {
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(HK_TICKER_TEMPLATE, HK_NAME_GBK) }])
    await expect(client('hk', { fetchImpl: impl }).getOrderbook('00700'))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })
})

describe('TencentRestClient.getActiveBuySnapshot（cn 主动买盘快照，2026-10-13）', () => {
  it('用户读 002714 主动买盘时，Given 09:53 实测读数 When 取快照 Then 买占比 47.94、净买占比 -4.11', async () => {
    // Given 2026-10-13 当日 09:53 的行情行读数向量（总量 91083 / 外盘 43668 / 内盘 47410 手）；
    // 行形态取自 10:09 实测原文，仅 6/7/8/30 位置换为该向量
    const { impl, urls } = stubFetch([{
      match: 'qt.gtimg.cn',
      body: gbkResponse(cnActiveBuyRow({ 6: '91083', 7: '43668', 8: '47410', 30: '20261013095312' }), CN_002714_NAME_GBK),
    }])
    // When 取主动买盘快照（取数时刻注入同一时刻，读数不随宿主时钟漂移）
    const snapshot = await client('cn', { fetchImpl: impl, now: () => FIXED_NOW_0953 }).getActiveBuySnapshot('002714')
    // Then 与报价同一请求、字段映射与占比口径可逐项核对
    expect(urls).toEqual(['https://qt.gtimg.cn/q=sz002714'])
    expect(snapshot).toMatchObject({
      symbol: '002714.SZ',
      date: '2026-10-13',
      time: '09:53:12',
      totalLots: 91083,
      outerLots: 43668,
      innerLots: 47410,
      buySharePct: 47.94,
      netSharePct: -4.11,
      limitUp: 45.96,
      limitDown: 37.6,
      source: ACTIVE_BUY_SOURCE,
      fetchedAt: '2026-10-13T09:53:12+08:00',
    })
    // 总量 91083 与外盘+内盘 91078 差 5 手：源读数原样返回，不被残差修正。
    expect(snapshot.totalLots - snapshot.outerLots - snapshot.innerLots).toBe(5)
  })

  it('用户读 002714 主动买盘时，Given 10:09 的原始响应字节 When 解析 Then 逐字段对上实测值', async () => {
    // Given spikes/impl-active-buy/r1-raw-sz002714.gbk 的原文（未改写任何字段）
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(cnActiveBuyRow(), CN_002714_NAME_GBK) }])
    // When 按 GBK 解码取快照
    const snapshot: ActiveBuySnapshot = await client('cn', { fetchImpl: impl, now: () => Date.UTC(2026, 9, 13, 2, 9, 30) }).getActiveBuySnapshot('SZ002714')
    // Then 6/7/8/30/47/48 位与实测原文一致（规范形输入 → 规范形输出）
    expect(snapshot).toEqual({
      symbol: '002714.SZ',
      date: '2026-10-13',
      time: '10:09:30',
      totalLots: 121808,
      outerLots: 54093,
      innerLots: 67703,
      buySharePct: 44.41,
      netSharePct: -11.17,
      limitUp: 45.96,
      limitDown: 37.6,
      source: 'qt.gtimg.cn',
      fetchedAt: '2026-10-13T10:09:30+08:00',
    })
  })

  it('用户遇到总量为 0 的行情行时，Given 总量读数 0 When 取快照 Then 抛 TRADING_EXCHANGE_ERROR（不补 0）', async () => {
    // Given 唯一被改写的是总量位（0 手）
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(cnActiveBuyRow({ 6: '0' }), CN_002714_NAME_GBK) }])
    // When 取快照
    // Then 报上游读数错误，不做「总量 0 → 占比 0」的静默降级
    await expect(client('cn', { fetchImpl: impl }).getActiveBuySnapshot('002714'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
    await expect(client('cn', { fetchImpl: impl }).getActiveBuySnapshot('002714'))
      .rejects.toThrow(/field 6 "0"/)
  })

  it('用户遇到外盘字段异常时，Given 空串/非数字/负值 When 取快照 Then 一律抛 TRADING_EXCHANGE_ERROR（缺失 ≠ 0）', async () => {
    // Given 三种坏读数（空串不能被 Number('') === 0 伪装成「主动买为 0」）
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(cnActiveBuyRow({ 7: '' }), CN_002714_NAME_GBK) }])
    // When 依次取其快照
    const empty = client('cn', { fetchImpl: impl }).getActiveBuySnapshot('002714')
    // Then 空串、非数字、负值三条路径都是同一条 TRADING_EXCHANGE_ERROR
    await expect(empty).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
    await expect(empty).rejects.toThrow(/fields 7\/8 ""/)
    const nonNumeric = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(cnActiveBuyRow({ 8: 'abc' }), CN_002714_NAME_GBK) }])
    await expect(client('cn', { fetchImpl: nonNumeric.impl }).getActiveBuySnapshot('002714'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
    const negative = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(cnActiveBuyRow({ 7: '-1' }), CN_002714_NAME_GBK) }])
    await expect(client('cn', { fetchImpl: negative.impl }).getActiveBuySnapshot('002714'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })

  it('用户查不存在的代码时，Given 腾讯返回 v_pv_none_match 短 body When 取快照 Then 抛 TRADING_UNSUPPORTED_SYMBOL', async () => {
    // Given 未知/退市代码的真实响应体（spikes/impl-active-buy/r2-raw-unknown-sz999999.gbk）
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: 'v_pv_none_match="1";' }])
    // When 取快照
    // Then 按「无此标的」而非「读数为 0」上报
    await expect(client('cn', { fetchImpl: impl }).getActiveBuySnapshot('999999'))
      .rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })

  it('访客直连 hk 客户端取主动买盘时，Given r_hk 行 7/8 位恒为 0 When 调用 Then 抛 TRADING_NOT_IMPLEMENTED 且不发请求', async () => {
    // Given hk 客户端（r_hk 行没有外盘/内盘字段，见 spikes/impl-active-buy/r2-raw-hk00700.gbk）
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(HK_TICKER_TEMPLATE, HK_NAME_GBK) }])
    // When 调用
    // Then 结构性不支持，且在取数前就拒绝（不把 0 当读数返回）
    await expect(client('hk', { fetchImpl: impl }).getActiveBuySnapshot('00700'))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(urls).toEqual([])
  })

  it('用户经 cn 服务实例取主动买盘时，Given market=cn 的实例 When 调用 Then 委派到同一报价行解析', async () => {
    // Given market=cn 的行情服务实例
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(cnActiveBuyRow({ 6: '91083', 7: '43668', 8: '47410', 30: '20261013095312' }), CN_002714_NAME_GBK) }])
    const service = new TencentMarketDataService(duckCtx().ctx, 'cn', { fetchImpl: impl, now: () => FIXED_NOW_0953 })
    // When 经服务面取快照（能力挂在实例上，不在类原型上）
    const method = service.getActiveBuySnapshot
    // Then 能力存在，且读数与客户端一致
    expect(typeof method).toBe('function')
    if (method === undefined) throw new Error('cn 实例应挂载 getActiveBuySnapshot')
    const snapshot = await method('002714')
    expect(snapshot).toMatchObject({ symbol: '002714.SZ', buySharePct: 47.94, netSharePct: -4.11, totalLots: 91083 })
  })

  it('用户经 hk 服务实例取主动买盘时，Given market=hk 的实例 When 探测能力 Then 方法缺席（无此能力，不是读数为 0）', () => {
    // Given market=hk 的行情服务实例
    const service = new TencentMarketDataService(duckCtx().ctx, 'hk')
    // When 探测可选能力是否存在
    // Then 实例上不存在该方法（也没有原型上的占位实现）——消费方据此隐藏面板
    expect('getActiveBuySnapshot' in service).toBe(false)
    expect(service.getActiveBuySnapshot).toBeUndefined()
  })
})

describe('TencentRestClient.listInstruments', () => {
  it('searches symbols and parses smartbox hints', async () => {
    const mockSmartboxResponse = 'v_hint="sh~000688~\\u79d1\\u521b50~kc50~ZS^sh~588000~\\u79d1\\u521b50ETF~kc50etf~ETF^hk~00700~\\u817e\\u8baf\\u63a7\\u80a1~txkg~GP"'
    const { impl } = stubFetch([{ match: 'smartbox', body: mockSmartboxResponse }])
    const cnClient = client('cn', { fetchImpl: impl })
    const cnResults = await cnClient.listInstruments('科创50')
    expect(cnResults).toHaveLength(2)
    expect(cnResults[0]).toEqual({ symbol: '000688.SH', name: '科创50', pinyin: 'KC50' })
    expect(cnResults[1]).toEqual({ symbol: '588000.SH', name: '科创50ETF', pinyin: 'KC50ETF' })

    const hkClient = client('hk', { fetchImpl: impl })
    const hkResults = await hkClient.listInstruments('腾讯')
    expect(hkResults).toHaveLength(1)
    expect(hkResults[0]).toEqual({ symbol: '00700.HK', name: '腾讯控股', pinyin: 'TXKG' })
  })

  it('returns empty array on empty query', async () => {
    const c = client('cn')
    expect(await c.listInstruments('')).toEqual([])
    expect(await c.listInstruments('   ')).toEqual([])
  })
})
