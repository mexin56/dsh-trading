# ccxt quote 按所普查 + K 线九所 · 真实网络原始响应证据（2026-10-15 本卡）

- 结论绑 commit：`a0c352f76655a4cbd3cfa3982afb6e765638b7fb`（探针启动时现场 `git rev-parse HEAD`）。
- 实现指纹（`git hash-object`，探针启动时现场取值；工作树尚未提交，指纹是第二把锁）：
  `packages/connector-ccxt/src/rest.ts` = `b682898edecdef9486827c0acad54772e4c7da75`、
  `packages/connector-ccxt/src/index.ts` = `03fba6de7584d04bd82f94595d90a052dd1b7f64`、
  `packages/api/src/index.ts` = `3d58dc586ba088219b31f9c5f125b3837277954a`。
- 抓取时刻：2026-10-15T02:13Z（quote 普查）– 02:35Z（周期普查）；探针 2026-10-15T02:22:21Z。
- 工作树：探针现场 `git status --porcelain` 38 行，全部属于其它会话/在飞改动；本目录新增文件与
  `packages/connector-ccxt/**`、`packages/api/src/index.ts` 的改动属于本卡。
- 上一轮（九所 ticker 端点层）的证据在同目录 [EVIDENCE.md](EVIDENCE.md)；本文件只覆盖本卡新增的
  三类事实：**A. 各所 quote 资产普查**、**C. K 线九所端点与周期映射**、以及两者的连接器级实跑。

## 0. 一句话

七条形态变换分支各有一份 quote 资产表，表内容 = 该所公开挂牌端点的逐所普查结果（8 份原始响应，
5.1 MB）；K 线端点从单分支扩到九所（9 份原始响应），周期映射按 9 所 × 9 档做成 81 条组合的实测矩阵
（`interval-sweep.tsv`，5 条上游 400 原文单独归档）；连接器级探针 **退出码 0、63/63 判据 PASS**。

## 1. 出口说明

| 时刻 | `Proxies` 组 `now` | `api.ipify.org`（直连） | `api.ipify.org`（`-x http://127.0.0.1:7890`） |
|---|---|---|---|
| 探针启动前 | `US` | 216.195.208.136 | — |
| 窗口内（SG） | `SG` | 188.253.121.148 | 188.253.121.148 |
| 还原后 | `US` | 216.195.208.136 | — |

- 控制器 unix socket `/var/run/clash-verge-service/users/501/verge-mihomo.sock`，`PUT /proxies/Proxies`
  返回 204；窗口只覆盖 binance / bybit（默认出口对这两所仍是 451 / 403，原始响应见 EVIDENCE.md）。
- 本机 mihomo 是 TUN 模式：窗口内**直连也走 SG**，所以窗口内的文件一律用 `-x` 抓、出口 IP 以
  `-x` 的实测值为准。
- **还原必须实测出口 IP**：只读 selector 会因 keep-alive 复用窗口期连接而假阴性（上一轮已踩过）。
  本卡两次窗口（探针 1 次 + 周期普查 1 次）都以「selector = `US` 且直连 ipify = 216.195.208.136」复核。
- 过程事实：周期普查第一次尝试（python 直连 socket 解析控制器响应）被 `run_code` 的 120 s 程序上限
  中断，**当时 selector 停在 `SG`**（直连实测 188.253.121.148）；发现后立即 `PUT US` 并复核回
  216.195.208.136，最终一次普查改成「后台任务 + 无条件还原 wrapper（`finally` 语义）」重跑。

## 2. 原始响应清单（本卡新增；均为 `.json` 正文 + `.headers` 头，字节保真）

### 2.1 quote 普查（默认出口直连，8 份）

| 文件 | URL | HTTP | `Date` 头 | 字节 |
|---|---|---|---|---|
| `census-okx-instruments-spot` | `https://www.okx.com/api/v5/public/instruments?instType=SPOT` | 200 | 02:13:15Z | 1278095 |
| `census-kucoin-symbols-v2` | `https://api.kucoin.com/api/v2/symbols` | 200 | 02:13:17Z | 692001 |
| `census-gateio-currency-pairs` | `https://api.gateio.ws/api/v4/spot/currency_pairs` | 200 | 02:13:19Z | 1128415 |
| `census-kraken-assetpairs` | `https://api.kraken.com/0/public/AssetPairs` | 200 | 02:13:21Z | 678579 |
| `census-coinbase-products` | `https://api.exchange.coinbase.com/products` | 200 | 02:13:24Z | 355056 |
| `census-bitfinex-pairs-exchange` | `https://api-pub.bitfinex.com/v2/conf/pub:list:pair:exchange` | 200 | 02:13:25Z | 2105 |
| `census-bitfinex-currencies` | `https://api-pub.bitfinex.com/v2/conf/pub:list:currency` | 200 | 02:13:26Z | 2118 |
| `census-htx-symbols` | `https://api.htx.com/v2/settings/common/symbols` | 200 | 02:13:27Z | 1006530 |

### 2.2 K 线九所（各一份 1d；binance/bybit 经 `-x` 在 SG 窗口内取）

| 文件 | URL（连接器实际发出的那条） | 出口 | HTTP | `Date` 头 | 字节 |
|---|---|---|---|---|---|
| `klines-binance-btcusdt-1d` | `api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=5` | proxy 188.253.121.148 | 200 | 02:23:23Z | 925 |
| `klines-okx-btcusdt-1d` | `www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1Dutc&limit=5` | 直连 | 200 | 02:23:09Z | 629 |
| `klines-bybit-btcusdt-1d` | `api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=D&limit=5` | proxy | 200 | 02:23:37Z | 577 |
| `klines-gateio-btcusdt-1d` | `api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1d&limit=5` | 直连 | 200 | 02:23:10Z | 488 |
| `klines-kucoin-btcusdt-1d` | `api.kucoin.com/api/v1/market/candles?symbol=BTC-USDT&type=1day` | 直连 | 200 | 02:23:11Z | 10504 |
| `klines-kraken-btcusdt-1d` | `api.kraken.com/0/public/OHLC?pair=XBTUSDT&interval=1440` | 直连 | 200 | 02:23:12Z | 60744 |
| `klines-coinbase-btcusdt-1d` | `api.exchange.coinbase.com/products/BTC-USDT/candles?granularity=86400` | 直连 | 200 | 02:23:12Z | 21227 |
| `klines-bitfinex-btcusdt-1d` | `api-pub.bitfinex.com/v2/candles/trade:1D:tBTCUST/hist?limit=5` | 直连 | 200 | 02:23:13Z | 262 |
| `klines-htx-btcusdt-1d` | `api.htx.com/market/history/kline?symbol=btcusdt&period=1day&size=5` | 直连 | 200 | 02:23:14Z | 822 |

### 2.3 上游「不支持周期」原文（6 份）

| 文件 | 请求参数 | HTTP | 正文（完整） |
|---|---|---|---|
| `negative-interval-coinbase-30m` | `granularity=1800` | **400** | `{"message":"Unsupported granularity"}` |
| `negative-interval-coinbase-4h` | `granularity=14400` | **400** | 同上 |
| `negative-interval-coinbase-1w` | `granularity=604800` | **400** | 同上 |
| `negative-interval-coinbase-1M` | `granularity=2592000` | **400** | 同上 |
| `negative-interval-gateio-1M` | `interval=1M` | **400** | `{"label":"INVALID_PARAM_VALUE","message":"Error: invalid interval 1M"}` |
| `negative-interval-kucoin-1M` | `type=1mon` | 200 | `{"msg":"Incorrect candlestick type.","code":"400100"}`（业务错误码，HTTP 仍 200） |

### 2.4 派生矩阵

- `interval-sweep.tsv` / `interval-sweep.json`：9 所 × 词汇表 9 档 = **81 条**逐档实测
  （列：exchange / interval / param / route / egressIp / http / bytes / rows / url），
  由本机 curl 在默认出口（七所）与 SG 窗口（binance/bybit，`-x`）现场跑出；
  其中 76 条 200、5 条上游 400（上表）；kucoin 的 `1mon` 是 200 + 0 行（业务错误码）。
- `probe-summary.json`：连接器级探针的 63 条判据 + 42 条请求轨迹 + 出口/指纹。

## 3. quote 普查（A）

| 所 | 端点 | 字段 / 派生规则 | 集合大小 | 派生的 quote 集合（= 代码里的表） |
|---|---|---|---|---|
| okx | `/api/v5/public/instruments?instType=SPOT` | `data[].quoteCcy`（剔除空串） | 13 | AED, AUD, BRL, BTC, ETH, EUR, PLN, SGD, SOL, TRY, USD, USDC, USDT |
| kucoin | `/api/v2/symbols` | `data[].quoteCurrency` | 10 | BTC, DOGE, ETH, EUR, KCS, TRX, USD1, USDC, USDG, USDT |
| gateio | `/api/v4/spot/currency_pairs` | `[].quote` | 8 | BTC, ETH, GUSD, RLUSD, USD, USD1, USDC, USDT |
| kraken | `/0/public/AssetPairs` | `result[*].wsname` 的 `/` 后段 | 24 | AUD, AUSD, CAD, CHF, DAI, ETH, EUR, EURC, EUROP, FIDD, GBP, JPY, PYUSD, RLUSD, SOFID, SOL, USD, USD1, USDC, USDD, USDQ, USDR, USDT, XBT |
| coinbase | `/products` | `[].quote_currency` | 13 | AUD, BRL, BTC, CAD, DAI, ETH, EUR, GBP, INR, SGD, USD, USDC, USDT |
| bitfinex | `/v2/conf/pub:list:pair:exchange` + `/v2/conf/pub:list:currency` | 最长货币后缀（`AAVE:USD` 按 `:` 分隔；`UST`→`USDT`） | 9 | BTC, ETH, EUR, GBP, TESTUSD, TESTUSDT, USD, USDT, XAUT |
| htx | `/v2/settings/common/symbols` | `data[].qcdn`（大写展示形） | 20 | BRL, BTC, ETH, EUR, EUROC, GBP, HT, HUSD, KGST, PYUSD, RUB, TRX, TRY, TUSD, UAH, USD1, USDC, USDD, USDT, USTC |

两条必须知道的普查事实：

1. **kraken 的 `quote` 字段不能用**：它是 Z/X 前缀的旧代号（`ZEUR`/`ZUSD`/`ZGBP`/`ZJPY`/`ZCAD`/`ZAUD`/`XXBT`/`XETH`），
   而请求符号用现代形（`EUR`/`USD`/`GBP`/`XBT`/`ETH`）；取 `wsname` 的 quote 段才等于上游实际接受的请求词汇
   （`XBTUSDT` / `ETHEUR` 的 200 见 `klines-kraken-btcusdt-1d` 与探针 `ticker.kraken.ETHEUR`）。
2. **bitfinex 的挂牌对有两种形态**：`AAVE:USD`（显式分隔）与 `ADAUST`（最长后缀）；`UST` 是 Tether 的
   上游写法，归一到用户写法的 `USDT`（请求侧再由 `requestSymbol` 把 `USDT` 映射回 `UST`）。

## 4. K 线九所：端点与行结构（C）

| 所 | 行结构（实测） | 量单位取哪一列 | 时间单位 | 顺序 |
|---|---|---|---|---|
| binance | `[openTime, o, h, l, c, volume, closeTime, …]`（12 字段） | `[5]` base | ms | 升序 |
| okx | `[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]` | `[5]` base | ms | 降序 |
| bybit | `[startTime, o, h, l, c, volume, turnover]` | `[5]` base | ms（字符串） | 降序 |
| gateio | `[ts, quoteVolume, close, high, low, open, baseVolume, windowClosed]` | `[6]` base（`[1]` 是计价量） | s | 降序 |
| kucoin | `[ts, open, close, high, low, volume, turnover]` | `[5]` base（`[6]` 计价） | s | 降序 |
| kraken | `result[pair] = [ts, o, h, l, c, vwap, volume, count]`，另有 `result.last` 数字 | `[6]` base | s | 升序 |
| coinbase | `[ts, low, high, open, close, volume]` | `[5]` base | s | 降序 |
| bitfinex | `[mts, open, close, high, low, volume]` | `[5]` base | ms | 降序 |
| htx | `data[].{id, open, close, low, high, amount, vol, count}`（对象数组） | `amount` base | s | 降序 |

- 连接器把它们统一切成**升序（旧→新）**、按 `openTime` 去重、只留最新 `limit` 根；
  只有 binance / kraken 的上游本来就是升序（`finalizeKlines`）。
- 单请求根数：binance/bybit/gateio `limit`（上限 1000）、okx `limit`（300）、bitfinex `limit`（10000）、
  htx `size`（2000）；kucoin/kraken/coinbase 没有根数参数——实测分别回 100/721/350 根
  （`interval-sweep.tsv` 的 rows 列），连接器在本地切成 `limit` 根，**不翻页**。

## 5. 周期映射实测（C）

映射表与支持集（`KLINE_INTERVAL_PARAMS` / `klineIntervalParam`，探针 `quote-census.*` 与
`interval-sweep.tsv` 为现场判据）：

| 所 | 上游周期参数（1m/5m/15m/30m/1h/4h/1d/1w/1M） | 不支持的档位 | 上游原文 |
|---|---|---|---|
| binance | 1m 5m 15m 30m 1h 4h 1d 1w 1M（原样） | — | — |
| okx | 1m 5m 15m 30m **1H 4H 1Dutc 1Wutc 1Mutc** | — | — |
| bybit | **1 5 15 30 60 240 D W M** | — | — |
| gateio | 1m 5m 15m 30m 1h 4h 1d **7d** | 1M | 400 `INVALID_PARAM_VALUE` |
| kucoin | **1min 5min 15min 30min 1hour 4hour 1day 1week** | 1M | 200 `{"code":"400100"}` |
| kraken | **1 5 15 30 60 240 1440 10080 21600**（分钟数） | — | — |
| coinbase | **60 300 900 3600 86400**（秒） | 30m / 4h / 1w / 1M | 400 `Unsupported granularity` |
| bitfinex | 1m 5m 15m 30m 1h 4h 1D 1W 1M | — | — |
| htx | **1min 5min 15min 30min 60min 4hour 1day 1week 1mon** | — | — |

**与卡的假设有两处出入（按实测落表，这是本卡的偏离项）**：

- 卡上写「coinbase 无 1w/1M」，实测 **30m（1800）与 4h（14400）同样回 400**，coinbase 在这个词汇表里
  只支持 1m/5m/15m/1h/1d（21600=6h 能过但不属本词汇表）；
- 卡上写「bitfinex 无 4h」，实测 `trade:4h:tBTCUST/hist` **200 且行距正好 4 小时**，bitfinex 支持全部九档。

因此「逐所一条不支持周期负例」在 binance/okx/bybit/kraken/bitfinex/htx 六所没有**词汇表内**的候选，
探针改用词汇表外的 `8h`（任何一所都没有这一档）走同一条 fail-closed 分支；gateio/kucoin 用 `1M`、
coinbase 用 `30m`（都是实测上游 400 的档位）。

## 6. 连接器级探针（63/63，退出码 0）

```bash
node_modules/.bin/tsx spikes/impl-ccxt-exchange-expansion/run-probe.ts
```

- **退出码 `0`；`63/63` 判据 PASS**；明细落 [`probe-summary.json`](probe-summary.json)
  （`judgements` 逐条含 route / egressIp / url / observed；`requestTrace` 42 条请求）。
- 判据分组：`ticker.*` 16（九所 USDT 对 + 七所非 USDT 对：okx/kucoin/gateio/coinbase/htx 的 `ETHBTC`、
  kraken/bitfinex 的 `ETHEUR`）、`klines.*` 18（九所 × 两档周期，**请求 URL 逐字比对**）、
  `quote-census.*` 7（现场重抓挂牌端点、按同一条派生规则与代码表逐字比对）、
  `negative.*` 19（未登记 slug 的 ticker/K 线、逐所不支持周期、逐所表外计价币 `BTCNGN`、
  计数机制自证）、`egress.*` 3（默认出口 / 窗口打开 / 还原后实测 IP）。
- 探针自己切换与还原出口：窗口只覆盖 binance/bybit（4 条 ticker/K 线判据走 proxy），
  结束时 `finally` 还原并**实测**直连出口回到 216.195.208.136。
- 与上一轮同口径的遗留：探针覆盖到 `CcxtRestClient` / 服务类这一层，cordis 工具注册层的
  `execute` 未走（工具枚举与描述面由离线用例 `test/exchange-registry-fail-closed.test.ts` 断言）。

## 7. 复现命令

原始响应（默认出口直连）：

```bash
cd spikes/impl-ccxt-exchange-expansion
curl -sS -D census-okx-instruments-spot.headers -o census-okx-instruments-spot.json "https://www.okx.com/api/v5/public/instruments?instType=SPOT"
curl -sS -D census-kucoin-symbols-v2.headers -o census-kucoin-symbols-v2.json "https://api.kucoin.com/api/v2/symbols"
curl -sS -D census-gateio-currency-pairs.headers -o census-gateio-currency-pairs.json "https://api.gateio.ws/api/v4/spot/currency_pairs"
curl -sS -D census-kraken-assetpairs.headers -o census-kraken-assetpairs.json "https://api.kraken.com/0/public/AssetPairs"
curl -sS -D census-coinbase-products.headers -o census-coinbase-products.json "https://api.exchange.coinbase.com/products"
curl -sS -D census-bitfinex-pairs-exchange.headers -o census-bitfinex-pairs-exchange.json "https://api-pub.bitfinex.com/v2/conf/pub:list:pair:exchange"
curl -sS -D census-bitfinex-currencies.headers -o census-bitfinex-currencies.json "https://api-pub.bitfinex.com/v2/conf/pub:list:currency"
curl -sS -D census-htx-symbols.headers -o census-htx-symbols.json "https://api.htx.com/v2/settings/common/symbols"
curl -sS -D klines-okx-btcusdt-1d.headers -o klines-okx-btcusdt-1d.json "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1Dutc&limit=5"
curl -sS -D klines-gateio-btcusdt-1d.headers -o klines-gateio-btcusdt-1d.json "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1d&limit=5"
curl -sS -D klines-kucoin-btcusdt-1d.headers -o klines-kucoin-btcusdt-1d.json "https://api.kucoin.com/api/v1/market/candles?symbol=BTC-USDT&type=1day"
curl -sS -D klines-kraken-btcusdt-1d.headers -o klines-kraken-btcusdt-1d.json "https://api.kraken.com/0/public/OHLC?pair=XBTUSDT&interval=1440"
curl -sS -D klines-coinbase-btcusdt-1d.headers -o klines-coinbase-btcusdt-1d.json "https://api.exchange.coinbase.com/products/BTC-USDT/candles?granularity=86400"
curl -sS -D klines-bitfinex-btcusdt-1d.headers -o klines-bitfinex-btcusdt-1d.json "https://api-pub.bitfinex.com/v2/candles/trade:1D:tBTCUST/hist?limit=5"
curl -sS -D klines-htx-btcusdt-1d.headers -o klines-htx-btcusdt-1d.json "https://api.htx.com/market/history/kline?symbol=btcusdt&period=1day&size=5"
curl -sS -D negative-interval-coinbase-30m.headers -o negative-interval-coinbase-30m.json "https://api.exchange.coinbase.com/products/BTC-USDT/candles?granularity=1800"
curl -sS -D negative-interval-gateio-1M.headers -o negative-interval-gateio-1M.json "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1M&limit=5"
curl -sS -D negative-interval-kucoin-1M.headers -o negative-interval-kucoin-1M.json "https://api.kucoin.com/api/v1/market/candles?symbol=BTC-USDT&type=1mon"
```

SG 窗口（binance / bybit，与上一轮同一手法）：`PUT /proxies/Proxies {"name":"SG"}` → 实测
`-x http://127.0.0.1:7890 https://api.ipify.org` = 188.253.121.148 → 取两份 K 线 → `PUT` 还原 `US`
→ 复核直连 `https://api.ipify.org` = 216.195.208.136。周期普查的 81 条组合同理（`interval-sweep.tsv`
是那次的结果快照）。

## 8. 遗留与陷阱

1. **周期普查的 TLS 抖动**：第一轮 81 条组合里，htx 的前 7 条与 kucoin 的两条出现
   `curl (35) SSL_ERROR_SYSCALL`（连发时的握手抖动）；加 3 秒退避重试后全部 200。归档的
   `klines-htx-btcusdt-1d` 是成功那一份；`interval-sweep.tsv` 里 htx 九条都是 200。
2. **中途中断会留下出口未还原**：见 §1 的过程事实。任何窗口作业都应带无条件还原 + 实测 IP 复核，
   不要只依赖 selector 读数。
3. 价格/成交量/行数都是瞬时值（2026-10-15T02:1x–02:3xZ）；可长期断言的只有**形状**
   （端点、周期参数、行结构、量单位、顺序、字段类型）与**表 = 普查结果**这条关系。
4. **quote 表会过期**：上游新增计价币而代码表未跟进时，探针 `quote-census.<所>` 判据 FAIL——
   这正是刷新信号（重跑普查 → 更新 `QUOTE_TABLES` → 重跑探针）。
5. 出口地区是机器状态：SG 窗口依赖本机 mihomo 节点；默认出口对 binance/bybit 的 451/403 未变。
6. 未覆盖：非 BTCUSDT 的对（探针只取 `ETHBTC`/`ETHEUR` 作非 USDT 样本）、上游 5xx 映射、
   K 线翻页取满 `limit`（本卡明确不做）、各所私有账户面与合约面。
