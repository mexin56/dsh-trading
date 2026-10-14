// Probe: upstream depth cap of Tencent mkline tf=m1 (how many bars does it actually return?)
const BASE = 'https://ifzq.gtimg.cn'
const counts = [1000, 1440, 2400, 5000, 10000]
const out = { ranAt: new Date().toISOString(), cases: [] }
for (const wire of ['sh600519', 'hk00700']) {
  for (const count of counts) {
    const url = `${BASE}/appstock/app/kline/mkline?param=${wire},m1,,${count}`
    const rec = { wire, count, url, httpStatus: null, code: null, msg: null, bars: 0, first: null, last: null, distinctDays: 0, note: '' }
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } })
      rec.httpStatus = res.status
      const text = await res.text()
      if (res.status === 200) {
        let j; try { j = JSON.parse(text) } catch { rec.note = 'non-JSON: ' + text.slice(0,120); out.cases.push(rec); continue }
        rec.code = j.code; rec.msg = j.msg
        const m = j.data?.[wire]
        rec.payloadKeys = m ? Object.keys(m).filter(k => k !== 'qt') : []
        const rows = m?.['m1']
        if (Array.isArray(rows)) {
          rec.bars = rows.length
          rec.first = rows[0]?.[0]; rec.last = rows[rows.length-1]?.[0]
          rec.distinctDays = new Set(rows.map(r => String(r[0]).slice(0,8))).size
          rec.days = [...new Set(rows.map(r => String(r[0]).slice(0,8)))]
        } else rec.note = 'no m1 array; keys=' + JSON.stringify(rec.payloadKeys)
      }
    } catch (e) { rec.note = 'fetch error: ' + String(e.message ?? e) }
    out.cases.push(rec)
  }
}
console.log(JSON.stringify(out, null, 2))
