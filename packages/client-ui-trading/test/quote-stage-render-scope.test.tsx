/**
 * 渲染作用域回归：1 Hz 状态栏时钟与无关的工具栏状态变化只应重渲染受影响节点，
 * 不得把整棵 QuoteStage 子树（最贵的子组件是 TvChart）拖进重渲染。
 *
 * 探针：TvChart 以 memo 包裹的计数桩替代（与真实导出一致），断言图表渲染次数增量。
 * memo 桩同时把「传给图表的 props 必须引用稳定」变成可回归的契约，并顺带钉住
 * 副图组到图表的最后一段接线（占位组的空态文案在 QuoteStage 里落地）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { presetDefinitions } from '@dshtrading/indicators'
import type { SelectionState } from '../src/client/store.ts'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { indicators } from '../src/client/indicator-registry.ts'

const counters = vi.hoisted(() => ({
  chart: 0,
  sub: undefined as readonly { key: string; outputs: readonly unknown[]; emptyNotice?: string }[] | undefined,
}))

vi.mock('../src/client/TvChart.tsx', async () => {
  const React = await import('react')
  return {
    TvChart: React.memo(function MockTvChart(props: { subIndicators?: readonly { key: string; outputs: readonly unknown[]; emptyNotice?: string }[] }) {
      counters.chart += 1
      counters.sub = props.subIndicators
      return null
    }),
    toBar: (k: unknown) => k,
  }
})

import { QuoteStage } from '../src/client/QuoteStage.tsx'

const t = (key: MarketLocaleKey): string => key

const KLINE = { openTime: 1, open: 1, high: 1.1, low: 0.9, close: 1, volume: 10, closeTime: 2 }
const KLINE2 = { openTime: 3, open: 1, high: 1.2, low: 1, close: 1.1, volume: 12, closeTime: 4 }
const ACTIVE_BUY_POINT = { date: '1970-01-01', buySharePct: 52, netSharePct: 4, phase: 'close', time: '15:05:00', source: 'close' }

/** 主动买盘端点的返回点（空表 = 该标的没有采集记录）。用例只改这个变量，不新增桩调用。 */
let activeBuyPoints: Array<Record<string, unknown>> = []

function props(symbol = 'HYPEUSDT', market: 'crypto' | 'cn' = 'crypto', instances: ChartState['instances'] = []) {
  const selection: SelectionState = { instrument: { market, symbol } }
  const chart: ChartState = { instances }
  return {
    t,
    useSelection: <T,>(sel: (state: SelectionState) => T): T => sel(selection),
    useChart: <T,>(sel: (state: ChartState) => T): T => sel(chart),
    toggleIndicator: () => {},
    setIndicatorParams: () => {},
    setIndicatorVisible: () => {},
    setIndicatorScope: () => {},
    removeIndicator: () => {},
    deleteIndicator: async () => true,
  }
}

beforeEach(() => {
  counters.chart = 0
  counters.sub = undefined
  activeBuyPoints = []
  // 客户端注册表在插件缺席时为空：按插件的注册路径装载预置定义。
  for (const definition of presetDefinitions()) indicators.register(definition)
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.includes('/klines?')) {
      return new Response(JSON.stringify({ klines: [KLINE, KLINE2] }), { status: 200 })
    }
    if (target.includes('/active-buy?')) {
      return new Response(JSON.stringify({ ok: true, symbol: '600519.SH', points: activeBuyPoints }), { status: 200 })
    }
    return new Response('{}', { status: 500 })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount() {
  const view = render(<QuoteStage {...props()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(counters.chart).toBeGreaterThanOrEqual(1)
  return view
}

describe('QuoteStage 渲染作用域', () => {
  it('状态栏秒级时钟推进 3 秒不重渲染图表', async () => {
    await mount()
    const before = counters.chart
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(counters.chart - before).toBe(0)
  })

  it('无关的工具栏状态变化（技术指标选择器开合）不重渲染图表', async () => {
    const view = await mount()
    const before = counters.chart
    fireEvent.click(view.getByText('indicator.picker'))
    expect(counters.chart - before).toBe(0)
  })

  it('图表真正消费的 props 变化仍然重渲染（memo 不吞更新）', async () => {
    const view = await mount()
    const before = counters.chart
    view.rerender(<QuoteStage {...props('BTCUSDT')} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(counters.chart - before).toBeGreaterThanOrEqual(1)
  })

  it('用户挂载的主动买盘取不到任何序列时，图表收到的是零输出的占位副图组加上该指标自己的空态文案', async () => {
    // Given A 股标的 + 已挂载主动买盘，K 线正常返回而外部序列是空表（取不到的形态之一）
    const view = render(<QuoteStage {...props('600519.SH', 'cn', [{ id: 'active-buy', params: {} }])} />)

    // When 等首帧取数结算并读图表实际收到的副图组
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // Then 恰好一组占位副图：没有输出、文案落在主动买盘那条词典键上（不是通用文案）
    expect(counters.sub).toEqual([{
      key: 'active-buy:',
      title: '主动买盘',
      outputs: [],
      emptyNotice: 'indicator.auxEmpty.cnActiveBuy',
    }])
    expect(view.container.textContent).not.toContain('NaN')
  })

  it('用户挂载的主动买盘取到序列时，图表收到的副图组不带任何空态文案（零回归）', async () => {
    // Given 同一 A 股标的与实例，外部序列返回一个真实点
    activeBuyPoints = [ACTIVE_BUY_POINT]
    render(<QuoteStage {...props('600519.SH', 'cn', [{ id: 'active-buy', params: {} }])} />)

    // When 等首帧取数结算并读图表实际收到的副图组
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // Then 有数据的那一组照旧只有渲染输入三件套，没有空态字段（占位机制对数据组零侵入）
    expect(counters.sub?.map(group => Object.keys(group).sort())).toEqual([['key', 'outputs', 'title']])
    expect(counters.sub?.[0]?.outputs).toHaveLength(2)
  })
})
