# connector-polymarket 真实网络证据与网页抽查（2026-10-11）

本文件是 P1 数据面实装（`@dshtrading/connector-polymarket`）的现场证据，与
[EVIDENCE.md](EVIDENCE.md)（P0 spike）配套：spike 钉判据，这里记录**实装后**的
真实请求与一次网页口径抽查。所有命令可复现，时间戳均为 UTC。

## 1. 取数请求（主路径）

```
$ date -u +%Y-%m-%dT%H:%M:%SZ
2026-10-11T01:55:19Z

$ curl -sS -A "Mozilla/5.0" -D raw/connector-live-series35.headers.txt \
    -w "HTTP=%{http_code} time=%{time_total} bytes=%{size_download}\n" \
    -o raw/connector-live-series35.json \
    "https://gamma-api.polymarket.com/events?series_id=35&closed=false&limit=100"
HTTP=200 time=0.964312 bytes=81842
content-type: application/json
cache-control: public, max-age=300
cf-cache-status: HIT
```

原始响应：`raw/connector-live-series35.json`（81842 字节）。3 场会议：

| event id | title | endDate | negRisk | markets | closed |
| --- | --- | --- | --- | --- | --- |
| 606422 | Fed Decision in October? | 2026-10-29T03:59:00Z | true | 5 | false |
| 770450 | Fed Decision in December? | 2026-12-10T04:59:00Z | true | 5 | false |
| 770451 | Fed Decision in January? | 2027-01-28T04:59:00Z | true | 5 | false |

## 2. 失败路径（真实 403）

```
$ curl -sS -A "Python-urllib/3.11" -D raw/connector-live-403.headers.txt \
    -w "HTTP=%{http_code} bytes=%{size_download}\n" -o raw/connector-live-403.txt \
    "https://gamma-api.polymarket.com/events?series_id=35&closed=false&limit=5"
HTTP=403 bytes=17
content-type: text/plain; charset=UTF-8
server: cloudflare
body: error code: 1010
```

**关键**：响应体是 `text/plain` 的 17 字节 `error code: 1010`，**不是 JSON**、也不是空数组。
实装据此把 4xx 判为 `TRADING_UPSTREAM_ERROR`（消息带状态码与该片段），
绝不回落成「没有会议」。用例见 `packages/connector-polymarket/test/gamma.test.ts`
与 `test/service.test.ts` 的 403 路径。

## 3. UA 矩阵（实装选自有 UA 的依据）

```
$ for ua in ...; do curl -sS -A "$ua" -o /dev/null -w '%{http_code}' "..."; done
HTTP=200  UA=Mozilla/5.0
HTTP=200  UA=Mozilla/5.0 (compatible; dsh-trading-connector-polymarket)
HTTP=200  UA=dsh-trading-connector-polymarket/0.6.1
HTTP=403  UA=Python-urllib/3.11
```

落盘 `raw/connector-live-ua-matrix.txt`。实装固定发送 `dsh-trading-connector-polymarket/0.6.1`
——**取自有标识而不是伪造浏览器 UA**：请求语义诚实，且仍落在 200 的集合内。

## 4. CDN 缓存与 cache-bust

```
--- series_id=35&closed=false&limit=100
cache-control: public, max-age=300
cf-cache-status: HIT
--- series_id=35&limit=100&_cb=1791684236
cache-control: public, max-age=300
cf-cache-status: MISS
```

任意 query 变化即回源。实装默认**不加** cache-bust（面板轮询间隔离不开 5 分钟时缓存
是有益去重），需要真实时值时由调用方显式打开（`listFomcMeetings({ cacheBust: true })`）。

## 5. 口径抽查：与 Polymarket 网页对照（验收要求）

抽查对象 = December 会议（event id 770450）。网页是客户端渲染，但**服务端 SSR 载荷里
已经带全五档价格**，所以两次抓取都有用：静态 HTML 取原始 payload，headless Chrome 取
渲染后的用户可见文本。

```
$ curl -sS -L -A "Mozilla/5.0 (...) Chrome/124.0 Safari/537.36" \
    -o raw/connector-web-december.html \
    "https://polymarket.com/event/fed-decision-in-december-20260729232808632"
HTTP=200 bytes=1096110 type=text/html
```

网页 SSR 载荷（`"groupItemTitle"` 与 `"outcomePrices"` 配对，逐档）：

```
('50+ bps decrease', '0.004', bid 0.003, ask 0.004)
('25 bps decrease',  '0.013', bid 0.012, ask 0.013)
('No change',        '0.23',  bid 0.22,  ask 0.23)
('25 bps increase',  '0.75',  bid 0.74,  ask 0.75)
('50+ bps increase', '0.03',  bid 0.029, ask 0.03)
```

对照连接器取数（`raw/connector-live-series35-recheck.json`，2026-10-11T04:32Z 带
cache-bust 复核，与 01:55Z 首次取数**逐值相同**——说明差异不是采样时刻造成的）：

| 档位 | gamma mid（连接器口径） | bestBid | bestAsk | 网页显示 |
| --- | --- | --- | --- | --- |
| 50+ bps decrease | 0.0035 | 0.003 | 0.004 | **0.004** |
| 25 bps decrease | 0.0125 | 0.012 | 0.013 | **0.013** |
| No change | 0.225 | 0.22 | 0.23 | **0.23** |
| 25 bps increase | 0.745 | 0.74 | 0.75 | **0.75** |
| 50+ bps increase | 0.0295 | 0.029 | 0.03 | **0.03** |

**实测结论（与 P0 spike 的表述有出入，如实记录）**：

1. **网页显示的是 `bestAsk`（买 Yes 价），不是 gamma `outcomePrices`（= mid）**。
   5/5 档位精确等于 ask；最大偏差 0.005（No change 档：mid 0.225 vs 网页 0.23，
   差半个 tick）。渲染后的可见文本同源，读作 `25 bps increase 75%`、`无变化 23%`、
   `50+ bps increase 2.9%`、`25 bps decrease 1.3%`、`50+ bps decrease <1%`。
2. **P0 spike Q2 的等价结论本身仍然成立**：gamma `outcomePrices[0]` 与 CLOB midpoint
   在 15/15 档位完全相等（本文件 §6 再复核一次）。**但那说的是 gamma 与 CLOB 之间的关系，
   不等于「gamma 等于网页显示值」**——spike 没有做网页侧的口径抽查，那一条由本次补上。
3. 偏差量级 = 半个 spread（网页取 ask、连接器取 mid），**不是数据错误**，是口径选择差异。

### 5.1 决定性反例：January 会议（宽价差，排除「四舍五入」解释）

December 的偏差最大只有半个 tick，理论上还能被解释成「网页把 mid 四舍五入到 tick」。
January 会议提供了一个**能区分两种解释**的档位：`25 bps decrease` 的价差是 **12 个 tick**
（bid 0.016 / ask 0.028 / tick 0.001，mid = 0.022）。

```
$ curl -sS -L -A "Mozilla/5.0 (...) Chrome/124.0 Safari/537.36" \
    -o raw/connector-web-january.html \
    "https://polymarket.com/event/fed-decision-in-january-20260729233815502"
HTTP=200 bytes=1048500
```

网页 sidebar 载荷（`groupItemTitle` / `outcomePrices` / `bestBid` / `bestAsk`）：

```
('50+ bps decrease', 0.008, 0.007, 0.008)
('25 bps decrease',  0.028, 0.016, 0.028)   <-- mid 0.022, 差 6 个 tick
('No change',        0.66,  0.65,  0.66)
('25 bps increase',  0.32,  0.31,  0.32)
('50+ bps increase', 0.017, 0.015, 0.017)
```

- 若网页显示 mid：该档应为 0.022；实测 **0.028 = bestAsk**。
- 网页自己内嵌的 bestBid/bestAsk 与 gamma 取数**逐值相等**（0.016 / 0.028），
  说明两者是同一份盘口，差异只在**取哪一侧**。
- 12 个 tick 的偏差无法用舍入解释 ⇒ **结论确定：网页显示 `bestAsk`**。

**对 v1 的处置（不扩本次范围）**：本次不改变量口径——`outcomePrices` 是与 CLOB
数值等价的干净口径，且一次请求拿全量；改成 `bestAsk` 会把展示值绑定到单侧盘口
（spread 宽时更偏），且结算后 `bestAsk` 残留 0.001 而 `bestBid` 为 null，
反而需要分支处理（证据 Q4.3）。因此：

- 连接器继续下发 `probability`（= mid 口径）**并同时下发 `bestBid` / `bestAsk`**，
  面板若要与网页数字逐字一致可直接用 `bestAsk`，口径选择留在展示层；
- 差异作为**已实测事实**记入本文件与 Agent Note，避免下一位读者把「与网页差半 tick」
  误判成取数 bug。

## 6. CLOB 交叉核对（口径等价的现场复核）

同一场会议的 5 个 `clobTokenIds` 批量查 midpoint：

```
$ curl -sS -A "Mozilla/5.0" -X POST -H 'Content-Type: application/json' \
    -d '[{"token_id":"..."}, ...]' "https://clob.polymarket.com/midpoints"
HTTP=200
{"1116621296...":"0.745","1764059686...":"0.0035","3509025440...":"0.0295",
 "4286572874...":"0.225","7736744884...":"0.0125"}
```

落盘 `raw/connector-live-clob-midpoints.json`。与 gamma `outcomePrices[0]` 的
0.745 / 0.0035 / 0.0295 / 0.225 / 0.0125 **逐档相等**（复核 P0 spike Q2 的等价结论在当前
时刻仍然成立）。

## 7. 实装判据与 spike 的对应

| spike 判据 | 实装位置 |
| --- | --- |
| L0 `series_id=35` | `gamma.ts` 的 `query.series_id` |
| L1 `series[].id === "35"` | `discovery.ts` `hasSeries` |
| L2 标题正则（现代 + legacy） | `discovery.ts` `TITLE_MODERN` / `TITLE_LEGACY` |
| L3 `negRisk` + 档位数 4..6 | `discovery.ts` `MIN_BUCKETS` / `MAX_BUCKETS` |
| L4 噪声清单 | `discovery.ts` `NOISE_SLUGS` |
| L5 按 id 去重 + endDate 升序 | `discovery.ts` `discoverFomcMeetings` |
| 档位标签归一化 | `discovery.ts` `canonicalBucket` |
| 概率取 `outcomePrices[0]` | `discovery.ts` `parseOutcomePrices` |
| 不用 `active` 判可交易 | `parseBucket` 的 `acceptingOrders` / `closed` |
| 结算后 `bestBid=null` 不落成 0 | `parseBucket` 的 `num()` + 条件展开 |
| 概率和正常区间 [0.98, 1.03] | `PROBABILITY_SUM_MIN` / `PROBABILITY_SUM_MAX` |

## 文件清单

| 文件 | 内容 |
| --- | --- |
| raw/connector-live-series35.json | 主路径原始响应（81842 字节，3 场会议） |
| raw/connector-live-series35.headers.txt | 同上响应头（cache-control / cf-cache-status） |
| raw/connector-live-403.txt、.headers.txt | 403 失败路径原始响应（text/plain 的 1010） |
| raw/connector-live-ua-matrix.txt | UA 矩阵逐条状态码 |
| raw/connector-live-clob-midpoints.json | CLOB midpoint 批量核对响应 |
| raw/connector-web-december.html | 网页静态 SSR HTML（含五档 outcomePrices/bestBid/bestAsk，口径对照主依据） |
| raw/connector-web-december-rendered.html | headless Chrome 渲染后 DOM（用户可见文本：75%/23%/2.9%/1.3%/<1%） |
| raw/connector-web-january.html | January 会议 SSR 载荷（12 tick 宽价差，决定性排除舍入解释） |
