/**
 * Polling hook with tab-visibility pause: interval timers run only while the
 * document is visible (public endpoints stay gentle when the tab is parked).
 *
 * `intervalMs` 传 `null` 即不挂定时器：只在依赖变化与文档重新可见时各取一次
 * （按需取数）——用于没有常驻轮询预算的市场，策略见 quote-budget.ts。
 */
import { useEffect, useRef } from 'react'

export function usePoll(poll: (() => Promise<void> | void) | null | undefined, intervalMs: number | null, deps: readonly unknown[]): void {
  const pollRef = useRef(poll)
  pollRef.current = poll

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = (): void => {
      if (document.visibilityState === 'visible' && typeof pollRef.current === 'function') {
        void pollRef.current()
      }
    }
    tick()
    if (intervalMs !== null) timer = setInterval(tick, intervalMs)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
