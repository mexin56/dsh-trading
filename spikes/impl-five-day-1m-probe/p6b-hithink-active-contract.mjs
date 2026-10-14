const KEY = process.env.HITHINK_API_KEY
const BASE = 'https://fuyao.aicubes.cn'
const call = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-api-key': KEY ?? '' }, body: JSON.stringify(body) })
  const t = await r.text(); let p; try { p = JSON.parse(t) } catch { p = null }
  return { httpStatus: r.status, code: p?.code, msg: p?.message ?? p?.msg, data: p?.data, bodyHead: t.slice(0, 200) }
}
const out = { ranAt: new Date().toISOString(), search: null, daily: null, intraday: null }
const s = await call('/api/meta/tickers/search', { q: '螺纹', asset_type: 'futures', limit: 5 })
out.search = { httpStatus: s.httpStatus, code: s.code, msg: s.msg, items: (s.data?.item ?? []).slice(0, 5).map(i => ({ thscode: i.thscode, name: i.name })), bodyHead: s.bodyHead }
const code = out.search.items[0]?.thscode
if (code) {
  const d = await call('/api/futures/prices/daily', { thscode: code })
  out.daily = { thscode: code, httpStatus: d.httpStatus, code: d.code, msg: d.msg, points: (d.data?.item ?? []).length, first: d.data?.item?.[0], last: d.data?.item?.at?.(-1), bodyHead: d.bodyHead }
  const i = await call('/api/futures/prices/intraday', { thscode: code, session: 'intraday' })
  const item = i.data?.item ?? []
  out.intraday = { thscode: code, httpStatus: i.httpStatus, code: i.code, msg: i.msg, points: item.length, first: item[0], last: item.at?.(-1), days: new Set(item.map(x => new Date(x.timestamp).toISOString().slice(0,10))).size, bodyHead: i.bodyHead }
}
console.log(JSON.stringify(out, null, 2).slice(0, 4000))
