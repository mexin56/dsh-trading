/**
 * 宿主深色主题口径的单一实现（2026-10-14 提取自 TvChart）：图表主题与「五日级别
 * 成交量档位色」必须看同一个信号——两处各自读 DOM 属性，换主题时必然有一处跟不上。
 *
 * 判据（按宿主实际落点，任一成立即深色）：body[data-ds-dark-theme]、
 * html[data-theme=dark]、body[data-theme=dark]，外加 prefers-color-scheme。
 */
import { useSyncExternalStore } from 'react'

export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  return document.body.hasAttribute('data-ds-dark-theme')
    || document.documentElement.getAttribute('data-theme') === 'dark'
    || document.body.getAttribute('data-theme') === 'dark'
}

const listeners = new Set<() => void>()
let observer: MutationObserver | null = null
let mql: MediaQueryList | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function attach(): void {
  if (typeof document === 'undefined' || observer !== null) return
  observer = new MutationObserver(emit)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme'] })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  mql = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null
  mql?.addEventListener('change', emit)
}

function detach(): void {
  observer?.disconnect()
  observer = null
  mql?.removeEventListener('change', emit)
  mql = null
}

export function subscribeDarkTheme(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) attach()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) detach()
  }
}

/** 当前是否深色主题（订阅宿主主题切换）。 */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribeDarkTheme, isDarkTheme, () => false)
}
