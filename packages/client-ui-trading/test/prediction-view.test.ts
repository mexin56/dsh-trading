/**
 * 预测市场面板纯判据单测（2026-10-11）：质量阈值、显示口径、健康检查、变动缺省
 * 语义、会话内采样与事件对齐。这些判据决定「什么算噪声、什么算信号」，必须能
 * 离线复算——上游实测分布见 spikes/impl-polymarket/（liquidityNum 87.9k–956k、
 * spread 0.001–0.012）。
 *
 * 数值取 connector-live-ACCEPTANCE.md §5 的 December 会议真实读数，使断言对着
 * 真实上游数据而不是编造的样本。
 */
import { describe, expect, it } from 'vitest'
import type { ClientPredictionBucket, ClientPredictionMeeting } from '../src/client/api.ts'
import {
  MAX_SAMPLES,
  MIN_LIQUIDITY_USD,
  appendSample,
  displayProbabilityOf,
  formatDeltaPp,
  formatProbability,
  inflationEventsOf,
  largestMovementAround,
  meetingViewOf,
  movementAround,
  nextMeetingOf,
  probabilityBasisOf,
  qualityMarksOf,
  sumHealthOf,
  visibleMeetingsOf,
  VISIBLE_MEETINGS,
  type ProbabilitySample,
} from '../src/client/prediction-view.ts'

/** 档位构造（只给判据关心的字段，其余按真实读数给稳定默认）。 */
function bucket(over: Partial<ClientPredictionBucket> = {}): ClientPredictionBucket {
  return {
    key: 'no_change',
    label: 'No change',
    changeBps: 0,
    probability: 0.225,
    bestBid: 0.22,
    bestAsk: 0.23,
    spread: 0.01,
    liquidity: 213712.9581,
    acceptingOrders: true,
    closed: false,
    ...over,
  }
}

describe('质量标记（深度/价差是两个独立维度）', () => {
  it('用户看到深度达标的档位不带任何质量标记', () => {
    // Given 一个深度 213,712 美元、价差 0.01 的档位（December No change 的真实读数）
    const real = bucket()
    // When 计算质量标记
    const marks = qualityMarksOf(real)
    // Then 两项都达标 → 空数组（不标注）
    expect(marks).toEqual([])
  })

  it('用户看到深度低于阈值的档位被标注「深度不足」', () => {
    // Given 深度 87,901 美元的 January 尾部档位（实测最小值）
    const thin = bucket({ key: 'dec_25', liquidity: 87901.3664 })
    // When 计算质量标记
    const marks = qualityMarksOf(thin)
    // Then 只出 thin-depth 一枚（价差 0.01 仍达标）
    expect(marks).toEqual(['thin-depth'])
  })

  it('用户看到价差过宽的档位被标注「价差过宽」而不是混成一个词', () => {
    // Given 深度充足但价差 0.03 的档位（高于实测最大 0.012）
    const wide = bucket({ spread: 0.03, liquidity: 500_000 })
    // When 计算质量标记
    const marks = qualityMarksOf(wide)
    // Then 只出 wide-spread（深度达标），与 thin-depth 可区分
    expect(marks).toEqual(['wide-spread'])
  })

  it('用户看到深度与价差同时不达标的档位带两枚标记', () => {
    // Given 深度与价差双双不达标
    const bad = bucket({ liquidity: 1000, spread: 0.05 })
    // When 计算质量标记
    const marks = qualityMarksOf(bad)
    // Then 两枚标记都在
    expect(marks).toEqual(['thin-depth', 'wide-spread'])
  })

  it('用户看到上游未给深度/价差的档位不被误标（不知道不等于不达标）', () => {
    // Given 上游缺 liquidity 与 spread（结算后实测形态）
    const unknown = bucket({ liquidity: undefined, spread: undefined })
    // When 计算质量标记
    const marks = qualityMarksOf(unknown)
    // Then 无标记——缺字段不是「不达标」，不该画成噪声
    expect(marks).toEqual([])
  })

  it('用户看到阈值边界上的档位按 >= / <= 侧判达标', () => {
    // Given 深度恰好等于下限、价差恰好等于上限
    const edge = bucket({ liquidity: MIN_LIQUIDITY_USD, spread: 0.02 })
    // When 计算质量标记
    const marks = qualityMarksOf(edge)
    // Then 边界值算达标（严格小于/大于才标注）
    expect(marks).toEqual([])
  })
})

describe('显示口径（与 Polymarket 网页一致）', () => {
  it('用户看到的概率等于上游 bestAsk 而不是 mid', () => {
    // Given December No change 档：mid 0.225、网页显示 0.23
    const real = bucket()
    // When 取显示概率与基准
    const shown = displayProbabilityOf(real)
    const basis = probabilityBasisOf(real)
    // Then 显示值取 ask（与网页逐值一致），基准标为 ask
    expect(shown).toBe(0.23)
    expect(basis).toBe('ask')
  })

  it('用户看到结算后 bestAsk 缺失的档位回落到 mid 并标注基准', () => {
    // Given 结算后 bestAsk 缺省（上游为 null）
    const settled = bucket({ bestAsk: undefined, probability: 0.0035 })
    // When 取显示概率与基准
    const shown = displayProbabilityOf(settled)
    const basis = probabilityBasisOf(settled)
    // Then 回落 mid，且基准如实标为 mid（不静默换口径）
    expect(shown).toBe(0.0035)
    expect(basis).toBe('mid')
  })

  it('用户看到的概率按百分比一位小数渲染', () => {
    // Given 一个 mid 为 0.0295 的档位（实测 50+ bps increase 档）
    // When 格式化
    const text = formatProbability(0.0295)
    // Then 一位小数百分比（0.0295*100 = 2.9499… 按 toFixed 截到 2.9）
    expect(text).toBe('2.9%')
  })
})

describe('变动缺省语义（不知道不等于没变）', () => {
  it('用户看到快照不足的档位不显示变动而不是显示 0', () => {
    // Given 首次采样（changeSincePrevious 缺省）
    // When 格式化变动
    const text = formatDeltaPp(undefined)
    // Then 返回 undefined（渲染层整块不画），绝不是 '+0.0pp'
    expect(text).toBeUndefined()
  })

  it('用户看到确知没变的档位显示 0 变动', () => {
    // Given 快照对比确知无变化（delta = 0）
    // When 格式化变动
    const text = formatDeltaPp(0)
    // Then 显示 0.0pp——与「不知道」（undefined，整块不画）在渲染上可区分
    expect(text).toBe('0.0pp')
  })

  it('用户看到概率上升与下降的变动带符号与百分点单位', () => {
    // Given CPI 公布后 No change 档下移 4 个百分点、25 bps increase 上移 4 个
    // When 分别格式化
    const down = formatDeltaPp(-0.04)
    const up = formatDeltaPp(0.04)
    // Then 两个方向都带符号，单位是 pp（不是概率原值）
    expect(down).toBe('-4.0pp')
    expect(up).toBe('+4.0pp')
  })
})

describe('健康检查（概率和越界只提示不改写）', () => {
  it('用户看到概率和在正常区间的会议不带提示', () => {
    // Given 实测正常区间 [0.98, 1.03] 内的和
    // When 判健康
    // Then 正常区间内的两端都算 ok
    expect(sumHealthOf(0.98)).toBe('ok')
    expect(sumHealthOf(1.03)).toBe('ok')
    expect(sumHealthOf(1.004)).toBe('ok')
  })

  it('用户看到概率和偏离 1 的会议收到可见提示', () => {
    // Given 越界和（低于下界与高于上界）
    // When 判健康
    // Then 两侧都报 off-band，不静默
    expect(sumHealthOf(0.97)).toBe('off-band')
    expect(sumHealthOf(1.04)).toBe('off-band')
  })
})

describe('会议视图模型', () => {
  it('用户看到的会议室取第一场未结算的会议', () => {
    // Given 三场会议，前两场已结算
    const meetings = [
      { ...meeting('1', true) },
      { ...meeting('2', true) },
      { ...meeting('3', false) },
    ]
    // When 取下一场
    const next = nextMeetingOf(meetings)
    // Then 命中第一场未结算的（id 3）
    expect(next?.id).toBe('3')
  })

  it('用户看到全部会议都已结算时不假装还有下一场', () => {
    // Given 三场会议全部已结算
    const meetings = [meeting('1', true), meeting('2', true)]
    // When 取下一场
    const next = nextMeetingOf(meetings)
    // Then undefined（面板显示已结算态）
    expect(next).toBeUndefined()
  })

  it('用户看到后续会议一并上屏（低深度形态常出现在更远的会议）', () => {
    // Given 三场未结算会议
    const meetings = [meeting('1', false), meeting('2', false), meeting('3', false)]
    // When 取上屏会议组
    const shown = visibleMeetingsOf(meetings)
    // Then 三场都在，且保持上游顺序
    expect(shown.map((item) => item.id)).toEqual(['1', '2', '3'])
  })

  it('用户看到已结算会议被挤出上屏会议组', () => {
    // Given 一场已结算会议排在前面、两场未结算在后面
    const meetings = [meeting('1', true), meeting('2', false), meeting('3', false)]
    // When 取上屏会议组
    const shown = visibleMeetingsOf(meetings)
    // Then 只剩未结算的两场
    expect(shown.map((item) => item.id)).toEqual(['2', '3'])
  })

  it('用户看到上屏会议数被封顶而不是把全部会议铺开', () => {
    // Given 五场未结算会议
    const meetings = ['1', '2', '3', '4', '5'].map((id) => meeting(id, false))
    // When 取上屏会议组
    const shown = visibleMeetingsOf(meetings)
    // Then 恰好取到上限场
    expect(shown.length).toBe(VISIBLE_MEETINGS)
    expect(shown.map((item) => item.id)).toEqual(['1', '2', '3'])
  })

  it('用户看到档位行同时带上显示概率、方向与质量标记', () => {
    // Given 一场含低深度档位的会议
    const view = meetingViewOf(meeting('606422', false, [
      bucket({ key: 'no_change', label: 'No change', changeBps: 0 }),
      bucket({ key: 'dec_25', label: '25 bps decrease', changeBps: -25, liquidity: 1000 }),
    ]))
    // When 读档位行
    const [hold, cut] = view.buckets
    // Then 标签用上游原义、方向带 bps、低深度档位带标记
    expect(view.buckets.length).toBe(2)
    expect(hold?.label).toBe('No change')
    expect(hold?.changeBps).toBe(0)
    expect(hold?.marks).toEqual([])
    expect(cut?.label).toBe('25 bps decrease')
    expect(cut?.changeBps).toBe(-25)
    expect(cut?.marks).toEqual(['thin-depth'])
  })
})

/** 会议构造（只给判据关心的字段）。 */
function meeting(id: string, closed: boolean, buckets: ClientPredictionBucket[] = [bucket()]): ClientPredictionMeeting {
  return {
    id,
    slug: `slug-${id}`,
    title: `Fed Decision ${id}`,
    endDate: '2026-12-10T04:59:00Z',
    meetingWindow: 'December 8-9, 2026',
    closed,
    buckets,
    probabilitySum: 1.004,
    degraded: [],
  }
}

/** 采样构造。 */
function sample(at: number, values: Record<string, number>): ProbabilitySample {
  return { at, values }
}

describe('会话内采样与事件对照', () => {
  it('用户看到的采样序列在超出上限时保留最新的那些', () => {
    // Given 已积满上限的采样序列
    let samples: readonly ProbabilitySample[] = []
    for (let i = 0; i < MAX_SAMPLES; i += 1) samples = appendSample(samples, sample(i, { no_change: 0.5 }))
    // When 追加第 MAX_SAMPLES+1 条
    const next = appendSample(samples, sample(MAX_SAMPLES, { no_change: 0.6 }))
    // Then 长度封顶、首条被挤出、末条是最新
    expect(next.length).toBe(MAX_SAMPLES)
    expect(next[next.length - 1]?.at).toBe(MAX_SAMPLES)
    expect(next[0]?.at).toBe(1)
  })

  it('用户看到事件两侧都有采样时读出跨事件的概率位移', () => {
    // Given CPI 公布时点前后各有一次采样（0.23 → 0.27）
    const samples = [sample(1000, { no_change: 0.23 }), sample(3000, { no_change: 0.27 })]
    // When 取跨 2000 时刻的位移
    const moved = movementAround(samples, 2000, 'no_change')
    // Then 前后值与差值都可用
    expect(moved).toEqual({ before: 0.23, beforeAt: 1000, after: 0.27, afterAt: 3000, delta: 0.27 - 0.23 })
  })

  it('用户看到事件只有单侧采样时得到「采样不足」而不是 0 变动', () => {
    // Given 事件之后才开始采样（只有 after 一侧）
    const samples = [sample(3000, { no_change: 0.27 })]
    // When 取跨 2000 时刻的位移
    const moved = movementAround(samples, 2000, 'no_change')
    // Then undefined——面板显示「采样不足，不显示变动」
    expect(moved).toBeUndefined()
  })

  it('用户看到跨事件位移最大的档位被选为对照主行', () => {
    // Given 事件前后两档位，其中 dec_25 位移更大
    const samples = [
      sample(1000, { no_change: 0.72, dec_25: 0.15 }),
      sample(3000, { no_change: 0.68, dec_25: 0.24 }),
    ]
    // When 选位移最大的档位
    const hit = largestMovementAround(samples, 2000, ['no_change', 'dec_25'])
    // Then 命中 dec_25 及其位移
    expect(hit?.key).toBe('dec_25')
    expect(hit?.movement.delta).toBeCloseTo(0.09, 10)
  })

  it('用户看到全部档位都无法对照时对照主行为空', () => {
    // Given 空采样序列
    // When 选位移最大的档位
    const hit = largestMovementAround([], 2000, ['no_change'])
    // Then undefined
    expect(hit).toBeUndefined()
  })

  it('用户看到只有美国 CPI/PPI 条目被取为事件时点且按时间升序', () => {
    // Given 一批日历条目：含美国 CPI/PPI、非美国 CPI、与美国非通胀条目
    const events = inflationEventsOf([
      { publishedAt: '2026-10-15T12:30:00Z', title: '美国10月CPI年率', region: '美国' }, // i18n-allow: 上游数据词汇
      { publishedAt: '2026-10-10T12:30:00Z', title: '美国10月PPI年率', region: '美国' }, // i18n-allow: 上游数据词汇
      { publishedAt: '2026-10-14T12:30:00Z', title: '德国10月CPI年率', region: '德国' }, // i18n-allow: 上游数据词汇
      { publishedAt: '2026-10-13T12:30:00Z', title: '美国10月非农就业人口', region: '美国' }, // i18n-allow: 上游数据词汇
    ])
    // When 读事件时点
    // Then 只剩两条美国通胀条目，且按时间升序
    expect(events.length).toBe(2)
    expect(events.map((event) => event.title)).toEqual(['美国10月PPI年率', '美国10月CPI年率'])
    expect(events[0]!.at).toBeLessThan(events[1]!.at)
  })

  it('用户看到公布时刻无法解析的日历条目不进入事件对照', () => {
    // Given 一条 publishedAt 非法的美国 CPI 条目
    const events = inflationEventsOf([{ publishedAt: 'not-a-date', title: '美国10月CPI年率', region: '美国' }]) // i18n-allow: 上游数据词汇
    // When 读事件时点
    // Then 丢弃该行（不猜时间）
    expect(events).toEqual([])
  })
})
