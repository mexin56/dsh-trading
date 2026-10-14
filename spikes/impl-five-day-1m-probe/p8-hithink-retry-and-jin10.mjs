const HK = process.env.HITHINK_API_KEY
const out = { ranAt: new Date().toISOString(), hithink: [], jin10: [] }
const call = async (path, body) => {
  const r = await fetch('https://fuyao.aicubes.cn' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-api-key': HK ?? '' }, body: JSON.stringify(body) })
  const t = await r.text(); let p; try { p = JSON.parse(t) } catch { p = null }
  return { httpStatus: r.status, code: p?.code, msg: p?.message ?? p?.msg, data: p?.data, bodyHead: t.slice(0, 180) }
}
for (const [path, body] of [['/api/futures/prices/daily', { thscode: 'RB00.SHF' }], ['/api/futures/prices/intraday', { thscode: 'RB00.SHF', session: 'intraday' }]]) {
  const r = await call(path, body)
  const item = r.data?.item ?? []
  out.hithink.push({ path, httpStatus: r.httpStatus, code: r.code, msg: r.msg, points: item.length, first: item[0], last: item.at(-1), bodyHead: r.bodyHead })
}
// jin10 MCP: initialize + tools/call get_kline
const TOKEN = process.env.JIN10_TOKEN
const EP = 'https://mcp.jin10.com/mcp'
let sessionId = null
const rpc = async (method, params, notification = false, extra = {}) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}`, 'X-Auth-Token': TOKEN }
  if (sessionId) headers['mcp-session-id'] = sessionId
  if (extra.protocolVersion) headers['MCP-Protocol-Version'] = extra.protocolVersion
  const r = await fetch(EP, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: 1 }), method, ...(params === undefined ? {} : { params }) }) })
  const sid = r.headers.get('mcp-session-id'); if (sid) sessionId = sid
  const t = await r.text()
  let p = null
  try { p = JSON.parse(t) } catch {
    const m = /^data:\s*(.*)$/m.exec(t); if (m) { try { p = JSON.parse(m[1]) } catch { p = null } }
  }
  return { status: r.status, sid, body: p, head: t.slice(0, 300) }
}
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-trading-probe', version: '0.0.1' } })
  const pv = init.body?.result?.protocolVersion
  await rpc('notifications/initialized', undefined, true, { protocolVersion: pv })
  const callRes = await rpc('tools/call', { name: 'get_kline', arguments: { code: 'XAUUSD', time: Math.floor(Date.now() / 1000) - 5 * 86400, count: 100 } }, false, { protocolVersion: pv })
  out.jin10.push({ step: 'initialize', status: init.status, protocolVersion: pv, head: init.head })
  out.jin10.push({ step: 'tools/call get_kline', status: callRes.status, head: callRes.head, resultKeys: callRes.body?.result ? Object.keys(callRes.body.result) : null, isError: callRes.body?.result?.isError ?? null })
  const structured = callRes.body?.result?.structuredContent
  if (structured) { const bars = structured.bars ?? structured.data ?? structured.item; out.jin10.push({ step: 'structured summary', topKeys: Object.keys(structured), barsCount: Array.isArray(bars) ? bars.length : null, sample: Array.isArray(bars) ? bars.slice(0, 2) : structured }) }
} catch (e) { out.jin10.push({ step: 'error', note: String(e.message ?? e) }) }
console.log(JSON.stringify(out, null, 2).slice(0, 4000))
