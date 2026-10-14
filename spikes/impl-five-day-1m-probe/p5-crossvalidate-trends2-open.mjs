// Cross-validate trends2 ndays=5 vs tencent mkline m1 on the same minutes (2026-10-13).
// Question: is the trends2 2nd column (open) really 0.00 for prior-day bars?
const UA = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' }
const t2 = await (await fetch('https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=1.600519&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0', { headers: UA })).json()
const tx = await (await fetch('https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,,800', { headers: UA })).json()
const em = new Map()
for (const row of t2.data.trends) { const p = String(row).split(','); em.set(p[0], p) }
const rows = tx.data.sh600519.m1
const fmt = (s) => `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}`
const out = { ranAt: new Date().toISOString(), day: '2026-10-13', compared: 0, mismatch: [], samples: [], emOpenZeroCount: 0, emOpenZeroTotal: 0 }
let n = 0
for (const r of rows) {
  const key = fmt(String(r[0]))
  if (!key.startsWith(out.day)) continue
  const e = em.get(key)
  if (!e) continue
  n++
  // tencent row: [time, open, close, high, low, volume, {}, pct]
  const txo = Number(r[1]), txc = Number(r[2]), txh = Number(r[3]), txl = Number(r[4])
  const emo = Number(e[1]), emc = Number(e[2]), emh = Number(e[3]), eml = Number(e[4])
  if (emo === 0) out.emOpenZeroCount++
  out.emOpenZeroTotal++
  if (out.samples.length < 3) out.samples.push({ key, tencent: [txo, txc, txh, txl], eastmoney_trends2: [emo, emc, emh, eml] })
  const diffs = []
  if (Math.abs(txc - emc) > 0.011) diffs.push(`close ${txc} vs ${emc}`)
  if (Math.abs(txh - emh) > 0.011) diffs.push(`high ${txh} vs ${emh}`)
  if (Math.abs(txl - eml) > 0.011) diffs.push(`low ${txl} vs ${eml}`)
  if (Math.abs(txo - emo) > 0.011) diffs.push(`open ${txo} vs ${emo}`)
  if (diffs.length) out.mismatch.push({ key, diffs })
}
out.compared = n
out.mismatchCount = out.mismatch.length
out.mismatch = out.mismatch.slice(0, 8)
console.log(JSON.stringify(out, null, 2))
