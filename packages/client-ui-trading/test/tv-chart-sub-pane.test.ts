/**
 * 副图 pane 序号直测（TvChart.subIndicatorPaneIndex）：成交量搬进指标名册（预置
 * `vol` 指标）后，图表不再有内置成交量 pane——第一个副图指标就落在 pane 1，取消
 * 勾选后剩余副图整体前移。legend overlay 定位与序列创建共用这一处序号来源，因此
 * 序号正确即 legend 落在对应 pane 顶缘。
 *
 * 只调用纯序号函数并检查模块导出面，不挂载图表（jsdom 无 canvas，createChart 不可用）。
 */
import { describe, expect, it } from 'vitest'
import * as tvChartModule from '../src/client/TvChart.tsx'
import { subIndicatorPaneIndex } from '../src/client/TvChart.tsx'

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
