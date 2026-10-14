/**
 * 指标选择器内的自定义指标加载失败提示（2026-10-14 KDAS「自建指标不见了」）：
 * 失败必须在选择器里可见（一行提示 + 「重试」按钮），重试成功后提示消失；
 * 校验类失败只给提示、不给重试按钮（重拉不会变好）。
 *
 * 用例 mount 的是真组件（IndicatorPicker），失败态经 useSyncExternalStore 从加载
 * 器的模块级可观测状态读出——与生产接线同一份状态，不另立测试专用通路。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, afterEach } from 'vitest'
import { useCallback, useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { IndicatorPicker } from '../src/client/QuoteStage.tsx'
import { createCustomIndicatorLoader, type CustomIndicatorLoader } from '../src/client/indicator-load.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

afterEach(cleanup)

/** key + 参数直出（断言用 key 而非文案，与词典解耦；参数值可断言）。 */
const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}(${Object.values(params).join(',')})`

const noop = (): void => {}

/** 生产接线的同构壳：失败态取自加载器（模块级可观测状态），重试按钮直连 reload。 */
function PickerHarness({ loader }: { loader: CustomIndicatorLoader }): React.JSX.Element {
  const failure = useSyncExternalStore(
    useCallback((listener: () => void) => loader.subscribe(listener), [loader]),
    useCallback(() => loader.failure(), [loader]),
  )
  return (
    <IndicatorPicker
      t={t}
      market="us"
      instances={[]}
      activeInstances={[]}
      editingIndicator={null}
      loadFailure={failure}
      onRetryLoad={() => { loader.reload() }}
      onToggle={noop}
      onEdit={noop}
      onSetScope={noop}
      onApply={noop}
      onRemoveGlobal={noop}
      onDelete={noop}
      onClose={noop}
    />
  )
}

describe('指标选择器内的自定义指标加载失败提示', () => {
  it('用户在桥不可用时打开指标选择器看到失败原因与重试按钮，重试成功后提示消失', async () => {
    // Given 一个首次拉桥失败、重试成功的加载器（桥请求注入，不真发请求）
    let calls = 0
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('bridge 503')) : Promise.resolve([])
      },
    })
    await loader.load()
    const view = render(<PickerHarness loader={loader} />)

    // When 用户点「重试」（按钮直连 reload，立即重新打桥）
    const status = view.getByRole('status')
    expect(status.textContent).toContain('indicator.loadFailed')
    expect(status.textContent).toContain('bridge 503')
    // 指标名册为空（一条预置都没注册）时提示行照样出现——它渲染在 empty 分支之外
    expect(view.getByText('indicator.empty')).not.toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'indicator.loadRetry' }))
    expect(calls).toBe(2)
    await act(async () => { await loader.load() })

    // Then 失败态清除，提示行从选择器里消失
    expect(loader.failure()).toBeNull()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('用户遇到指标数据校验失败时只看到提示，选择器内没有重试按钮', async () => {
    // Given 桥可达但返回一条校验不通过的定义
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => Promise.resolve([{ id: 'broken' }]),
      validate: () => Promise.resolve({ ok: false, reason: '试算未通过' }),
    })
    await loader.load()

    // When 打开指标选择器
    const view = render(<PickerHarness loader={loader} />)

    // Then 提示行说明校验未通过且不提供重试按钮
    expect(view.getByRole('status').textContent).toContain('indicator.loadInvalid')
    expect(view.getByRole('status').textContent).toContain('试算未通过')
    expect(view.queryByRole('button', { name: 'indicator.loadRetry' })).toBeNull()
  })

  it('用户遇到自动重试已停止时看到停止提示，仍可用「重试」按钮手动重拉', async () => {
    // Given 一个退避预算为零（首拉失败即停止排期）的加载器
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => Promise.reject(new Error('bridge 503')),
      retryDelaysMs: [],
    })
    await loader.load()

    // When 打开指标选择器
    const view = render(<PickerHarness loader={loader} />)

    // Then 停止提示与手动重试按钮同时可见
    expect(loader.failure()?.exhausted).toBe(true)
    expect(view.getByRole('status').textContent).toContain('indicator.loadRetryStopped')
    expect(view.getByRole('button', { name: 'indicator.loadRetry' })).not.toBeNull()
  })
})
