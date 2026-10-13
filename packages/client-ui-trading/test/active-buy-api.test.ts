import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchActiveBuy } from '../src/client/api.ts'

let server: Server
let baseUrl = ''
let lastUrl = ''
const realFetch = globalThis.fetch
const point = { date: '2026-10-13', buySharePct: 53.37, netSharePct: 6.73, phase: 'live', time: '09:53:03', source: 'live' }

beforeEach(async () => {
  server = createServer((req, res) => {
    lastUrl = req.url ?? ''
    const query = new URL(lastUrl, 'http://localhost').searchParams
    const symbol = query.get('symbol')
    res.setHeader('content-type', 'application/json')
    if (symbol === 'broken') { res.statusCode = 500; res.end('{}'); return }
    if (symbol === 'unavailable') { res.end(JSON.stringify({ ok: false })); return }
    res.end(JSON.stringify({ ok: true, symbol, points: query.get('market') !== 'cn' ? [] : [symbol === 'history' ? { ...point, phase: 'close', source: 'file' } : point], ...(symbol === 'history' ? {} : { live: { at: '2026-10-13T09:53:03+08:00' } }) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server address missing')
  baseUrl = `http://127.0.0.1:${address.port}`
  globalThis.fetch = (input, init) => realFetch(baseUrl + String(input), init)
})
afterEach(async () => {
  globalThis.fetch = realFetch
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('主动买盘桥客户端', () => {
  it('用户查看主动买盘时按市场标的取回顶层 points 与 live 元数据', async () => {
    // Given 真实 HTTP 桥回冻结信封
    // When 按 A 股标的加载
    const result = await fetchActiveBuy('cn', '002714.SZ')
    // Then 查询参数与顶层序列逐项保留，不误读嵌套信封
    expect(lastUrl).toBe('/dshtrading/api/active-buy?market=cn&symbol=002714.SZ')
    expect(result).toEqual({ ok: true, symbol: '002714.SZ', points: [point], live: { at: '2026-10-13T09:53:03+08:00' } })
  })

  it('用户在 live 能力缺席时仍可取文件历史而非伪造当日点', async () => {
    // Given 桥以 200 返回文件降级数据
    // When 加载历史标的及非 A 股市场
    const result = await fetchActiveBuy('cn', 'history')
    const otherMarket = await fetchActiveBuy('hk', '00700.HK')
    // Then 历史点照原样保留，无 live，不支持市场为空
    expect(result?.points).toEqual([{ ...point, phase: 'close', source: 'file' }])
    expect(result?.live).toBeUndefined()
    expect(otherMarket?.points).toEqual([])
  })

  it('用户遇到桥业务错误或 HTTP 失败时主图不受序列异常牵连', async () => {
    // Given 桥的错误与旧宿主不可用信封
    // When 客户端取数
    const results = await Promise.all([fetchActiveBuy('cn', 'unavailable'), fetchActiveBuy('cn', 'broken')])
    // Then 不抛错，返回明确无数据
    expect(results).toEqual([undefined, undefined])
  })
})
