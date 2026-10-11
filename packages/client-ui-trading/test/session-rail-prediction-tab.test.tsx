/**
 * SessionRail 第 6 个页签（预测市场）的互斥联动冒烟（2026-10-11）：新页签必须与既有
 * 五者（定时任务/资产/快讯/宏观/文件）两两互斥，并且接进「新建会话先收起全部覆盖面」
 * 的 closeContainer——漏掉任一处都会让新面板继续盖住新容器或与对话列叠着显示。
 *
 * 断言走真实组件与真实面板容器 data 属性，不注入通用 mock：面板的数据面在 jsdom 里
 * 取数失败会各自落到错误态，但容器照常挂载/卸载，正是本用例要钉的语义。
 *
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { setHoldingsPanelOpen } from '../src/client/holdings-store.ts'
import { SessionRail } from '../src/client/SessionRail.tsx'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

interface Calls {
  startNewSession: number
  toggleFold: number
  collapseRightbar: number
  openFilesPanel: number
}

function renderRail(filesOpen = false): { calls: Calls; view: ReturnType<typeof render> } {
  const calls: Calls = { startNewSession: 0, toggleFold: 0, collapseRightbar: 0, openFilesPanel: 0 }
  const view = render(
    <SessionRail
      t={t}
      useFolded={<T,>(sel: (value: boolean) => T): T => sel(false)}
      useRightbar={<T,>(sel: (value: boolean) => T): T => sel(filesOpen)}
      startNewSession={() => { calls.startNewSession += 1 }}
      toggleFold={() => { calls.toggleFold += 1 }}
      openSession={() => {}}
      openFilesPanel={() => { calls.openFilesPanel += 1 }}
      collapseRightbar={() => { calls.collapseRightbar += 1 }}
    />,
  )
  return { calls, view }
}

/** 面板容器选择器（含预测市场新页签）。 */
const PANEL_SELECTORS: Record<string, string> = {
  tasks: '[data-dshtrading-tasks-panel]',
  holdings: '[data-dshtrading-holdings-panel]',
  flash: '[data-dshtrading-flash-panel]',
  macro: '[data-dshtrading-macro-panel]',
  prediction: '[data-dshtrading-polymarket-panel]',
}

/** 点击页签并等它的面板容器上屏。 */
async function openTab(view: { container: HTMLElement }, label: string, key: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: label }))
  await waitFor(() => { expect(view.container.querySelector(PANEL_SELECTORS[key]!)).not.toBeNull() })
}

describe('SessionRail 预测市场页签的互斥联动', () => {
  afterEach(() => { cleanup(); setHoldingsPanelOpen(false) })

  it('用户打开预测市场页签时既有的宏观面板让位', async () => {
    // Given 宏观面板已打开
    const { view } = renderRail()
    await openTab(view, 'stage.macro', 'macro')
    // When 打开预测市场页签
    await openTab(view, 'stage.prediction', 'prediction')
    // Then 预测市场在屏、宏观让位
    expect(view.container.querySelector(PANEL_SELECTORS.macro!)).toBeNull()
    expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).not.toBeNull()
  })

  it('用户打开预测市场页签时快讯面板让位', async () => {
    // Given 快讯面板已打开
    const { view } = renderRail()
    await openTab(view, 'stage.flash', 'flash')
    // When 打开预测市场页签
    await openTab(view, 'stage.prediction', 'prediction')
    // Then 快讯让位
    expect(view.container.querySelector(PANEL_SELECTORS.flash!)).toBeNull()
    expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).not.toBeNull()
  })

  it('用户打开预测市场页签时定时任务面板让位', async () => {
    // Given 定时任务面板已打开
    const { view } = renderRail()
    await openTab(view, 'tasks.open', 'tasks')
    // When 打开预测市场页签
    await openTab(view, 'stage.prediction', 'prediction')
    // Then 定时任务让位
    expect(view.container.querySelector(PANEL_SELECTORS.tasks!)).toBeNull()
  })

  it('用户打开预测市场页签时资产面板让位', async () => {
    // Given 资产面板已打开（含 QuoteStage 下单成功的跨树联动形态）
    const { view } = renderRail()
    await act(async () => { setHoldingsPanelOpen(true) })
    await waitFor(() => { expect(view.container.querySelector(PANEL_SELECTORS.holdings!)).not.toBeNull() })
    // When 打开预测市场页签
    await openTab(view, 'stage.prediction', 'prediction')
    // Then 资产面板让位
    expect(view.container.querySelector(PANEL_SELECTORS.holdings!)).toBeNull()
    expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).not.toBeNull()
  })

  it('用户打开宏观页签时预测市场面板让位（反方向互斥）', async () => {
    // Given 预测市场面板已打开
    const { view } = renderRail()
    await openTab(view, 'stage.prediction', 'prediction')
    // When 打开宏观页签
    await openTab(view, 'stage.macro', 'macro')
    // Then 预测市场让位
    expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).toBeNull()
    expect(view.container.querySelector(PANEL_SELECTORS.macro!)).not.toBeNull()
  })

  it('用户打开快讯页签时预测市场面板让位（反方向互斥）', async () => {
    // Given 预测市场面板已打开
    const { view } = renderRail()
    await openTab(view, 'stage.prediction', 'prediction')
    // When 打开快讯页签
    await openTab(view, 'stage.flash', 'flash')
    // Then 预测市场让位
    expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).toBeNull()
  })

  it('用户打开定时任务页签时预测市场面板让位（反方向互斥）', async () => {
    // Given 预测市场面板已打开
    const { view } = renderRail()
    await openTab(view, 'stage.prediction', 'prediction')
    // When 打开定时任务页签
    await openTab(view, 'tasks.open', 'tasks')
    // Then 预测市场让位
    expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).toBeNull()
  })

  it('用户打开资产面板时预测市场面板让位（外部联动路径）', async () => {
    // Given 预测市场面板已打开
    const { view } = renderRail()
    await openTab(view, 'stage.prediction', 'prediction')
    // When 资产面板被外部打开（QuoteStage 下单成功联动）
    await act(async () => { setHoldingsPanelOpen(true) })
    // Then 预测市场让位
    await waitFor(() => { expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).toBeNull() })
    expect(view.container.querySelector(PANEL_SELECTORS.holdings!)).not.toBeNull()
  })

  it('用户新建会话时预测市场面板也让位（不漏收新页签）', async () => {
    // Given 预测市场面板已打开
    const { calls, view } = renderRail()
    await openTab(view, 'stage.prediction', 'prediction')
    const collapsedBefore = calls.collapseRightbar
    // When 点击新建会话
    fireEvent.click(screen.getByRole('button', { name: 'entry.new' }))
    // Then 面板被收起、宿主右栏同步收起
    expect(calls.startNewSession).toBe(1)
    expect(calls.collapseRightbar).toBe(collapsedBefore + 1)
    await waitFor(() => { expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).toBeNull() })
  })

  it('用户打开预测市场页签时收起宿主右侧栏（与其余页签同款语义）', async () => {
    // Given 竖条初始态、宿主右侧栏未展开
    const { calls, view } = renderRail(false)
    // When 打开预测市场页签
    await openTab(view, 'stage.prediction', 'prediction')
    // Then 触发一次收起宿主右栏调用
    expect(calls.collapseRightbar).toBe(1)
  })

  it('用户看到预测市场页签按下态与 body 标记同步（shell-pad.css 规则 16 的锚点）', async () => {
    // Given 竖条初始态
    const { view } = renderRail()
    const button = screen.getByRole('button', { name: 'stage.prediction' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    // When 打开预测市场页签
    await openTab(view, 'stage.prediction', 'prediction')
    // Then aria-pressed 与 body 标记都翻到 on（规则 16 依此隐去对话列）
    expect(screen.getByRole('button', { name: 'stage.prediction' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.body.dataset.dshtradingPredictionOpen).toBe('on')
  })

  it('用户关闭预测市场页签后 body 标记归位', async () => {
    // Given 预测市场页签已打开
    const { view } = renderRail()
    await openTab(view, 'stage.prediction', 'prediction')
    // When 再点一次页签收起
    fireEvent.click(screen.getByRole('button', { name: 'stage.prediction' }))
    // Then 面板与 body 标记都归位
    await waitFor(() => { expect(view.container.querySelector(PANEL_SELECTORS.prediction!)).toBeNull() })
    expect(document.body.dataset.dshtradingPredictionOpen).toBe('off')
  })

  it('用户展开宿主文件页签时预测市场面板让位', async () => {
    // Given 预测市场面板已打开
    const { view } = renderRail()
    await openTab(view, 'stage.prediction', 'prediction')
    view.unmount()
    // When 宿主右侧栏以展开态挂载（宿主侧打开文件链接的镜像形态）
    const open = renderRail(true)
    // Then 预测市场面板不出现（filesOpen 的 effect 已收掉它）
    await waitFor(() => { expect(open.view.container.querySelector(PANEL_SELECTORS.prediction!)).toBeNull() })
  })
})
