/**
 * 指标外部序列客户端接线的纯逻辑用例（契约 §5，决策 3/5）：
 * holdRatio 口径、空序列 ≠ 0 的就绪判定、按 markets 白名单收集需取数的键、
 * 注入式取数缝、换标的时在途旧应答丢弃。
 *
 * 取数缝以真实函数注入（不引入通用 mock 工具）：注入的「桥」是一个真函数，
 * 返回值就是真实形状的 SouthboundHoldingHistory。
 */
import { describe, expect, it } from 'vitest'
import type { IndicatorDefinition } from '@dshtrading/indicators'
import { presetDefinitions } from '@dshtrading/indicators'
import type { SouthboundHoldingHistory } from '@dshtrading/api'
import {
  CN_ACTIVE_BUY_KEY,
  HK_CONNECT_HOLDING_KEY,
  auxEmptyNoticeKey,
  auxSeriesReady,
  createAuxRequestGuard,
  loadAuxSeries,
  requiredAuxKeys,
  southboundHoldingsToAuxPoints,
} from '../src/client/aux-series.ts'

const DAY = 86_400_000
const HOLDING_ID = 'hk-connect-holding'

/** 真实预置名册里查 definition（不手写假体，口径与预置 definition 同源）。 */
function definitionOf(id: string): IndicatorDefinition | undefined {
  return presetDefinitions().find(entry => entry.id === id)
}

/** 桥的返回形状：holdShares/holdMarketCap 与 holdRatio 刻意取不同量级，便于验证口径。 */
function historyOf(ratios: number[]): SouthboundHoldingHistory {
  return {
    symbol: '00700.HK',
    points: ratios.map((holdRatio, index) => ({
      date: Date.UTC(2026, 9, 5 + index),
      holdRatio,
      holdShares: 1_234_567,
      holdMarketCap: 555_000_000,
    })),
  }
}

describe('指标外部序列接线', () => {
  it('用户看到港股通副图时，曲线取持股比例 holdRatio 而非持股数或市值', () => {
    // Given 桥回一段持股历史（比例 11.9 / 12.5，持股数与市值另为固定值）
    const history = historyOf([11.9, 12.5])

    // When 映射为外部序列
    const points = southboundHoldingsToAuxPoints(history)

    // Then 值与交易日逐条来自 holdRatio
    expect(points).toEqual([
      { date: Date.UTC(2026, 9, 5), value: 11.9 },
      { date: Date.UTC(2026, 9, 6), value: 12.5 },
    ])
  })

  it('用户遇到取数失败或标的不在港股通范围时，该指标视为未就绪而不是零线', () => {
    // Given 三种「没有数据」：桥失败（undefined）、空 points（非港股通标的）、空序列已注入
    const empty = historyOf([])

    // When 各自判定映射结果与就绪状态
    // Then 空 ≠ 0：映射结果一律 undefined，且声明了 aux 的 definition 判为未就绪
    expect(southboundHoldingsToAuxPoints(undefined)).toBeUndefined()
    expect(southboundHoldingsToAuxPoints(empty)).toBeUndefined()
    const definition = definitionOf(HOLDING_ID)
    if (definition === undefined) throw new Error('preset hk-connect-holding missing')
    expect(auxSeriesReady(definition, {})).toBe(false)
    expect(auxSeriesReady(definition, { [HK_CONNECT_HOLDING_KEY]: [] })).toBe(false)
    expect(auxSeriesReady(definition, { [HK_CONNECT_HOLDING_KEY]: [{ date: Date.UTC(2026, 9, 5), value: 11.9 }] })).toBe(true)
  })

  it('用户看到的空态理由按键位归属：两条已接线指标各有独立文案，未登记的键回落通用', () => {
    // Given 两个已接线的 aux 键与一个未登记的未来键
    // When 取各自的空态文案键位
    // Then 三条互不相同——hk 侧措辞不替「不在港股通范围」下结论（见词典原文的「或」）
    const noticeKeys = [
      auxEmptyNoticeKey(HK_CONNECT_HOLDING_KEY),
      auxEmptyNoticeKey(CN_ACTIVE_BUY_KEY),
      auxEmptyNoticeKey('some-future-key'),
    ]
    expect(noticeKeys).toEqual([
      'indicator.auxEmpty.hkConnectHolding',
      'indicator.auxEmpty.cnActiveBuy',
      'indicator.auxEmpty.generic',
    ])
    expect(new Set(noticeKeys).size).toBe(noticeKeys.length)
  })

  it('用户切到非港股市场时，宿主不请求港股通持股序列', () => {
    // Given 港股通持股比例已挂载，以及一个无 markets 限定的普通指标
    const instances = [{ id: HOLDING_ID, params: {} }, { id: 'ma', params: {} }]

    // When 分别按港股与非港股收集需取数的键
    const onHk = requiredAuxKeys(instances, 'hk', definitionOf)
    const onUs = requiredAuxKeys(instances, 'us', definitionOf)

    // Then 只有港股上需要取数，且只收集声明过的键（普通指标零收益）
    expect(onHk).toEqual([HK_CONNECT_HOLDING_KEY])
    expect(onUs).toEqual([])
  })

  it('用户挂载的指标未登记取数分支时，宿主不发出请求而是按无数据降级', async () => {
    // Given 一个已接线的键、一个未登记的键，以及真实的注入式取数实现
    let calls = 0
    const fetcher = async (): Promise<SouthboundHoldingHistory | undefined> => {
      calls += 1
      return historyOf([11.9])
    }

    // When 分别加载两个键
    const known = await loadAuxSeries(HK_CONNECT_HOLDING_KEY, 'hk', '00700.HK', fetcher)
    const unknown = await loadAuxSeries('some-future-key', 'hk', '00700.HK', fetcher)

    // Then 已接线的键拿到序列且只请求一次，未登记的键不发请求
    expect(known).toEqual([{ date: Date.UTC(2026, 9, 5), value: 11.9 }])
    expect(unknown).toBeUndefined()
    expect(calls).toBe(1)
  })

  it('用户在取数途中切换标的时，先发出的旧应答被丢弃', () => {
    // Given 两次连续发起的请求（旧标的 00700 → 新标的 00939）
    const guard = createAuxRequestGuard()
    const inFlight = guard.start('hk:00700.HK')

    // When 新请求开始后，旧请求的应答回来
    const latest = guard.start('hk:00939.HK')

    // Then 旧应答不再被认作当前（调用方据此丢弃），新请求是当前
    expect(inFlight.isCurrent()).toBe(false)
    expect(latest.isCurrent()).toBe(true)
  })

  it('用户等待期间取数缝抛错时，宿主按无数据降级而不是让整批序列失败', async () => {
    // Given 一个会抛错的取数缝（上游异常不得扩散到 Promise.all 的其它序列）
    const throwing = async (): Promise<SouthboundHoldingHistory | undefined> => { throw new Error('upstream down') }

    // When 加载该键
    const points = await loadAuxSeries(HK_CONNECT_HOLDING_KEY, 'hk', '00700.HK', throwing)

    // Then 该键按无数据处理，副图隐藏而非整图崩
    expect(points).toBeUndefined()
  })
})
