const out = { ranAt: new Date().toISOString(), EM: [], YH: [], OKX: [] }
const j = (t) => { try { return JSON.parse(t) } catch { return null } }
// A: eastmoney klt=1 with end anchored to past trading days
for (const [label, secid, end] of [
  ['cn-1m-end20261013','1.600519','20261013'],
  ['cn-1m-end20261012','1.600519','20261012'],
  ['hk-1m-end20261013','116.00700','20261013'],
  ['cn-1m-end20261009','1.600519','20261009'],
]) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=1&fqt=1&lmt=1000&end=${end}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
  const rec = { label, end, url, httpStatus: null, bars: 0, first: null, last: null, note: '' }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); rec.httpStatus = r.status
    const p = j(await r.text()); const rows = p?.data?.klines
    if (Array.isArray(rows)) { rec.bars = rows.length; rec.first = String(rows[0]).slice(0,60); rec.last = String(rows.at(-1)).slice(0,60) }
    else rec.note = 'no klines; ' + JSON.stringify(p).slice(0,120)
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.EM.push(rec)
}
// A2: eastmoney trends2 with ndays>1 (multi-day intraday?)
for (const ndays of [1, 5]) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=116.00700&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=${ndays}&iscr=0`
  const rec = { probe: 'trends2', ndays, url, httpStatus: null, bars: 0, first: null, last: null, days: 0, note: '' }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); rec.httpStatus = r.status
    const p = j(await r.text()); const rows = p?.data?.trends
    if (Array.isArray(rows)) { rec.bars = rows.length; rec.first = String(rows[0]).slice(0,40); rec.last = String(rows.at(-1)).slice(0,40); rec.days = new Set(rows.map(x => String(x).slice(0,10))).size }
    else rec.note = 'no trends'
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.EM.push(rec)
}
// B: yahoo 1m range=7d (both AAPL and a second symbol)
for (const [sym, range] of [['AAPL','7d'],['AAPL','1mo'],['MSFT','7d']]) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=${range}`
  const rec = { sym, range, url, httpStatus: null, bars: 0, first: null, last: null, days: 0, metaError: null, note: '' }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); rec.httpStatus = r.status
    const t = await r.text(); const p = j(t)
    rec.metaError = p?.chart?.error ? JSON.stringify(p.chart.error).slice(0,200) : null
    const res = p?.chart?.result?.[0]
    const ts = res?.timestamp
    if (Array.isArray(ts)) {
      const closes = res?.indicators?.quote?.[0]?.close ?? []
      const nonNull = ts.filter((_, i) => closes[i] !== null && closes[i] !== undefined)
      rec.barsRaw = ts.length; rec.bars = nonNull.length
      rec.first = new Date(ts[0]*1000).toISOString(); rec.last = new Date(ts.at(-1)*1000).toISOString()
      rec.days = new Set(ts.map(s => new Date(s*1000).toISOString().slice(0,10))).size
    } else rec.note = 'no timestamp array; head=' + t.slice(0,150)
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.YH.push(rec)
}
// C: okx 1m single request cap
for (const limit of [100, 300, 301, 1000]) {
  const url = `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1m&limit=${limit}`
  const rec = { probe: 'okx', limit, url, httpStatus: null, code: null, bars: 0, first: null, last: null, note: '' }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); rec.httpStatus = r.status
    const p = j(await r.text()); rec.code = p?.code; rec.msg = p?.msg
    const rows = p?.data
    if (Array.isArray(rows)) { rec.bars = rows.length; const t = rows.map(x => Number(x[0])); rec.newest = new Date(Math.max(...t)).toISOString(); rec.oldest = new Date(Math.min(...t)).toISOString() }
    else rec.note = 'no data'
  } catch (e) { rec.note = 'err ' + String(e.message ?? e) }
  out.OKX.push(rec)
}
console.log(JSON.stringify(out, null, 2))
