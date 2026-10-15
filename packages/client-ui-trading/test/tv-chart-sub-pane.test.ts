/**
 * 副图 pane 生命周期直测：序号（TvChart.subIndicatorPaneIndex）与占位 pane 的建立/撤下。
 *
 * 序号部分：成交量搬进指标名册（预置 `vol` 指标）后，图表不再有内置成交量 pane——
 * 第一个副图指标就落在 pane 1，取消勾选后剩余副图整体前移。legend overlay 定位与
 * 序列创建共用这一处序号来源，因此序号正确即 legend 落在对应 pane 顶缘。
 *
 * 占位部分：aux 副图取不到任何序列时，调度会给一个没有输出的空态组（见
 * indicator-dispatch）——库的 pane 由序列隐式创建，所以 TvChart 为该组建一条不承载
 * 任何数值的锚序列（从不 setData），并靠既有的序列 diff 让它在组消失时被撤下。
 * jsdom 无 canvas、createChart 不可用，这里用手写的最小图表契约假体重放
 * syncIndicators：假体只实现 addSeries/removeSeries，并照 lightweight-charts 的真实
 * 规则回收空 pane（_internal_removeSeries → _private__cleanupIfPaneIsEmpty）。
 */
import { describe, expect, it } from 'vitest'
import type { IChartApi, ISeriesApi, SeriesType, UTCTimestamp } from 'lightweight-charts'
import type { IndicatorOutput } from '@dshtrading/indicators'
import * as tvChartModule from '../src/client/TvChart.tsx'
import { isPlaceholderGroup, subIndicatorPaneIndex, syncIndicators } from '../src/client/TvChart.tsx'
import type { TvIndicatorGroup } from '../src/client/TvChart.tsx'

describe('副图 pane 序号', () => {
  it('用户看到的第一个副图指标占据 pane 1（图表不再为成交量预留 pane）', () => {
    // Given 图表 pane 0 = 蜡烛 + 主图叠加，副图指标按激活顺序排列
    // When 取前四个副图指标的 pane 序号
    const panes = [0, 1, 2, 3].map(subIndicatorPaneIndex)
    // Then 从 pane 1 起逐组递增，没有任何序号留给内置成交量
    expect(panes).toEqual([1, 2, 3, 4])
  })

  it('用户取消一个副图指标后，其余副图仍从 pane 1 连续编号', () => {
    // Given 三个副图指标（vol + 两个自定义）时的序号
    const withThree = [0, 1, 2].map(subIndicatorPaneIndex)
    // When 用户取消其中一个后只剩两个副图指标
    const withTwo = [0, 1].map(subIndicatorPaneIndex)
    // Then 序号仍从 pane 1 连续，末位副图从 pane 3 前移到 pane 2
    expect(withThree).toEqual([1, 2, 3])
    expect(withTwo).toEqual([1, 2])
    expect(withTwo[1]).toBeLessThan(withThree[2] as number)
  })

  it('用户侧图表不再暴露内置成交量的构造入口（成交量改由 vol 指标渲染）', () => {
    // Given TvChart 模块对外的导出面
    const exported = Object.keys(tvChartModule)
    // When 在其中查找旧的成交量构造入口 toVolume
    const legacyEntry = exported.filter(name => name === 'toVolume')
    // Then 该入口已随内置成交量 pane 一起删除，副图序号函数成为唯一序号来源
    expect(legacyEntry).toEqual([])
    expect(exported).toContain('subIndicatorPaneIndex')
  })
})

/* ── 占位 pane：最小图表契约假体 ───────────────────────────────── */

/** 假体系列的记账：落到哪个 pane、收到过哪些数据写入（锚序列必须一条都没有）。 */
interface FakeSeriesRecord {
  pane: number
  options: Record<string, unknown>
  dataWrites: unknown[]
}

interface FakeChart {
  chart: IChartApi
  /** 当前 pane 栈长度（含 pane 0）。 */
  paneCount(): number
  /** 按建立顺序记录的序列（pane + 选项 + 数据写入）。 */
  created: FakeSeriesRecord[]
  /** 已撤下的序列记录（引用相等）。 */
  removed: FakeSeriesRecord[]
}

/**
 * 手写最小图表契约假体（不含任何通用 mock 工具）：只实现 syncIndicators 用到的
 * addSeries/removeSeries，并按 lightweight-charts 的真实语义回收 pane——
 * `_internal_removeSeries` 末尾调用 `_private__cleanupIfPaneIsEmpty`：某个 pane 的数据源
 * 清空且 pane 栈长度 > 1 时，该 pane 从栈里移除（库文件 lightweight-charts.development.mjs）。
 */
function createFakeChart(): FakeChart {
  const panes: Array<Array<{ record: FakeSeriesRecord; api: ISeriesApi<SeriesType> }>> = [[]]
  const created: FakeSeriesRecord[] = []
  const removed: FakeSeriesRecord[] = []
  const chart = {
    addSeries: (_definition: unknown, options: Record<string, unknown> = {}, paneIndex = 0): ISeriesApi<SeriesType> => {
      while (panes.length <= paneIndex) panes.push([])
      const record: FakeSeriesRecord = { pane: paneIndex, options, dataWrites: [] }
      const api = {
        applyOptions: (next: Record<string, unknown>): void => { record.options = { ...record.options, ...next } },
        options: (): Record<string, unknown> => ({ ...record.options }),
        setData: (data: unknown[]): void => { record.dataWrites.push(data) },
      } as unknown as ISeriesApi<SeriesType>
      panes[paneIndex]?.push({ record, api })
      created.push(record)
      return api
    },
    removeSeries: (series: ISeriesApi<SeriesType>): void => {
      for (const bucket of panes) {
        const at = bucket.findIndex(entry => entry.api === series)
        if (at < 0) continue
        removed.push(bucket[at]!.record)
        bucket.splice(at, 1)
        if (panes.length > 1 && bucket.length === 0) panes.splice(panes.indexOf(bucket), 1)
        return
      }
    },
  }
  return { chart: chart as unknown as IChartApi, paneCount: () => panes.length, created, removed }
}

const TIME_AXIS = [1_700_000_000, 1_700_086_400, 1_700_172_800] as UTCTimestamp[]

/** 有数据的一条副图组（真实输出形状：单条线，三根 bar 都有值）。 */
function dataGroup(key: string): TvIndicatorGroup {
  const output: IndicatorOutput = { key: 'HK_CONNECT_HOLDING', kind: 'line', color: '#7c5cff', values: [11.9, 12.5, 12.5], precision: 2 }
  return { key, title: '港股通持股比例', outputs: [output] }
}

/** 空态占位组（dispatch 在「每个声明键都没有非空序列」时给出的形态：outputs 恒为空）。 */
function placeholderGroup(key: string): TvIndicatorGroup {
  return { key, title: '港股通持股比例', outputs: [], emptyNotice: '该标的无港股通持股记录（不在港股通范围，或未采集/取数失败）' }
}

/** 一次同步：refs 跨调用保持（对应组件里的 subRefs.current）。 */
function sync(chart: IChartApi, refs: Map<string, Map<string, ISeriesApi<SeriesType>>>, groups: readonly TvIndicatorGroup[]): void {
  syncIndicators(chart, refs, groups, TIME_AXIS, true, subIndicatorPaneIndex(0), false)
}

describe('占位 pane 的建立与撤下', () => {
  it('用户在有数据副图之外看到的空态副图，pane 建立但一条数据都没写进去', () => {
    // Given 一个空态占位组
    const fake = createFakeChart()
    const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()

    // When 同步一次
    sync(fake.chart, refs, [placeholderGroup('a:')])

    // Then pane 栈从 1 涨到 2（占位 pane 存在），而锚序列从未收到任何数据写入
    expect(fake.paneCount()).toBe(2)
    expect(fake.created).toHaveLength(1)
    expect(fake.created[0]?.pane).toBe(subIndicatorPaneIndex(0))
    expect(fake.created[0]?.dataWrites).toEqual([])
  })

  it('用户取消勾选该指标后，占位 pane 随锚序列一起被撤下', () => {
    // Given 已建立占位 pane 的图表
    const fake = createFakeChart()
    const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()
    sync(fake.chart, refs, [placeholderGroup('a:')])

    // When 分组列表里不再有该组（取消勾选 / 实例被摘）
    sync(fake.chart, refs, [])

    // Then 锚序列被撤下，空 pane 被库式规则回收，pane 栈回到只有主图
    expect(fake.paneCount()).toBe(1)
    expect(fake.removed).toHaveLength(1)
  })

  it('用户从 A 股切到港股时，旧市场的占位组与新市场的占位组不共享 pane', () => {
    // Given 先建立 cn 主动买盘的占位 pane
    const fake = createFakeChart()
    const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()
    sync(fake.chart, refs, [placeholderGroup('active-buy:')])

    // When 切市场后分组 key 换成港股通持股（换标的同理：key 含标的）
    sync(fake.chart, refs, [placeholderGroup('hk-connect-holding:')])

    // Then 旧锚序列被撤、新锚序列建立，pane 数仍是 2（不会叠加出第三个空 pane）
    expect(fake.paneCount()).toBe(2)
    expect(fake.removed).toHaveLength(1)
    expect(fake.created).toHaveLength(2)
    expect(fake.created[1]?.dataWrites).toEqual([])
  })

  it('用户同时看有数据副图与空态副图时，两者按激活顺序各占一个 pane 序号', () => {
    // Given 一个有数据组在前、一个占位组在后
    const fake = createFakeChart()
    const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()

    // When 同步一次
    sync(fake.chart, refs, [dataGroup('vol:'), placeholderGroup('holding:')])

    // Then 有数据组落在 pane 1、占位组落在 pane 2：占位不挤占真实组的序号
    expect(fake.created.map(record => record.pane)).toEqual([subIndicatorPaneIndex(0), subIndicatorPaneIndex(1)])
    expect(fake.paneCount()).toBe(3)
  })

  it('用户取消勾选有数据的副图后，只剩的占位副图连同自身 pane 一起前移', () => {
    // Given 有数据组 + 占位组
    const fake = createFakeChart()
    const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()
    sync(fake.chart, refs, [dataGroup('vol:'), placeholderGroup('holding:')])

    // When 取消勾选有数据的那个
    sync(fake.chart, refs, [placeholderGroup('holding:')])

    // Then 占位组重新落在 pane 1，pane 栈只剩主图 + 占位
    const last = fake.created[fake.created.length - 1]
    expect(last?.pane).toBe(subIndicatorPaneIndex(0))
    expect(fake.paneCount()).toBe(2)
  })
})

describe('占位组判据', () => {
  it('用户看到的空态组只有「带空态文案且没有输出」这一种形态', () => {
    // Given 三种组：纯占位、带文案但有输出、无文案且无输出
    // When 逐个判定
    // Then 只有第一种算占位（有输出就不是占位，没文案的空组不是空态机制）
    const cases: Array<[TvIndicatorGroup, boolean]> = [
      [placeholderGroup('a:'), true],
      [{ key: 'b:', outputs: dataGroup('b:').outputs, emptyNotice: '文案' }, false],
      [{ key: 'c:', outputs: [] }, false],
    ]
    expect(cases.map(([group]) => isPlaceholderGroup(group))).toEqual(cases.map(([, expected]) => expected))
  })
})

