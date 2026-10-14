// Probe A: Tencent mkline m1 count boundary (cn); hk wire variants on both hosts.
// Probe B: Eastmoney kline/get klt=1 depth for cn (1.600519) and klt=1 for hk (116.00700).
// Probe C: XYSZ /api/v1/klines interval=1m single-request depth.
const UA = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' }
const out = { ranAt: new Date().toISOString(), A: [], B: [], C: [] }
const j = (t) => { try { return JSON.parse(t) } catch { return null } }

// A: boundary
for (const [host, wire, tf] of [
  ['https://ifzq.gtimg.cn', 'sh600519', 'm1'],
  ['https://ifzq.gtimg.cn', 'sh600519', 'm1'],
  ['https://ifzq.gtimg.cn', 'sh600519', 'm1'],
  ['https://ifzq.gtimg.cn', 'sh600519', 'm1'],
  ['https://ifzq.gtimg.cn', 'sh600519', 'm1'],
]) { /* filled below */ }
for (const count of [800, 801, 900, 1200, 1600]) {
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,,${count}`
  const rec = { probe: 'tencent-count', count, url, httpStatus: null, code: null, bars: 0, days: 0, first: null, last: null, note: '' }
  try {
    const r = await fetch(url, { headers: UA }); rec.httpStatus = r.status
    const p = j(await r.text())
    rec.code = p?.code
    const rows = p?.data?.sh600519?.m1
    if (Array.isArray(rows)) { rec.bars = rows.length; rec.first = rows[0]?.[0]; rec.last = rows.at(-1)?.[0]; rec.days = new Set(rows.map(x => String(x[0]).slice(0,8))).size }
    else rec.note = 'no m1 array'
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.A.push(rec)
}
// A2: hk variants
for (const [host, wire] of [['https://ifzq.gtimg.cn','hk00700'],['https://web.ifzq.gtimg.cn','hk00700'],['https://ifzq.gtimg.cn','r_hk00700']]) {
  for (const tf of ['m1','m5']) {
    const url = `${host}/appstock/app/kline/mkline?param=${wire},${tf},,10`
    const rec = { probe: 'tencent-hk', host, wire, tf, url, httpStatus: null, code: null, msg: null, bars: 0, note: '' }
    try {
      const r = await fetch(url, { headers: UA }); rec.httpStatus = r.status
      const t = await r.text(); const p = j(t)
      rec.code = p?.code; rec.msg = p?.msg
      const rows = p?.data?.[wire]?.[tf]
      if (Array.isArray(rows)) { rec.bars = rows.length; rec.first = rows[0]?.[0]; rec.sample = rows.slice(0,2) }
      else rec.bodyHead = t.slice(0,150)
    } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
    out.A.push(rec)
  }
}

// B: eastmoney
for (const [label, secid, klt, lmt] of [
  ['cn-1m-lmt1000', '1.600519', 1, 1000],
  ['cn-1m-lmt5000', '1.600519', 1, 5000],
  ['cn-5m-lmt1000', '1.600519', 5, 1000],
  ['hk-1m-lmt1000', '116.00700', 1, 1000],
  ['hk-1m-lmt5000', '116.00700', 1, 5000],
]) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${lmt}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
  const rec = { probe: 'eastmoney', label, url, httpStatus: null, bars: 0, first: null, last: null, days: 0, upstreamLmt: null, note: '' }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); rec.httpStatus = r.status
    const p = j(await r.text())
    rec.upstreamCode = p?.rc; rec.upstreamLmt = p?.data?.klines?.length
    const rows = p?.data?.klines
    if (Array.isArray(rows)) { rec.bars = rows.length; rec.first = rows[0]; rec.last = rows.at(-1); rec.days = new Set(rows.map(x => String(x).slice(0,10))).size }
    else rec.note = 'no klines array; ' + JSON.stringify(p).slice(0,150)
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.B.push(rec)
}

// C: xysz
for (const [label, limit] of [['1m-1000',1000],['1m-5000',5000]]) {
  const url = `https://api.xyszdata.com/api/v1/klines?symbol=600519.SH&interval=1m&limit=${limit}`
  const rec = { probe: 'xysz', label, url, httpStatus: null, bars: 0, note: '', bodyHead: '' }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); rec.httpStatus = r.status
    const t = await r.text(); rec.bodyHead = t.slice(0, 300)
    const p = j(t)
    const rows = p?.data?.klines ?? p?.klines ?? (Array.isArray(p?.data) ? p.data : null)
    if (Array.isArray(rows)) { rec.bars = rows.length; rec.first = rows[0]; rec.last = rows.at(-1) }
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.C.push(rec)
}
console.log(JSON.stringify(out, null, 2))
