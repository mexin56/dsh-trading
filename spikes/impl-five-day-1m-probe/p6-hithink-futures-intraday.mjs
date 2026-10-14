// Probe: hithink futures intraday depth (futures market 1m comes from aggregating these points).
const KEY = process.env.HITHINK_API_KEY
const BASE = 'https://fuyao.aicubes.cn'
const out = { ranAt: new Date().toISOString(), keyPresent: Boolean(KEY), cases: [] }
const ths = ['IF2603.CFE', 'RB2605.SHF', 'AU2612.SHF', 'CL2612.NYMEX']
for (const thscode of ths) {
  for (const session of [undefined, 'pre_market']) {
    const url = `${BASE}/api/futures/prices/intraday`
    const rec = { thscode, session, url, httpStatus: null, code: null, msg: null, points: 0, first: null, last: null, note: '' }
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-api-key': KEY ?? '' },
        body: JSON.stringify({ thscode, ...(session ? { session } : {}) }),
      })
      rec.httpStatus = r.status
      const t = await r.text()
      let p; try { p = JSON.parse(t) } catch { p = null }
      rec.code = p?.code; rec.msg = p?.message ?? p?.msg
      const item = p?.data?.item
      if (Array.isArray(item)) {
        rec.points = item.length
        const ts = item.map(x => x.timestamp).filter(x => typeof x === 'number')
        if (ts.length) { rec.first = new Date(Math.min(...ts)).toISOString(); rec.last = new Date(Math.max(...ts)).toISOString(); rec.days = new Set(ts.map(s => new Date(s).toISOString().slice(0,10))).size }
        rec.sample = item.slice(0, 2)
      } else rec.bodyHead = t.slice(0, 200)
    } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
    out.cases.push(rec)
  }
}
console.log(JSON.stringify(out, null, 2))
