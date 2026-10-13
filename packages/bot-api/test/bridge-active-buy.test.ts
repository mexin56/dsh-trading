import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActiveBuySnapshot, MarketDataService } from '@dshtrading/api'
import { TradingBridge, createBridgeHost, dispatchBridgeRequest, type MarketDataRegistryLike } from '../src/bridge.ts'
import { mergeActiveBuyPoints, readActiveBuySnapshots, shanghaiDate } from '../src/active-buy.ts'

const symbol = '002714.SZ'
const today = () => shanghaiDate(new Date())
const row = (date: string, phase: 'close' | 'manual' = 'manual', time = '10:00:00', buySharePct = 53.37) => ({ symbol, date, phase, time, buySharePct, netSharePct: 6.73 })
const point = (date: string, phase: 'close' | 'manual' | 'live' = 'manual', time = '10:00:00', buySharePct = 53.37, source: 'file' | 'live' = 'file') => ({ date, phase, time, buySharePct, netSharePct: 6.73, source })
const snapshot = (date = today()): ActiveBuySnapshot => ({ symbol, date, time: '09:53:03', totalLots: 100, outerLots: 53.37, innerLots: 46.63, buySharePct: 53.37, netSharePct: 6.73, source: 'tencent', fetchedAt: `${date}T09:53:03+08:00` })

/** 契约化行情假件：按 API 的可选能力注入，不替换桥或文件读取。 */
function service(getActiveBuySnapshot?: (symbol: string) => Promise<ActiveBuySnapshot>): MarketDataService {
  return { getTicker: async symbol => ({ symbol, price: 100, timestamp: 0 }), getKlines: async () => [], subscribeTicker: () => ({ dispose() {} }), ...(getActiveBuySnapshot ? { getActiveBuySnapshot } : {}) }
}
function request(marketService?: MarketDataService, market = 'cn') {
  const bridge = new TradingBridge(createBridgeHost({ legacy: () => marketService }))
  return dispatchBridgeRequest(bridge, 'GET', '/active-buy', new URLSearchParams({ market, symbol }))
}
let dir: string
let file: string
let previousHome: string | undefined
let previousFile: string | undefined
// home-guard-allow: beforeEach 将 DSH_HOME 钉到 mkdtempSync 临时目录，并用 DSH_TRADING_ACTIVE_BUY_FILE 整体覆盖数据路径，不触及真实 home。
// afterEach 恢复两个环境变量并删除临时目录。
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dshtrading-active-buy-'))
  file = join(dir, 'snapshots.jsonl')
  previousHome = process.env.DSH_HOME
  previousFile = process.env.DSH_TRADING_ACTIVE_BUY_FILE
  process.env.DSH_HOME = dir
  process.env.DSH_TRADING_ACTIVE_BUY_FILE = file
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousFile === undefined) delete process.env.DSH_TRADING_ACTIVE_BUY_FILE
  else process.env.DSH_TRADING_ACTIVE_BUY_FILE = previousFile
  rmSync(dir, { recursive: true, force: true })
})
function seed(rows: unknown[]) { writeFileSync(file, rows.map(value => JSON.stringify(value)).join('\n')) }

describe('active buy daily history bridge', () => {
  it('user receives live from the active capable provider ahead of another registered source', async () => {
    // Given: active tencent has capability while an earlier provider offers a different live value
    seed([row('2026-09-18')])
    const live = { ...snapshot(), buySharePct: 61 }
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'tencent', service: service(async () => live) }),
      list: () => [{ provider: 'alpha', service: service(async () => ({ ...snapshot(), buySharePct: 72 })) }],
    }
    const bridge = new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))
    // When: requesting daily history with the registry available
    const result = await dispatchBridgeRequest(bridge, 'GET', '/active-buy', new URLSearchParams({ market: 'cn', symbol }))
    // Then: active wins over the earlier registered provider
    expect(result).toEqual({ status: 200, payload: { ok: true, symbol, points: [point('2026-09-18'), point(today(), 'live', '09:53:03', 61, 'live')], live: { at: live.fetchedAt } } })
  })
  it('user receives live from the second sorted provider when active qmt has no capability', async () => {
    // Given: reverse registration order sorts to qmt without capability then tencent with capability
    seed([row('2026-09-18')])
    const live = { ...snapshot(), buySharePct: 64 }
    const qmt = service()
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'qmt', service: qmt }),
      list: () => [{ provider: 'tencent', service: service(async () => live) }, { provider: 'qmt', service: qmt }],
    }
    const bridge = new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))
    // When: requesting daily history under the qmt route
    const result = await dispatchBridgeRequest(bridge, 'GET', '/active-buy', new URLSearchParams({ market: 'cn', symbol }))
    // Then: the tencent-only value proves the second sorted service supplied live
    expect(result).toEqual({ status: 200, payload: { ok: true, symbol, points: [point('2026-09-18'), point(today(), 'live', '09:53:03', 64, 'live')], live: { at: live.fetchedAt } } })
  })
  it('user receives file history without live when active and all registered providers lack capability', async () => {
    // Given: real file history and two providers without optional live capability
    seed([row('2026-09-18')])
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'qmt', service: service() }),
      list: () => [{ provider: 'tencent', service: service() }, { provider: 'qmt', service: service() }],
    }
    const bridge = new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))
    // When: requesting daily history without any live source
    const result = await dispatchBridgeRequest(bridge, 'GET', '/active-buy', new URLSearchParams({ market: 'cn', symbol }))
    // Then: the complete successful response has history and no live field or fabricated zero
    expect(result).toEqual({ status: 200, payload: { ok: true, symbol, points: [point('2026-09-18')] } })
    expect(result.payload).not.toHaveProperty('live')
  })
  it('user receives close ahead of a later manual snapshot and only the requested symbol', async () => {
    // Given: a close, a later manual and another symbol on the same day
    seed([row('2026-09-18', 'close', '15:05:00'), row('2026-09-18', 'manual', '16:00:00', 70), { ...row('2026-09-18'), symbol: 'OTHER' }])
    // When: requesting the daily series
    const result = await request()
    // Then: close wins and no other symbol leaks
    expect(result).toEqual({ status: 200, payload: { ok: true, symbol, points: [point('2026-09-18', 'close', '15:05:00')] } })
  })
  it('user receives the latest manual snapshot and dates in ascending order', async () => {
    // Given: unordered days and multiple manual snapshots
    seed([row('2026-09-19'), row('2026-09-18', 'manual', '14:00:00', 60), row('2026-09-18')])
    // When: requesting history
    const result = await request()
    // Then: the latest manual wins within each date
    expect(result.payload).toEqual({ ok: true, symbol, points: [point('2026-09-18', 'manual', '14:00:00', 60), point('2026-09-19')] })
  })
  it('user receives close manual and today live in one response without changing the file', async () => {
    // Given: two historical phases and a live-capable service
    seed([row('2026-09-18', 'close', '15:05:00'), row('2026-09-19')])
    const original = readFileSync(file, 'utf8')
    const live = snapshot()
    // When: requesting the bridge endpoint
    const result = await request(service(async () => live))
    // Then: today is appended and the data file remains read-only
    expect(result).toEqual({ status: 200, payload: { ok: true, symbol, points: [point('2026-09-18', 'close', '15:05:00'), point('2026-09-19'), point(today(), 'live', '09:53:03', 53.37, 'live')], live: { at: live.fetchedAt } } })
    expect(readFileSync(file, 'utf8')).toBe(original)
    console.log('ACTIVE_BUY_RESPONSE', JSON.stringify(result.payload))
  })
  it('user keeps today file snapshot instead of injecting live', async () => {
    // Given: today already exists as manual in the file
    seed([row(today())])
    // When: requesting with live capability
    const result = await request(service(async () => snapshot()))
    // Then: manual remains and no live metadata appears
    expect(result.payload).toEqual({ ok: true, symbol, points: [point(today())] })
  })
  it('user receives history without live metadata when capability is absent', async () => {
    // Given: history and a service without the optional method
    seed([row('2026-09-18')])
    // When: requesting history
    const result = await request(service())
    // Then: capability absence is not a failure or a zero point
    expect(result.payload).toEqual({ ok: true, symbol, points: [point('2026-09-18')] })
  })
  it('user receives history when live fetching throws', async () => {
    // Given: history and an unavailable upstream
    seed([row('2026-09-18')])
    // When: requesting with a failing service
    const result = await request(service(async () => { throw new Error('upstream unavailable') }))
    // Then: history still succeeds without fabricated live data
    expect(result).toEqual({ status: 200, payload: { ok: true, symbol, points: [point('2026-09-18')] } })
  })
  it('user receives only history when upstream date is stale', async () => {
    // Given: a historical upstream snapshot
    seed([row('2026-09-18')])
    // When: requesting with a stale live date
    const result = await request(service(async () => snapshot('2026-09-19')))
    // Then: stale upstream is not appended
    expect(result.payload).toEqual({ ok: true, symbol, points: [point('2026-09-18')] })
  })
  it('user receives valid rows while malformed JSON and malformed shapes are counted', async () => {
    // Given: syntax and shape failures mixed with a valid row
    writeFileSync(file, `not-json\nnull\n{}\n${JSON.stringify(row('2026-09-18'))}\n`)
    // When: reading snapshots and requesting the endpoint
    const loaded = await readActiveBuySnapshots()
    const result = await request()
    // Then: bad rows are skipped, counted and never replace valid data
    expect(loaded).toEqual({ snapshots: [row('2026-09-18')], badLines: 3 })
    expect(result.payload).toEqual({ ok: true, symbol, points: [point('2026-09-18')] })
  })
  it('user receives an empty series for non-cn markets even with a data file', async () => {
    // Given: a valid file that must not be exposed for other markets
    seed([row('2026-09-18')])
    // When: requesting hk and an unknown non-cn market
    const results = await Promise.all([request(undefined, 'hk'), request(undefined, 'jp')])
    // Then: both return the frozen non-cn empty response
    expect(results).toEqual([{ status: 200, payload: { ok: true, symbol, points: [] } }, { status: 200, payload: { ok: true, symbol, points: [] } }])
  })
  it('user receives only the latest 250 dates including a new live point', async () => {
    // Given: 251 historical days and a live-capable service
    const rows = Array.from({ length: 251 }, (_, index) => row(new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10)))
    seed(rows)
    // When: requesting the merged history
    const result = await request(service(async () => snapshot()))
    // Then: the earliest two days are removed after live injection
    expect(result.payload).toEqual({ ok: true, symbol, points: [...rows.slice(2).map(value => point(value.date)), point(today(), 'live', '09:53:03', 53.37, 'live')], live: { at: snapshot().fetchedAt } })
  })
  it('user receives an empty series when the data file does not exist', async () => {
    // Given: no file in the isolated directory
    // When: requesting without live capability
    const result = await request()
    // Then: missing file is an empty success
    expect(result).toEqual({ status: 200, payload: { ok: true, symbol, points: [] } })
  })
  it('user receives history from the trading home default path when no override is set', async () => {
    // Given: an isolated trading home with the default active-buy file
    delete process.env.DSH_TRADING_ACTIVE_BUY_FILE
    mkdirSync(join(dir, 'active-buy'))
    writeFileSync(join(dir, 'active-buy', 'snapshots.jsonl'), JSON.stringify(row('2026-09-18')))
    // When: requesting without a file override
    const result = await request()
    // Then: the home-relative file supplies the history
    expect(result.payload).toEqual({ ok: true, symbol, points: [point('2026-09-18')] })
  })
  it('user receives the same close priority from a memory-driven merge', () => {
    // Given: pure in-memory rows with multiple closes and a later manual
    const rows = [row('2026-09-18', 'close', '15:05:00', 60), row('2026-09-18', 'close', '15:00:00'), row('2026-09-18', 'manual', '16:00:00', 70)]
    // When: merging without any file access
    const result = mergeActiveBuyPoints(rows, symbol, '2026-09-19')
    // Then: latest close is retained
    expect(result).toEqual({ ok: true, symbol, points: [point('2026-09-18', 'close', '15:05:00', 60)] })
  })
  it('user gets the Shanghai date across the UTC day boundary', () => {
    // Given: UTC evening already belongs to tomorrow in Shanghai
    const instant = new Date('2026-10-12T16:00:00Z')
    // When: determining the live trading date
    const date = shanghaiDate(instant)
    // Then: the comparison uses Asia/Shanghai rather than UTC
    expect(date).toBe('2026-10-13')
  })
})
