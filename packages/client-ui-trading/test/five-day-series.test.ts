/**
 * 五日级别纯计算单测：交易日分组与 5 日截取（含当日进行中）、跨日同分钟对齐、
 * 缺分钟/缺日、首日基准、除零与全零量、分档边界 r=1/2/3、时区 cn/hk/us、
 * 颜色映射，以及「能力驱动」的路由判定（不出现 ≠ 渲染占位数据）。
 *
 * 时间锚点：2026-09 美股 ET=UTC-4（EDT）、A股/港股 CST/HKT=UTC+8。
 * us 常规时段 9:30 ET = 13:30Z，cn/hk 9:30 本地 = 01:30Z。
 */
import { describe, expect, it } from 'vitest'
import {
  FIVE_DAY_INTERVAL, FIVE_DAY_KLINE_LIMIT, FIVE_DAY_LEGEND_TIERS, FIVE_DAY_RESYNC_MS,
  chartIntervals, fiveDayCapability, fiveDayDayStarts, fiveDayVolumeColor, groupTradingDays,
  ratioTier, recentTradingDays, rememberableInterval, toFiveDayBars,
} from '../src/client/five-day-series.ts'
import type { FiveDayTier } from '../src/client/five-day-series.ts'
import { selectApplicableInstances, supportedIntervals } from '../src/client/indicator-scope.ts'
import type { IndicatorInstance } from '@dshtrading/indicators'
import type { Kline, MarketId } from '../src/client/types.ts'

function bar(openTime: number, volume: number): Kline {
  return { openTime, open: 100, high: 101, low: 99, close: 100, volume, closeTime: openTime + 60_000 }
}

/** 美股第 n 个交易日的第 m 分钟（10:00 ET 起，全部落在同一本地日内）。 */
function usMinute(dayOfMonth: number, minute: number): number {
  return Date.UTC(2026, 8, dayOfMonth, 14, 0) + minute * 60_000
}

/** A股/港股本地交易日第 m 分钟（10:00 本地起）。 */
function cnMinute(dayOfMonth: number, minute: number): number {
  return Date.UTC(2026, 8, dayOfMonth, 2, 0) + minute * 60_000
}

/** 同分钟跨 5 个交易日：每个交易日 3 根（m=0/1/2），量由 days 逐日给出。 */
function fiveDays(market: MarketId, days: number[][], dayOfMonth: readonly number[]): Kline[] {
  const out: Kline[] = []
  for (let i = 0; i < days.length; i++) {
    const at = market === 'us' ? usMinute : cnMinute
    for (let m = 0; m < (days[i] as number[]).length; m++) {
      out.push(bar(at(dayOfMonth[i] as number, m), (days[i] as number[])[m] as number))
    }
  }
  return out
}

describe('五日级别的交易日分组与窗口截取', () => {
  it('用户按市场本地日分组时只看见真实存在的交易日，停牌日不会凭空出现', () => {
    // Given 美股三个交易日的 1m bar（09-03 缺 09-04 的早盘时段，09-07 是劳动节休市）
    const klines = [
      bar(usMinute(3, 0), 10), bar(usMinute(3, 1), 10),
      // 2026-09-04T00:30Z = 09-03 20:30 ET（同一 UTC 日、不同本地日）
      bar(Date.UTC(2026, 8, 4, 0, 30), 10),
      bar(usMinute(8, 0), 10),
    ]

    // When 分组
    const days = groupTradingDays('us', klines)

    // Then 本地日 09-03 的三根归一日（09-04T00:30Z 在纽约还是 09-03 20:30，UTC 日相同与否不作数），09-08 独立成日
    expect(days.map(day => day.date)).toEqual(['2026-09-03', '2026-09-08'])
    expect(days[0]?.bars).toHaveLength(3)
    expect(days[1]?.bars).toHaveLength(1)
  })

  it('用户看五日级别时窗口是最近 5 个交易日，当日进行中照常入窗为最后一根', () => {
    // Given 六个交易日的 bar（09-18 与 09-21..25），其中最后一日只有 2 根（当日盘中）
    const dayOfMonth = [18, 21, 22, 23, 24, 25]
    const days = dayOfMonth.map(() => [1, 1, 1])
    days[5] = [1, 1]
    const klines = fiveDays('us', days, dayOfMonth)

    // When 截取最近 5 个交易日
    const window = recentTradingDays('us', klines)

    // Then 09-18 被截掉，窗口 5 日，末日是进行中的 2 根
    expect(window).toHaveLength(5)
    expect(window.map(day => day.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'])
    expect(window[4]?.bars).toHaveLength(2)
  })

  it('用户看到的五日序列是各交易日按时间顺序拼接，根数与入窗 bar 一一对应', () => {
    // Given 五个交易日、每日 3 根
    const klines = fiveDays('us', [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]], [25, 26, 27, 28, 31])

    // When 转成五日序列
    const bars = toFiveDayBars('us', klines)

    // Then 15 根升序，dayIndex 0..4 逐日递增
    expect(bars).toHaveLength(15)
    expect(bars.map(b => b.dayIndex)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4])
    expect(bars[0]?.kline.openTime).toBeLessThan(bars[14]?.kline.openTime as number)
  })

  it('用户切到 A 股与港股时分组与同分钟对齐都用各自市场时区', () => {
    // Given A股 09-07 15:00 CST（07:00Z）与 09-08 09:30 CST（01:30Z）两根：UTC 日不同、本地日也不同
    const cn = [bar(Date.UTC(2026, 8, 7, 7, 0), 5), bar(Date.UTC(2026, 8, 8, 1, 30), 5)]

    // When 分组
    const cnDays = groupTradingDays('cn', cn)

    // Then 两个本地交易日分别成组
    expect(cnDays.map(day => day.date)).toEqual(['2026-09-07', '2026-09-08'])
    // 港股同款口径（HKT=UTC+8）：01:30Z 属 09-08 本地日
    expect(groupTradingDays('hk', cn).map(day => day.date)).toEqual(['2026-09-07', '2026-09-08'])
    // crypto 无交易日概念，不进五日级别
    expect(groupTradingDays('crypto', cn)).toEqual([])
    expect(toFiveDayBars('crypto', cn)).toEqual([])
  })
})

describe('五日级别量比（同分钟跨日对齐）', () => {
  it('用户看到的量比取前 1-4 个交易日同一本地时钟分钟的成交量均值', () => {
    // Given 第 i-1 日 10:00 量 100、10:01 量 200；第 i 日 10:00 量 150、10:01 量 300
    const klines = fiveDays('us', [[100, 200], [150, 300]], [3, 4])

    // When 计算
    const bars = toFiveDayBars('us', klines)
    const day1 = bars.filter(b => b.dayIndex === 1)

    // Then 分母是同分钟（不是同日其它分钟，也不是跨分钟串味）
    expect(day1[0]?.priorDays).toBe(1)
    expect(day1[0]?.ratio).toBeCloseTo(150 / 100)
    expect(day1[1]?.ratio).toBeCloseTo(300 / 200)
  })

  it('用户遇到某前日缺该分钟时该日不参与均值，前值不足 4 日按可得天数', () => {
    // Given 三日：09-01 有 10:00=100 与 10:01=400；09-02 只有 10:00=300（缺 10:01）；09-03 有 10:00=200 与 10:01=200
    const klines = [
      bar(usMinute(1, 0), 100), bar(usMinute(1, 1), 400),
      bar(usMinute(2, 0), 300),
      bar(usMinute(3, 0), 200), bar(usMinute(3, 1), 200),
    ]

    // When 计算
    const bars = toFiveDayBars('us', klines)
    const day2 = bars.filter(b => b.dayIndex === 2)

    // Then 10:00 有 2 个前值（100/300 → 均值 200 → r=1）；10:01 只 1 个前值（400 → r=0.5）
    expect(day2[0]?.priorDays).toBe(2)
    expect(day2[0]?.ratio).toBeCloseTo(1)
    expect(day2[1]?.priorDays).toBe(1)
    expect(day2[1]?.ratio).toBeCloseTo(0.5)
  })

  it('用户遇到某分钟完全没有前值时看到中性灰，而不是被当成最低档', () => {
    // Given 前一日没有 10:01，当日有 10:01
    const klines = [bar(usMinute(3, 0), 100), bar(usMinute(4, 0), 100), bar(usMinute(4, 1), 50)]

    // When 计算
    const bars = toFiveDayBars('us', klines)
    const missingPrior = bars.find(b => b.dayIndex === 1 && b.minute !== bars[0]?.minute)

    // Then 无前值：ratio 缺席 + noPrior（中性灰），绝不是 lt1
    expect(missingPrior?.priorDays).toBe(0)
    expect(missingPrior?.ratio).toBeNull()
    expect(missingPrior?.tier).toBe('noPrior')
    expect(fiveDayVolumeColor('noPrior', false)).toBe(fiveDayVolumeColor('baseline', false))
  })

  it('用户遇到前值全零时：本分钟也为 0 记中性灰，本分钟有量记最高档', () => {
    // Given 前一日的两个分钟量都是 0；当日 m=0 量 0、m=1 量 30
    const klines = fiveDays('us', [[0, 0], [0, 30]], [3, 4])

    // When 计算
    const day1 = toFiveDayBars('us', klines).filter(b => b.dayIndex === 1)

    // Then 0/0 无定义 → 中性灰；30/0 → 发散，按 r≥3 最高档
    expect(day1[0]?.ratio).toBeNull()
    expect(day1[0]?.tier).toBe('noPrior')
    expect(day1[1]?.ratio).toBe(Number.POSITIVE_INFINITY)
    expect(day1[1]?.tier).toBe('gte3')
  })

  it('用户看到的窗口最早一日是基准日：不着色且没有量比', () => {
    // Given 五个交易日，基准日量很小（若被着色会落到 lt1）
    const klines = fiveDays('us', [[1, 1], [500, 500], [500, 500], [500, 500], [500, 500]], [25, 26, 27, 28, 31])

    // When 计算
    const bars = toFiveDayBars('us', klines)

    // Then 基准日两根都是 baseline/中性灰，其余日照常算量比
    const baseline = bars.filter(b => b.dayIndex === 0)
    expect(baseline.map(b => b.tier)).toEqual(['baseline', 'baseline'])
    expect(baseline.map(b => b.ratio)).toEqual([null, null])
    expect(bars.find(b => b.dayIndex === 1)?.tier).toBe('gte3')
  })

  it('用户看到的量比只用前 1-4 个交易日，更早的交易日不进分母', () => {
    // Given 六个交易日同分钟量：前 4 日 = 10，第 5 日 = 1000（不应进分母），第 6 日 = 10
    const klines = fiveDays('us', [[10], [10], [10], [10], [1000], [10]], [24, 25, 26, 27, 28, 31])

    // When 计算（窗口 5 日 = 25..31，基准 25，末日 31 的前值只有 26/27/28/31-1=28 四日 → 10）
    const bars = toFiveDayBars('us', klines)

    // Then 第 5 个交易日（dayIndex 4 = 31 日）分母是它之前的 4 日 10/10/10/1000 → 均值 257.5
    const last = bars.filter(b => b.dayIndex === 4)
    expect(last[0]?.priorDays).toBe(4)
    expect(last[0]?.ratio).toBeCloseTo(10 / 257.5)
  })
})

describe('五日级别的分档与颜色映射', () => {
  it('用户在 r=1/2/3 边界上看到的是左闭右开的档位', () => {
    // Given 前一分钟量恒为 100，当日量分别取 99/100/199/200/299/300
    const klines = [
      bar(usMinute(3, 0), 100), bar(usMinute(3, 1), 100), bar(usMinute(3, 2), 100),
      bar(usMinute(3, 3), 100), bar(usMinute(3, 4), 100), bar(usMinute(3, 5), 100),
      bar(usMinute(4, 0), 99), bar(usMinute(4, 1), 100), bar(usMinute(4, 2), 199),
      bar(usMinute(4, 3), 200), bar(usMinute(4, 4), 299), bar(usMinute(4, 5), 300),
    ]

    // When 计算
    const day1 = toFiveDayBars('us', klines).filter(b => b.dayIndex === 1)

    // Then r<1 黄；1≤r<2 浅红；2≤r<3 深红；r≥3 黑
    expect(day1.map(b => b.tier)).toEqual(['lt1', 'lt2', 'lt2', 'lt3', 'lt3', 'gte3'])
    expect(ratioTier(0.99)).toBe('lt1')
    expect(ratioTier(1)).toBe('lt2')
    expect(ratioTier(1.99)).toBe('lt2')
    expect(ratioTier(2)).toBe('lt3')
    expect(ratioTier(2.99)).toBe('lt3')
    expect(ratioTier(3)).toBe('gte3')
  })

  it('用户切亮色/深色主题时四档与中性灰都分得清，且不受红涨绿跌设置影响', () => {
    // Given 全部档位
    const tiers: FiveDayTier[] = ['lt1', 'lt2', 'lt3', 'gte3', 'baseline']

    // When 取亮色与深色两套颜色
    const light = tiers.map(tier => fiveDayVolumeColor(tier, false))
    const dark = tiers.map(tier => fiveDayVolumeColor(tier, true))

    // Then 两套各自五色互不相同（可辨认），且都是合法十六进制
    expect(new Set(light).size).toBe(tiers.length)
    expect(new Set(dark).size).toBe(tiers.length)
    for (const color of [...light, ...dark]) expect(color).toMatch(/^#[0-9a-f]{6}$/)
    // 深色主题下最高档与中性灰不同色（深色底上真黑不可辨认，换近白高对比）
    expect(fiveDayVolumeColor('gte3', true)).not.toBe(fiveDayVolumeColor('baseline', true))
    expect(fiveDayVolumeColor('gte3', true)).toBe('#f2f4f8')
    // 颜色只由「档位 + 主题」决定，不存在红涨绿跌入参
    expect(fiveDayVolumeColor('lt3', false)).toBe('#c62828')
  })

  it('用户看到的图例覆盖四档量比阈值与基准日/无前值语义', () => {
    // Given 图例档位顺序
    // Then 四档 + 基准日 + 无前值，且中性灰两档同色
    expect(FIVE_DAY_LEGEND_TIERS).toEqual(['lt1', 'lt2', 'lt3', 'gte3', 'baseline', 'noPrior'])
    expect(fiveDayVolumeColor('baseline', true)).toBe(fiveDayVolumeColor('noPrior', true))
  })
})

describe('五日级别的日界与轴拼接', () => {
  it('用户看到日界标在除首日外每个交易日的第一根K线上', () => {
    // Given 五个交易日各 2 根
    const klines = fiveDays('us', [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]], [25, 26, 27, 28, 31])

    // When 取日界时刻
    const starts = fiveDayDayStarts(toFiveDayBars('us', klines))

    // Then 4 条日界（26/27/28/31 日首根），不含窗口首日 25 日
    expect(starts).toEqual([usMinute(26, 0), usMinute(27, 0), usMinute(28, 0), usMinute(31, 0)])
    expect(fiveDayDayStarts([])).toEqual([])
  })

  it('用户切到五日级别时轴按交易日拼接：bar 之间无隔夜空档，只有 K 线槽位', () => {
    // Given 相邻两个交易日各 2 根（跨了 17 小时隔夜）
    const klines = fiveDays('us', [[1, 1], [1, 1]], [3, 4])

    // When 转成五日序列
    const bars = toFiveDayBars('us', klines)

    // Then 序列连续（4 根，无补白），日界恰在 index 2（第二日首根）
    expect(bars).toHaveLength(4)
    const starts = fiveDayDayStarts(bars)
    expect(starts).toHaveLength(1)
    expect(bars.findIndex(b => b.kline.openTime === starts[0])).toBe(2)
  })
})

describe('五日级别的能力驱动出现规则', () => {
  it('用户切到 us+yahoo 或 cn/hk+eastmoney 时五日胶囊紧跟日K出现', () => {
    // Given 三类可得路由
    // Then '5d' 紧随 '1d'，与既有级别平级
    expect(chartIntervals('us', 'yahoo')).toEqual(['5m', '15m', '30m', '1h', '1d', '5d', '1w', '1M'])
    expect(chartIntervals('cn', 'eastmoney')).toEqual(['5m', '30m', '1d', '5d', '1w', '1M'])
    expect(chartIntervals('hk', 'eastmoney')).toEqual(['5m', '15m', '30m', '1h', '1d', '5d', '1w', '1M'])
    expect(FIVE_DAY_INTERVAL).toBe('5d')
  })

  it('用户切到 crypto/futures/global 或 cn/hk 走腾讯路由时看不到五日胶囊', () => {
    // Given 结构性不可得的市场与路由
    // Then 能力一律 no，级别列表原样返回（不出现，也不渲染假数据）
    expect(fiveDayCapability('crypto', 'okx')).toBe('no')
    expect(fiveDayCapability('futures', 'hithink')).toBe('no')
    expect(fiveDayCapability('global', 'jin10')).toBe('no')
    expect(fiveDayCapability('cn', 'tencent')).toBe('no')
    expect(fiveDayCapability('hk', 'tencent')).toBe('no')
    expect(chartIntervals('cn', 'tencent')).toEqual(['5m', '30m', '1d', '1w', '1M'])
    expect(chartIntervals('hk', 'tencent')).not.toContain(FIVE_DAY_INTERVAL)
    expect(chartIntervals('crypto', 'okx')).not.toContain(FIVE_DAY_INTERVAL)
  })

  it('用户首次打开时 provider 还没回来，市场不据此判定为不可得', () => {
    // Given provider 缺失（markets 请求未回）
    // Then 三态是 unknown（既不出现胶囊，也不把级别记忆清成不可得）
    expect(fiveDayCapability('us', undefined)).toBe('unknown')
    expect(fiveDayCapability('cn', '')).toBe('unknown')
    expect(chartIntervals('us', undefined)).toEqual(['5m', '15m', '30m', '1h', '1d', '1w', '1M'])
    // 结构性不可得的市场即使 provider 未知也是 no
    expect(fiveDayCapability('futures', undefined)).toBe('no')
  })

  it('用户切到五日级别时取数上限与重取节奏是 2500 根 / 60s，不沿用 30s 全量重取', () => {
    // Given 五日级别的取数与轮询常量
    // Then 2500 根覆盖 5 个美股会话（5×390=1950），60s 慢于常规 30s
    expect(FIVE_DAY_KLINE_LIMIT).toBe(2500)
    expect(FIVE_DAY_RESYNC_MS).toBe(60_000)
  })

  it('用户切到五日级别时既有主图/副图指标照常可挂：该级别进入适用范围列表', () => {
    // Given 一个只在美股日 K 与五日级别应用的指标
    const scoped: IndicatorInstance = {
      id: 'ema', params: {},
      applyScope: { us: { enabled: true, intervals: ['1d', FIVE_DAY_INTERVAL] } },
    }

    // Then 适用范围面板把 '5d' 列进美股级别集，'5d' 命中该指标而 '1w' 不命中
    expect(supportedIntervals('us', 'yahoo')).toContain(FIVE_DAY_INTERVAL)
    expect(selectApplicableInstances([scoped], 'us', FIVE_DAY_INTERVAL)).toEqual([scoped])
    expect(selectApplicableInstances([scoped], 'us', '1w')).toEqual([])
  })

  it('用户切到十日级别或别的市场再回来时，五日级别的记忆读回按市场族接受', () => {
    // Given 记忆里存的是 '5d'
    // Then 可能可得的三市场接受读回，其余市场与未知 id 一律拒绝
    expect(rememberableInterval('us', FIVE_DAY_INTERVAL)).toBe(true)
    expect(rememberableInterval('cn', FIVE_DAY_INTERVAL)).toBe(true)
    expect(rememberableInterval('hk', FIVE_DAY_INTERVAL)).toBe(true)
    expect(rememberableInterval('crypto', FIVE_DAY_INTERVAL)).toBe(false)
    expect(rememberableInterval('futures', FIVE_DAY_INTERVAL)).toBe(false)
    expect(rememberableInterval('global', FIVE_DAY_INTERVAL)).toBe(false)
    expect(rememberableInterval('us', '10d')).toBe(false)
    expect(rememberableInterval('us', '1d')).toBe(true)
  })
})
