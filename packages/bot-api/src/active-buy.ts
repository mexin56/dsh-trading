import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomeDir } from '@dshtrading/dsh-home'
import type { ActiveBuySnapshot } from '@dshtrading/api'

export interface ActiveBuyFileSnapshot {
  readonly symbol: string
  readonly date: string
  readonly time: string
  readonly phase: 'close' | 'manual'
  readonly buySharePct: number
  readonly netSharePct: number
}

export interface ActiveBuyPoint {
  date: string
  buySharePct: number
  netSharePct: number
  phase: 'close' | 'manual' | 'live'
  time: string
  source: 'file' | 'live'
}

export interface ActiveBuyWire {
  ok: true
  symbol: string
  points: ActiveBuyPoint[]
  live?: { at: string }
}

function isFileSnapshot(value: unknown): value is ActiveBuyFileSnapshot {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.symbol === 'string' && row.symbol.length > 0
    && typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
    && typeof row.time === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(row.time)
    && (row.phase === 'close' || row.phase === 'manual')
    && typeof row.buySharePct === 'number' && Number.isFinite(row.buySharePct)
    && typeof row.netSharePct === 'number' && Number.isFinite(row.netSharePct)
}

/** 只读 IO：覆盖变量整体替换路径；缺文件为空，坏 JSON/坏形逐行跳过并计数。 */
export async function readActiveBuySnapshots(): Promise<{ snapshots: ActiveBuyFileSnapshot[]; badLines: number }> {
  const path = process.env.DSH_TRADING_ACTIVE_BUY_FILE ?? join(dshHomeDir(), 'active-buy', 'snapshots.jsonl')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { snapshots: [], badLines: 0 }
    throw error
  }
  const snapshots: ActiveBuyFileSnapshot[] = []
  let badLines = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (isFileSnapshot(value)) snapshots.push(value)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { snapshots, badLines }
}

/** 今天固定按 Asia/Shanghai 判定，不随宿主系统时区变化。 */
export function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/**
 * 纯归并：先按 symbol 过滤、按 date 去重；close 优先，否则 time 最晚。
 * live 只在日期等于上海今天且文件该标的今天无行时注入，才携带 live.at。
 * 缺能力/调用失败由桥传 undefined；过期 live 不补零、不编值。
 * 日期升序，注入后只留最近 250 个交易日，不修改输入数组。
 */
export function mergeActiveBuyPoints(
  snapshots: readonly ActiveBuyFileSnapshot[],
  symbol: string,
  today: string,
  snapshot?: ActiveBuySnapshot,
): ActiveBuyWire {
  const days = new Map<string, ActiveBuyFileSnapshot>()
  for (const row of snapshots) {
    if (row.symbol !== symbol) continue
    const prior = days.get(row.date)
    if (prior === undefined
      || (row.phase === 'close' && prior.phase !== 'close')
      || (row.phase === prior.phase && row.time > prior.time)) days.set(row.date, row)
  }
  const points: ActiveBuyPoint[] = [...days.values()].map(row => ({ date: row.date, buySharePct: row.buySharePct, netSharePct: row.netSharePct, phase: row.phase, time: row.time, source: 'file' }))
  const live = snapshot?.date === today && !days.has(today) ? snapshot : undefined
  if (live !== undefined) points.push({ date: live.date, buySharePct: live.buySharePct, netSharePct: live.netSharePct, phase: 'live', time: live.time, source: 'live' })
  points.sort((a, b) => a.date.localeCompare(b.date))
  return { ok: true, symbol, points: points.slice(-250), ...(live === undefined ? {} : { live: { at: live.fetchedAt } }) }
}
