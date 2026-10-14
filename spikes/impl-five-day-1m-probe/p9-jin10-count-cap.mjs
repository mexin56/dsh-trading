const TOKEN = process.env.JIN10_TOKEN
const EP = 'https://mcp.jin10.com/mcp'
const out = { ranAt: new Date().toISOString(), calls: [] }
let sessionId = null, pv = null
const rpc = async (method, params, notification = false) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` }
  if (sessionId) headers['mcp-session-id'] = sessionId
  if (pv) headers['MCP-Protocol-Version'] = pv
  const r = await fetch(EP, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: 1 }), method, ...(params === undefined ? {} : { params }) }) })
  const sid = r.headers.get('mcp-session-id'); if (sid) sessionId = sid
  const t = await r.text(); let p = null
  try { p = JSON.parse(t) } catch { const m = /^data:\s*(.*)$/m.exec(t); if (m) { try { p = JSON.parse(m[1]) } catch {} } }
  return p
}
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } })
pv = init?.result?.protocolVersion
await rpc('notifications/initialized', undefined, true)
const nowSec = Math.floor(Date.now() / 1000)
for (const [label, args] of [
  ['XAUUSD recent count=100', { code: 'XAUUSD', time: nowSec - 3600, count: 100 }],
  ['XAUUSD recent count=1000', { code: 'XAUUSD', time: nowSec - 3600, count: 1000 }],
  ['XAUUSD recent count=300', { code: 'XAUUSD', time: nowSec - 3600, count: 300 }],
  ['XAUUSD 5d-ago count=100', { code: 'XAUUSD', time: nowSec - 5 * 86400, count: 100 }],
]) {
  const p = await rpc('tools/call', { name: 'get_kline', arguments: args })
  const sc = p?.result?.structuredContent ?? p?.result
  const bars = sc?.data?.klines ?? sc?.klines
  const rec = { label, args, isError: p?.result?.isError ?? p?.error ?? null, status: sc?.status, message: sc?.message, bars: Array.isArray(bars) ? bars.length : null }
  if (Array.isArray(bars) && bars.length) { rec.first = bars[0]; rec.last = bars.at(-1); rec.days = new Set(bars.map(b => new Date((b.time ?? b.timestamp ?? b[0]) * 1000).toISOString().slice(0, 10))).size }
  else rec.head = JSON.stringify(p).slice(0, 220)
  out.calls.push(rec)
}
console.log(JSON.stringify(out, null, 2).slice(0, 3500))
