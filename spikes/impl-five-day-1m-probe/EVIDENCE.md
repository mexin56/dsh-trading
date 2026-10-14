# Spike 证据：最近 5 个交易日 1 分钟 K 线在各市场当前路由下的可得性

探针日期：2026-10-14（Asia/Shanghai 上午盘，cn/hk 当日未收盘，故「当日」计数为 09:30–09:56 的部分会话）。
所有数字均为真实网络响应；上游不可达处如实标 unknown 并注明是哪一层。

预算纪律：单路串行探针，未跑 gates/build/全仓测试，未改动 packages/ 下任何文件。

## 复现命令

```bash
cd /Users/zcl/code/dsh-trading
node spikes/impl-five-day-1m-probe/p1-tencent-m1.mjs                 # 腾讯 mkline tf=m1/m5 × sh600519/sz000001/hk00700
node spikes/impl-five-day-1m-probe/p1b-tencent-m1-depth.mjs          # 腾讯 m1 上游深度上限（1000..10000）
node spikes/impl-five-day-1m-probe/p2-border-and-cn-alts.mjs         # 腾讯 800/801/900/1200/1600 边界 + 东财 klt=1 + xysz
node spikes/impl-five-day-1m-probe/p3-eastmoney-pastday-and-yahoo.mjs # 东财 klt=1 过去日期 + 东财 trends2 ndays + 雅虎 1m + OKX 1m
node spikes/impl-five-day-1m-probe/p4-trends2-and-tencent-forms.mjs  # trends2 ndays 1/5/10/30 + 腾讯 param 形态 + OKX history-candles
node spikes/impl-five-day-1m-probe/p5-crossvalidate-trends2-open.mjs # trends2 与腾讯 m1 同日同分钟逐根交叉验证
HITHINK_API_KEY=<profile 内已配置> node spikes/impl-five-day-1m-probe/p6-hithink-futures-intraday.mjs
HITHINK_API_KEY=<...>             node spikes/impl-five-day-1m-probe/p6b-hithink-active-contract.mjs
HITHINK_API_KEY=<...>             node spikes/impl-five-day-1m-probe/p7-hithink-daily-control.mjs
HITHINK_API_KEY=<...> JIN10_TOKEN=<...> node spikes/impl-five-day-1m-probe/p8-hithink-retry-and-jin10.mjs
JIN10_TOKEN=<...>                 node spikes/impl-five-day-1m-probe/p9-jin10-count-cap.mjs
```

原始响应落盘：`p1-*.raw.json` `p1b-*.raw.json` `p2-*.raw.json` `p3-*.raw.json` `p4-*.raw.json` `p5-*.raw.json` `p6-*.raw.json` `p6b-*.raw.json` `p8-*.raw.json`（p7/p9 输出见本文件正文）。

## 1. 腾讯 mkline 是否支持 tf=m1 —— 支持（沪/深），不支持港股

| 请求 | HTTP | code | bars | first | last | days |
|---|---|---|---|---|---|---|
| `ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,,800` | 200 | 0 | 800 | 202610081410 | 202610140955 | 5 |
| `...param=sz000001,m1,,800` | 200 | 0 | 800 | 202610081409 | 202610140954 | 5 |
| `...param=sh600519,m5,,800`（对照） | 200 | 0 | 800 | 202609111120 | 202610140955 | 17 |
| `...param=hk00700,m1,,800` | 200 | -1 | 0 | - | - | msg `param error` |
| `...param=hk00700,m5,,800` | 200 | -1 | 0 | - | - | msg `param error` |
| `...param=r_hk00700,m1,,10` | 200 | -1 | 0 | - | - | msg `param error` |

行结构与 m5 同构（`[YYYYMMDDHHmm, 开, 收, 高, 低, 量, {}, 涨跌幅]`），因此 connector 现成的
`minuteKlineTimeToEpochMs` 可直接解析（12 位紧凑时间），不需要新解析器。

上游深度上限 = **800 根**，且**超限静默降级到 320 根**（不是报错）：

| count | bars | first | days |
|---|---|---|---|
| 800 | 800 | 202610081410 | 5 |
| 801 | 320 | 202610121408 | 3 |
| 900 | 320 | 202610121408 | 3 |
| 1200 | 320 | 202610121408 | 3 |
| 1600 | 320 | 202610121408 | 3 |

没有游标：`param=sh600519,m1,,800,qfq` 仍 800 根（说明第 5 段被忽略）；`param=sh600519,m1,800`、
`param=sh600519,m1,20261008,800` 返回 0 根（无 data.sh600519.m1 数组）；`param=sh600519,m1`（3 段）返回 482 根。

## 2. cn 当前路由 cap

`packages/connector-tencent/src/rest.ts:150-156` — `INTERVAL_TO_TENCENT` 只有 5m/30m/1d/1w/1M；
`:724-736` 未映射即抛 `TRADING_UNSUPPORTED_INTERVAL`，且 hk + 分钟端点显式拒绝；
`:737` `Math.min(limit, 800)`。桥：`packages/bot-api/src/bridge.ts:215` `MAX_KLINE_LIMIT = 1000`，
`:800-801` 仅校验请求参数（1..1000），**不截断返回**。

⇒ cn 走腾讯拿 1m 今天直接报不支持的 interval；即便补上 m1 映射，单请求最多 800 根 ≈ 3.3 个交易日
（实测每交易日 241 根，5 日需 ≈ 1205 根），且无翻页手段 → **结构性不足，与 cap 调参无关**。

## 3. 东财（cn/hk 替代源）

### klt=1 走 kline/get：只有当日，`lmt` 与 `end` 均被忽略

| 请求 | bars | first | 说明 |
|---|---|---|---|
| `.../kline/get?secid=1.600519&klt=1&lmt=1000&end=20500101` | 25 | 2026-10-14 09:31 | 当日 |
| 同上 `lmt=5000` | 25 | 2026-10-14 09:31 | lmt 无效 |
| 同上 `end=20261013` / `end=20261012` / `end=20261009` | 25 | 2026-10-14 09:31 | end 无效，仍为当日 |
| `secid=116.00700&klt=1&lmt=1000`（hk） | 25 | 2026-10-14 09:31 | 当日 |
| `secid=1.600519&klt=5&lmt=1000`（对照） | 1000 | 2026-09-07 10:40 | 5m 有深历史 |

### trends2 `ndays` 是唯一的多日 1m 通道，但 open 列坏

| 标的 | ndays | bars | days | first | last |
|---|---|---|---|---|---|
| 1.600519 | 1 | 26 | 1 | 2026-10-14 09:30 | 2026-10-14 09:56 |
| 1.600519 | 5 | 991 | 5 | 2026-10-08 09:30 | 2026-10-14 09:56 |
| 1.600519 | 10 | 0 | - | - | `rc:1`（无数据/参数非法） |
| 116.00700 | 1 | 27 | 1 | 2026-10-14 09:30 | 2026-10-14 09:56 |
| 116.00700 | 5 | 1351 | 5 | 2026-10-08 09:30 | 2026-10-14 09:56 |
| 116.00700 | 10 | 0 | - | - | `rc:1` |

⇒ ndays 上限 5；cn 每日 241 根、hk 每日 331 根（实测），5 日窗口在「当日已收盘」的自然日应为
cn≈1205 / hk≈1655，本次因当日盘中只到 991 / 1351。

**关键数据质量缺陷（逐根交叉验证）**：ndays>1 时，**非当日的每一根 bar 的第 2 列（开）都是 0.00**。

```
cn ndays=5，逐日 zeroOpenBars：
  2026-10-08 n=241 zeroOpenBars=241
  2026-10-09 n=241 zeroOpenBars=241
  2026-10-12 n=241 zeroOpenBars=241
  2026-10-13 n=241 zeroOpenBars=241
  2026-10-14 n=27  zeroOpenBars=0        ← 只有当日有真实开价
hk ndays=5：2026-10-08/09/12/13 各 331 根全部 zeroOpenBars=331，当日 27 根为 0
```

与腾讯 m1 在 2026-10-13 逐根对齐（`p5`，241 根全部比对）：241/241 根 `open` 不一致
（东财 0 vs 腾讯真实开价），close 一致，high/low 有 ≤0.48 的舍入级差异：

```
2026-10-13 09:31  tencent [open 1285, close 1285, high 1287.74, low 1280.18]
                  eastmoney_trends2 [open 0, close 1285, high 1287.8, low 1280.14]
2026-10-13 09:32  tencent [1285.01, 1286.13, 1288, 1282.36]
                  eastmoney_trends2 [0, 1286.13, 1288.48, 1282.36]
```

⇒ trends2 ndays=5 **不是诚实的 5 日 1m OHLC**：可用于 close/volume 与（近似）high/low，
开盘价只能由「同日前一根 close」重建，属派生值而非取数。

connector-eastmoney 现状：`rest.ts:296-300` 仅 hk 1m 走 trends2 且 `ndays=1`（当日）；
cn 1m 走 `kline/get klt=1`（当日）。`rest.ts:369` 有 `slice(-limit)`。

## 4. xysz（cn 替代源）—— 本环境不可达

`connector-xysz` 的 `apiUrl` 默认 `http://127.0.0.1:8191`（`rest.ts:168`，可被 `XYSZ_API_URL` 覆盖），
是本地/局域网 sidecar（`index.ts:42` 注释：局域网 192.168.31.50:8191 或 SSH 隧道）。

```
curl -s -m 4 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8191/health   → 000（无进程监听）
node p2（api.xyszdata.com / api.xysz* 公网域名直连）                          → fetch failed（无此公网入口）
```

`connector-xysz/src/rest.ts:230-233`：`GET /api/v1/klines?symbol&interval&limit`，`limit` 原样透传、
连接器侧无 cap。历史证据 `spikes/impl-xysz/r3-klines-1m.raw.json`（2026-09-28）显示 1m 返回
`{symbol, interval, count, klines[]}`，当时以 count=60 取数 —— **单请求上限未知**（本次 sidecar 未运行，
标 unknown：不可达层 = 本地 sidecar）。

## 5. us / yahoo —— 1m 7 天窗口，2730 根，≥1950 ✓

| 请求 | HTTP | 非空 bars | first | last | sessions |
|---|---|---|---|---|---|
| `chart/AAPL?interval=1m&range=7d` | 200 | 2730（raw 2731，1 根 null） | 2026-10-05T13:30:00Z | 2026-10-13T20:00:00Z | 7 |
| `chart/MSFT?interval=1m&range=7d` | 200 | 2730 | 同上 | 同上 | 7 |
| `chart/AAPL?interval=1m&range=1mo` | 422 | 0 | - | - | 上游原文：`1m data not available for startTime=1789264484 and endTime=1791942884. Only 8 days worth of 1m granularity data are allowed to be fetched per request.` |

⇒ 上游 1m 窗口上限 8 天；`range=7d` 覆盖 7 个会话 ≈ 2730 根 > 1950（5 会话）。

本仓侧：`connector-yahoo/src/rest.ts:91-92` `RANGE_BY_INTERVAL` 1m→7d；`:270` `getKlines(symbol, interval)`
**没有 limit 形参**，`:272-277` 返回整窗口（注释明说「由服务层按 limit 截尾」，但服务层就是 connector 实例，
桥侧只做参数校验不做 slice）→ 请求 `limit=1000` 实际拿到 2730 根。
（此条为代码路径推导：`bridge.ts:805` → `MARKET_SERVICE_KEYS` 取到的正是 connector 服务实例
（`bot-api/src/index.ts:221`，`bridge.ts:59-66`），中间没有截断层。未起宿主实测。）

## 6. crypto / okx

| 请求 | HTTP | code | bars | oldest | newest |
|---|---|---|---|---|---|
| `/api/v5/market/candles?instId=BTC-USDT&bar=1m&limit=100` | 200 | 0 | 100 | 2026-10-14T00:15Z | 2026-10-14T01:54Z |
| `...limit=300` | 200 | 0 | 300 | 2026-10-13T20:55Z | 2026-10-14T01:54Z |
| `...limit=301` | 200 | 0 | **300** | 同上 | 同上 |
| `...limit=1000` | 200 | 0 | **300** | 同上 | 同上 |
| `/api/v5/market/history-candles?bar=1m&limit=300` | 200 | 0 | 300 | 2026-10-13T20:56Z | 2026-10-14T01:55Z |

⇒ 单请求上游上限 **300**（超限静默截到 300）。

本仓侧：`connector-okx/src/rest.ts:675-721` 已实现 `after` 游标翻页（每页 min(剩余,300)），
但 `:679-680` 限制 `limit ∈ 1..1000`；桥 `MAX_KLINE_LIMIT=1000` 同样封顶。

5 天 1m = 5×1440 = **7200 根** → 需要 24 次上游请求（300/页）。
当前参数空间下最多 1000 根 ≈ 16.7 小时 → **不可得**；翻页机制已就位，瓶颈纯在两层 cap。

## 7. futures / hithink

结构性（代码）：`connector-hithink/src/futures.ts:107-122` 分钟周期一律走
`getFuturesIntraday(thscode)`（`/api/futures/prices/intraday`）后本地聚合，模块注释明确
「上游仅提供当日分时，分钟线不覆盖历史交易日」。`MINUTE_INTERVAL_STEPS` 含 `1m: 1`。

上游（真实请求，key 取自 trading-web profile 的 `credentials.hithink.apiKey`）：

```
POST https://fuyao.aicubes.cn/api/meta/tickers/search  {"q":"螺纹","asset_type":"futures","limit":5}
POST https://fuyao.aicubes.cn/api/futures/prices/daily   {"thscode":"RB00.SHF"}
POST https://fuyao.aicubes.cn/api/futures/prices/intraday{"thscode":"RB00.SHF","session":"intraday"}
POST .../intraday {"thscode":"IF2603.CFE"} / {"thscode":"RB2605.SHF"} / {"thscode":"AU2612.SHF"} / {"thscode":"CL2612.NYMEX"}
```

全部 HTTP 200 + `{"code":5001,"message":"Internal server error","request_id":"..."}`（无 401/403，说明 key 通过），
即 **上游 fuyao.aicubes.cn 当前整体不可用**（含 meta/tickers/search）；`spikes/impl-hithink-kline-futures/EVIDENCE/`
有 2026-09-12 的成功原文（`RB00.SHF` daily/intraday，当日 `date: 2026-09-14`）。
⇒ futures 1m：**unknown（不可达层 = 上游）**，且即便恢复也只有当日分时 → 5 日历史结构性不可得。

## 8. global / jin10

MCP 握手成功（`https://mcp.jin10.com/mcp`，token 取自 profile）：
`initialize` 200，`protocolVersion: 2025-06-18`，serverInfo `jin10-mcp 1.0.0`（金十数据智能开放平台）。

`tools/call get_kline`（真实请求）：

| 参数 | status | bars | 说明 |
|---|---|---|---|
| `{code:XAUUSD, time: now-3600, count:100}` | 200 | 100 | 正常 |
| `{... count:300}` | 200 | 100 | 静默截到 100 |
| `{... count:1000}` | 200 | 100 | 静默截到 100 |
| `{code:XAUUSD, time: now-5d, count:100}` | 200 | **0** | 5 天前无任何 bar（无深历史） |

bar 结构 `{time, open, high, low, close, volume}`（字符串价格）。
本仓侧 `connector-jin10/src/market-data.ts:24-27` `MINUTE_BARS_PER_CALL=100` / `MAX_MINUTE_WINDOW=300`，
`:151-153` `wanted = min(limit, 300/minutes)` → 1m 最多 300 根；`:124` 最多 3 次上游调用。

⇒ global 1m 最多 300 根（≈5 小时）；5 天 7200 根 → 不可得，且上游 `time-5d` 直接返回空。

## 9. 桥与连接器的 cap 分层

`packages/bot-api/src/bridge.ts:215` `MAX_KLINE_LIMIT = 1000`；`:794-806` `klines()` 只把 limit 校验在
1..1000 并 `service.getKlines(symbol, interval, limit)` 透传 —— **是请求参数闸门，不是返回截断**。
因此「桥 1000 上限」只在需要大 limit 触发连接器自翻页（okx 7200）时才构成阻塞；
对一次性窗口类连接器（yahoo/eastmoney）它不截断输出，但也因此**无法表达「我要 5 日 1m」的契约**。
