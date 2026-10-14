const out = { ranAt: new Date().toISOString(), T2: [], TENC: [], OKXH: [] }
const j = (t) => { try { return JSON.parse(t) } catch { return null } }
const UA = { 'User-Agent': 'Mozilla/5.0' }
// A: eastmoney trends2 ndays sweep (cn + hk) -> multi-day 1m depth
for (const [label, secid] of [['cn-1.600519','1.600519'],['hk-116.00700','116.00700']]) {
  for (const ndays of [1, 5, 10, 30]) {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=${ndays}&iscr=0`
    const rec = { label, ndays, url, httpStatus: null, bars: 0, days: 0, first: null, last: null, note: '' }
    try {
      const r = await fetch(url, { headers: UA }); rec.httpStatus = r.status
      const p = j(await r.text()); const rows = p?.data?.trends
      if (Array.isArray(rows)) { rec.bars = rows.length; rec.days = new Set(rows.map(x => String(x).slice(0,10))).size; rec.first = String(rows[0]).slice(0,40); rec.last = String(rows.at(-1)).slice(0,40) }
      else rec.note = 'no trends; ' + JSON.stringify(p).slice(0,120)
    } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
    out.T2.push(rec)
  }
}
// B: tencent m1 param-form exploration (deeper history?)
for (const url of [
  'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,,800,qfq',
  'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,800',
  'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,20261008,800',
  'https://web.ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,,800',
  'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,,800,',
  'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1',
]) {
  const rec = { url, httpStatus: null, code: null, msg: null, bars: 0, days: 0, first: null, last: null, note: '' }
  try {
    const r = await fetch(url, { headers: { ...UA, Referer: 'https://gu.qq.com/' } }); rec.httpStatus = r.status
    const t = await r.text(); const p = j(t); rec.code = p?.code; rec.msg = p?.msg
    const rows = p?.data?.sh600519?.m1
    if (Array.isArray(rows)) { rec.bars = rows.length; rec.days = new Set(rows.map(x => String(x[0]).slice(0,8))).size; rec.first = rows[0]?.[0]; rec.last = rows.at(-1)?.[0] }
    else rec.bodyHead = t.slice(0, 160)
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.TENC.push(rec)
}
// C: okx history-candles 1m (deep pagination endpoint)
for (const limit of [300, 100]) {
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT&bar=1m&limit=${limit}`
  const rec = { limit, url, httpStatus: null, code: null, bars: 0, oldest: null, newest: null, note: '' }
  try {
    const r = await fetch(url, { headers: UA }); rec.httpStatus = r.status
    const p = j(await r.text()); rec.code = p?.code
    const rows = p?.data
    if (Array.isArray(rows)) { const t = rows.map(x => Number(x[0])); rec.bars = rows.length; rec.oldest = new Date(Math.min(...t)).toISOString(); rec.newest = new Date(Math.max(...t)).toISOString() }
    else rec.note = 'no data'
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.OKXH.push(rec)
}
console.log(JSON.stringify(out, null, 2))
