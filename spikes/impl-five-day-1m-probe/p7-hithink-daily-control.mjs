// Control probe: is the hithink key/auth OK (daily endpoint) while intraday 5001s?
const KEY = process.env.HITHINK_API_KEY
const out = { ranAt: new Date().toISOString(), cases: [] }
for (const [path, body] of [
  ['/api/futures/prices/daily', { thscode: 'RB2605.SHF' }],
  ['/api/futures/prices/intraday', { thscode: 'RB2605.SHF', session: 'intraday' }],
]) {
  const rec = { path, body, httpStatus: null, code: null, msg: null, points: 0, note: '' }
  try {
    const r = await fetch('https://fuyao.aicubes.cn' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-api-key': KEY ?? '' }, body: JSON.stringify(body) })
    rec.httpStatus = r.status
    const t = await r.text(); let p; try { p = JSON.parse(t) } catch { p = null }
    rec.code = p?.code; rec.msg = p?.message ?? p?.msg
    const item = p?.data?.item
    if (Array.isArray(item)) { rec.points = item.length; rec.firstTs = item[0]?.timestamp; rec.lastTs = item.at(-1)?.timestamp }
    else rec.bodyHead = t.slice(0, 160)
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.cases.push(rec)
}
console.log(JSON.stringify(out, null, 2))
