// Probe: does Tencent mkline endpoint serve tf=m1 (1-minute bars)?
// Mirrors connector-tencent's minute branch exactly, only tf swapped m5 -> m1.
const BASE = 'https://ifzq.gtimg.cn'
const cases = [['sh600519', 'cn'], ['sz000001', 'cn'], ['hk00700', 'hk']]
const out = { ranAt: new Date().toISOString(), cases: [] }
for (const [wire, market] of cases) {
  for (const tf of ['m1', 'm5']) {
    for (const count of [800]) {
      const url = `${BASE}/appstock/app/kline/mkline?param=${wire},${tf},,${count}`
      const rec = { wire, market, tf, count, url, httpStatus: null, ok: false, note: '', bars: 0, first: null, last: null }
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } })
        rec.httpStatus = res.status
        const text = await res.text()
        rec.bodyHead = text.slice(0, 200)
        if (res.status === 200) {
          let j; try { j = JSON.parse(text) } catch { rec.note = 'non-JSON'; out.cases.push(rec); continue }
          rec.code = j.code
          rec.msg = j.msg
          const m = j.data?.[wire]
          // keys present in the per-symbol payload
          rec.payloadKeys = m ? Object.keys(m) : []
          const rows = m?.[tf]
          if (Array.isArray(rows)) {
            rec.bars = rows.length
            rec.first = rows[0]?.[0]; rec.last = rows[rows.length - 1]?.[0]
            rec.sample = rows.slice(0, 2)
            rec.ok = true
          } else {
            rec.note = `no ${tf} array`
          }
        }
      } catch (e) { rec.note = 'fetch error: ' + String(e.message ?? e) }
      out.cases.push(rec)
    }
  }
}
console.log(JSON.stringify(out, null, 2))
