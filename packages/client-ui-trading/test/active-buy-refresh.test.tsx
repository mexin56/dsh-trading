/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { CN_ACTIVE_BUY_KEY } from '../src/client/aux-series.ts'
import { useAuxSeries } from '../src/client/useAuxSeries.ts'
import { IndicatorPaneTitle } from '../src/client/TvChart.tsx'
import { zh, en } from '../src/client/locales.ts'
import type { ActiveBuyHistory } from '../src/client/api.ts'

const keys = [CN_ACTIVE_BUY_KEY]
const fetchHoldings = async () => undefined
function history(symbol: string, value: number, live = true): ActiveBuyHistory {
  return { symbol, points: [{ date: '2026-10-13', buySharePct: 53, netSharePct: value, phase: live ? 'live' : 'close', time: '10:00:00', source: live ? 'live' : 'file' }] }
}
async function flush(): Promise<void> { await act(async () => { await Promise.resolve() }) }
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('主动买盘刷新与标题', () => {
  it('用户在交易窗内每五分钟获得新点而复取失败不清空已有副图', async () => {
    // Given 上海周二上午与可失败的桥序列
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-13T10:00:00+08:00'))
    let value = 6.73
    let mode: 'live' | 'empty' | 'failure' | 'close' = 'live'
    const fetchActiveBuy = async (market: string, symbol: string): Promise<ActiveBuyHistory> => {
      if (mode === 'failure') throw new Error('offline')
      return mode === 'empty' ? { symbol, points: [] } : history(symbol, value, mode === 'live')
    }
    const { result } = renderHook(() => useAuxSeries('cn', '002714.SZ', keys, fetchHoldings, fetchActiveBuy))
    await flush()
    // When 逐个五分钟收到更新、空与失败，再收到收盘文件点
    value = 8.25
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    // Then 新点替换旧点，空与失败都保留最近真实值
    expect(result.current.series[CN_ACTIVE_BUY_KEY]).toEqual([{ date: Date.UTC(2026, 9, 13), value: 8.25 }])
    expect(result.current.liveKeys).toEqual(keys)
    mode = 'empty'
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(result.current.series[CN_ACTIVE_BUY_KEY]).toEqual([{ date: Date.UTC(2026, 9, 13), value: 8.25 }])
    mode = 'failure'
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(result.current.series[CN_ACTIVE_BUY_KEY]).toEqual([{ date: Date.UTC(2026, 9, 13), value: 8.25 }])
    mode = 'close'
    value = 9.1
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(result.current.series[CN_ACTIVE_BUY_KEY]).toEqual([{ date: Date.UTC(2026, 9, 13), value: 9.1 }])
    expect(result.current.liveKeys).toEqual([])
  })

  it('用户在窗口外仅首取并在进入交易窗口后恢复刷新', async () => {
    // Given 上午窗口开始前已打开的主动买盘图
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-13T09:15:00+08:00'))
    let value = 1
    const fetchActiveBuy = async (_market: string, symbol: string) => history(symbol, value)
    const { result } = renderHook(() => useAuxSeries('cn', '002714.SZ', keys, fetchHoldings, fetchActiveBuy))
    await flush()
    // When 窗口外五分钟过去，随后再推进到窗口开始
    value = 2
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    // Then 窗口外仍是首取值，09:25 后刷新
    expect(result.current.series[CN_ACTIVE_BUY_KEY]?.[0]?.value).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(result.current.series[CN_ACTIVE_BUY_KEY]?.[0]?.value).toBe(2)
  })

  it('用户换标的并切回时在途旧应答不能覆盖新标的序列', async () => {
    // Given A 的首次桥请求被保留在途
    let release: (value: ActiveBuyHistory) => void = () => { throw new Error('request not started') }
    let first = true
    const fetchActiveBuy = async (_market: string, symbol: string): Promise<ActiveBuyHistory> => {
      if (first) { first = false; return new Promise(resolve => { release = resolve }) }
      return history(symbol, symbol === '002714.SZ' ? 8 : 3)
    }
    const { result, rerender } = renderHook(({ symbol }) => useAuxSeries('cn', symbol, keys, fetchHoldings, fetchActiveBuy), { initialProps: { symbol: '002714.SZ' } })
    // When 切到 B 再切回 A，最后释放 A 的旧响应
    rerender({ symbol: '600000.SH' })
    await flush()
    // Then B 值只来自 B，返回 A 后旧请求仍被丢弃
    expect(result.current.series[CN_ACTIVE_BUY_KEY]?.[0]?.value).toBe(3)
    rerender({ symbol: '002714.SZ' })
    await flush()
    await act(async () => { release(history('002714.SZ', 1)) })
    expect(result.current.series[CN_ACTIVE_BUY_KEY]?.[0]?.value).toBe(8)
    expect(result.current.request).toBe('cn:002714.SZ')
  })

  it('用户在不可见标签加载港股通时仍首取且不会新增盘中轮询', async () => {
    // Given 隐藏标签与港股通的真实日频返回形状
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-13T10:00:00+08:00'))
    const previous = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    let ratio = 11.9
    const holdings = async () => ({ symbol: '00700.HK', points: [{ date: Date.UTC(2026, 9, 13), holdRatio: ratio, holdShares: 100, holdMarketCap: 1000 }] })
    try {
      const { result, rerender } = renderHook(() => useAuxSeries('hk', '00700.HK', ['hk-connect-holding'], holdings, async () => undefined))
      await flush()
      // When 时间推进、相同标的重新渲染并恢复可见
      ratio = 12.5
      rerender()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(600_000) })
      // Then 首取值仍在，HK 不会进入 CN 的五分钟复取路径
      expect(result.current.series['hk-connect-holding']).toEqual([{ date: Date.UTC(2026, 9, 13), value: 11.9 }])
      expect(result.current.liveKeys).toEqual([])
    } finally {
      if (previous) Object.defineProperty(document, 'visibilityState', previous)
      else Reflect.deleteProperty(document, 'visibilityState')
    }
  })

  it('用户看到数据驱动的盘中徽标并在无 live 时不看到徽标', () => {
    // Given 真实标题组件与中英文词典
    const { getByText, queryByRole, rerender } = render(<IndicatorPaneTitle title="主动买盘" live liveText={zh['indicator.live']} />)
    // When 展示 live、切英文，再切为无 live
    // Then 文案从词典来，live 缺席不显示徽标
    expect(getByText('主动买盘').textContent).toBe('主动买盘')
    expect(queryByRole('status')?.textContent).toBe('盘中')
    rerender(<IndicatorPaneTitle title="主动买盘" live liveText={en['indicator.live']} />)
    expect(queryByRole('status')?.textContent).toBe('LIVE')
    rerender(<IndicatorPaneTitle title="主动买盘" liveText={zh['indicator.live']} />)
    expect(queryByRole('status')).toBeNull()
  })
})
