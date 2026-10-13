import { describe, expect, it } from 'vitest'
import { createIndicatorRegistry } from '@dshtrading/indicators'
import { presetDefinitions } from '../../indicators/src/presets.ts'
import { activeBuyToAuxPoints, CN_ACTIVE_BUY_KEY, isCnPollingWindow, loadAuxSeries } from '../src/client/aux-series.ts'
import { dispatchIndicatorGroups } from '../src/client/indicator-dispatch.ts'
import type { ActiveBuyHistory } from '../src/client/api.ts'

const history: ActiveBuyHistory = { symbol: '002714.SZ', points: [{ date: '2026-10-13', buySharePct: 53.37, netSharePct: 6.73, phase: 'live', time: '09:53:03', source: 'live' }] }
const registry = createIndicatorRegistry()
for (const definition of presetDefinitions()) registry.register(definition)
const deps = { getDefinition: registry.get, clampParams: registry.clampParams, instanceKey: registry.instanceKey }
const bars = [{ openTime: Date.UTC(2026, 9, 13), closeTime: Date.UTC(2026, 9, 14) - 1, open: 10, high: 11, low: 9, close: 10, volume: 100 }]

describe('主动买盘外部序列', () => {
  it('用户仅在上海工作日的竞价、交易与收尾窗口刷新主动买盘', () => {
    // Given 固定上海时间，运行机器时区不影响输入
    const cases: Array<[string, boolean]> = [
      ['2026-10-13T09:24:00+08:00', false], ['2026-10-13T09:25:00+08:00', true],
      ['2026-10-13T11:32:59+08:00', true], ['2026-10-13T11:33:00+08:00', false],
      ['2026-10-13T12:57:59+08:00', false], ['2026-10-13T12:58:00+08:00', true],
      ['2026-10-13T15:02:59+08:00', true], ['2026-10-13T15:03:00+08:00', false],
      ['2026-10-17T10:00:00+08:00', false], ['2026-10-18T10:00:00+08:00', false],
    ]
    // When 判断各时点是否允许复取
    const actual = cases.map(([date]) => isCnPollingWindow(Date.parse(date)))
    // Then 两段窗口含起止分钟，周末关闭
    expect(actual).toEqual(cases.map(([, expected]) => expected))
  })

  it('用户看到的主动买盘日值取净主动占比并按 UTC 零点对齐', () => {
    // Given 桥同时返回买占比和净主动占比
    // When 投影为指标序列
    const points = activeBuyToAuxPoints(history)
    // Then 绝不把买占比误画成净主动占比
    expect(points).toEqual([{ date: Date.UTC(2026, 9, 13), value: 6.73 }])
    expect(activeBuyToAuxPoints({ symbol: '002714.SZ', points: [] })).toBeUndefined()
    expect(activeBuyToAuxPoints(undefined)).toBeUndefined()
  })

  it('用户未取得主动买盘数据时隐藏副图而不是画零线', async () => {
    // Given 注入的桥失败与合法空序列
    const failing = async (): Promise<ActiveBuyHistory> => { throw new Error('bridge unavailable') }
    const empty = async (): Promise<ActiveBuyHistory> => ({ symbol: '002714.SZ', points: [] })
    // When 取数后进入实际调度
    const failed = await loadAuxSeries(CN_ACTIVE_BUY_KEY, 'cn', '002714.SZ', async () => undefined, failing)
    const absent = await loadAuxSeries(CN_ACTIVE_BUY_KEY, 'cn', '002714.SZ', async () => undefined, empty)
    // Then 两者都无可画数据，实例整体不进调度
    expect([failed, absent]).toEqual([undefined, undefined])
    expect(dispatchIndicatorGroups({ klines: bars, instances: [{ id: 'active-buy', params: {} }], market: 'cn', aux: {}, deps })).toEqual([])
    expect(dispatchIndicatorGroups({ klines: bars, instances: [{ id: 'active-buy', params: {} }], market: 'cn', aux: { [CN_ACTIVE_BUY_KEY]: [] }, deps })).toEqual([])
  })

  it('用户只有在已声明 aux 键含 live 点时得到盘中状态', () => {
    // Given 真实预置主动买盘与有效序列
    const input = { klines: bars, instances: [{ id: 'active-buy', params: {} }], market: 'cn', aux: { [CN_ACTIVE_BUY_KEY]: activeBuyToAuxPoints(history)! }, deps }
    // When 分别注入命中、未命中与缺席的 live 键
    const live = dispatchIndicatorGroups({ ...input, liveKeys: [CN_ACTIVE_BUY_KEY] })
    const close = dispatchIndicatorGroups({ ...input, liveKeys: ['hk-connect-holding'] })
    const unknown = dispatchIndicatorGroups(input)
    // Then live 属性仅由命中的数据键决定
    expect(live.map(group => group.live)).toEqual([true])
    expect(close.map(group => Object.hasOwn(group, 'live'))).toEqual([false])
    expect(unknown.map(group => Object.hasOwn(group, 'live'))).toEqual([false])
  })
})
