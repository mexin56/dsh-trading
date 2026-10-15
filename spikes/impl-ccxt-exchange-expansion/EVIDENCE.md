# ccxt 九所 ticker 直连分支 · 真实网络原始响应证据（Phase 1）

- 结论绑 commit：`c3bdb9b4f23313ab33e08830b71071f7c0d3ae64`（现场 `git rev-parse HEAD`）。
- 抓取时刻：2026-10-15T01:55:38Z – 2026-10-15T01:58Z（各文件 `Date` 头逐条列在下表）。
- 本目录为 Phase 1 新增，未改动 `packages/**`。`git status --porcelain` 现场 16 行，全部属于其它会话/在飞改动
  （`packages/client-ui-settings/src/client/{locales,trading-settings-controller}.ts`、`packages/connector-futu/src/index.ts`、
  `packages/connector-ibkr/src/index.ts`、`packages/connector-tushare/{README.md,src/index.ts,src/dataplane.ts,src/rest.ts,test/*}`、
  `.agents/notes/**` 若干）；`packages/connector-ccxt/**` 当时**无**未提交改动。

## 0. 一句话

九所 ticker 的原始 200 响应全部落盘：**七个所在默认出口直连即 200**（gateio / kucoin / kraken / coinbase / bitfinex / htx / okx），
**binance 与 bybit 在默认出口仍是 451 / 403**，改在 SG 可达出口窗口内经 `-x http://127.0.0.1:7890` 取到 200；
binance klines 1 份、阻断原始响应 2 份、负例 3 份。窗口结束后出口已还原并复核。

## 1. 出口说明表

| # | 端点 | 出口 | 出口 IP | HTTP | 原始文件（`.json` + `.headers`） | `Date` 头 |
|---|---|---|---|---|---|---|
| 1 | `GET api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT` | 直连（无 `-x`） | 216.195.208.136 | 200 | `ticker-gateio-btc-usdt` | 01:55:38Z |
| 2 | `GET api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT` | 直连 | 216.195.208.136 | 200 | `ticker-kucoin-btc-usdt` | 01:55:39Z |
| 3 | `GET api.kraken.com/0/public/Ticker?pair=XBTUSDT` | 直连 | 216.195.208.136 | 200 | `ticker-kraken-xbtusdt` | 01:55:39Z |
| 4 | `GET api.exchange.coinbase.com/products/BTC-USD/ticker` | 直连 | 216.195.208.136 | 200 | `ticker-coinbase-btc-usd` | 01:55:40Z |
| 5 | `GET api-pub.bitfinex.com/v2/ticker/tBTCUST` | 直连 | 216.195.208.136 | 200 | `ticker-bitfinex-btcust` | 01:55:41Z |
| 6 | `GET api.htx.com/market/detail/merged?symbol=btcusdt` | 直连 | 216.195.208.136 | 200 | `ticker-htx-btcusdt` | 01:55:42Z |
| 7 | `GET www.okx.com/api/v5/market/ticker?instId=BTC-USDT` | 直连 | 216.195.208.136 | 200 | `ticker-okx-btc-usdt` | 01:55:43Z |
| 8 | `GET api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT` | 直连（**阻断取证**） | 216.195.208.136 | **451** | `blocked-binance-ticker24hr-btcusdt` | 01:55:44Z |
| 9 | `GET api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT` | 直连（**阻断取证**） | 216.195.208.136 | **403** | `blocked-bybit-ticker-btcusdt` | 01:55:44Z |
| 10 | `GET api.gateio.ws/api/v4/spot/tickers?currency_pair=ZZZ_USDT` | 直连（负例） | 216.195.208.136 | **400** | `negative-gateio-unknown-pair` | 01:55:46Z |
| 11 | `GET api.exchange.coinbase.com/products/ZZZ-USD/ticker` | 直连（负例） | 216.195.208.136 | **404** | `negative-coinbase-unknown-product` | 01:55:47Z |
| 12 | `GET api.kraken.com/0/public/Ticker?pair=ZZZUSDT` | 直连（负例） | 216.195.208.136 | 200（`error` 非空） | `negative-kraken-unknown-pair` | 01:55:48Z |
| 13 | `GET api-pub.bitfinex.com/v2/ticker/tETHUST` | 直连（陷阱复验） | 216.195.208.136 | 200 | `ticker-bitfinex-ethust` | 01:56:08Z |
| 14 | `GET api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT` | `-x http://127.0.0.1:7890`（SG 窗口） | 188.253.121.148 | 200 | `egress-binance-ticker24hr-btcusdt` | 01:56:13Z |
| 15 | `GET api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=5` | `-x http://127.0.0.1:7890`（SG 窗口） | 188.253.121.148 | 200 | `egress-binance-klines-btcusdt-1d` | 01:56:13Z |
| 16 | `GET api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT` | `-x http://127.0.0.1:7890`（SG 窗口） | 188.253.121.148 | 200 | `egress-bybit-ticker-btcusdt` | 01:56:13Z |
| 17 | `GET api.gateio.ws/api/v4/spot/tickers?currency_pair=LUNA_USDT` | 直连（错误形态界定） | 216.195.208.136 | 200 | `negative-gateio-delisted-pair` | 01:58Z |
| 18 | `GET api.gateio.ws/api/v4/spot/tickers?currency_pair=ZZZZ_USDT` | 直连（错误形态界定） | 216.195.208.136 | **400** | `negative-gateio-unknown-currency` | 01:58Z |

文件大小（`.json` / `.headers`，字节）：gateio 276/586、kucoin 392/803、kraken 301/1001、coinbase 183/1439、bitfinex-BTC 96/522、
bitfinex-ETH 109/523、htx 305/352、okx 363/974、binance-blocked 224/324、bybit-blocked 96/322、gateio-neg 76/363、
coinbase-neg 22/1410、kraken-neg 39/1110、gateio-neg-delisted 270/586、gateio-neg-currency 62/363、binance-egress 559/940、klines-egress 923/940、bybit-egress 420/472。

**okx 走的是默认出口**：九所里唯一需要先试的 okx ticker 在默认出口直连即 200（`www.okx.com`），因此没有放进可达出口窗口。
附带实测：`aws.okx.com` 在默认出口 TLS 直接失败（curl 退出码 35，HTTP 000），若实现改用该域名会立刻不可用。

**`.headers` 的形态差异（不要误读）**：经 `-x` 抓的三份（#14–#16）文件里有两段状态行 —— 第一行是代理的
`HTTP/1.1 200 Connection established`（CONNECT 隧道），真正的响应状态是紧随其后的 `HTTP/2 200`；直连的十三份只有一段。

## 2. 出口切换与还原（现场证据）

控制器 unix socket `/var/run/clash-verge-service/users/501/verge-mihomo.sock`（`/version` 实测 `v1.19.32`），
`PUT /proxies/Proxies {"name":"<region>"}`，窗口 `188.253.121.148` 实测约 35 秒：

| 时刻 | `Proxies` 组 `now` | `api.ipify.org`（直连，无 `-x`） | `api.ipify.org`（`-x http://127.0.0.1:7890`） |
|---|---|---|---|
| 窗口前 | `US` | 216.195.208.136 | 216.195.208.136 |
| 切换后（窗口内） | `SG` | **188.253.121.148** | **188.253.121.148** |
| 还原后 | `US` | 216.195.208.136 | 216.195.208.136 |

- `PUT` 返回 204；切换与还原各一次，窗口前后组选择器一致（`US` → `SG` → `US`）。
- 窗口内**直连也会走 SG**（本机 mihomo 是 TUN 模式，非 `-x` 的流量同样被规则组接管）⇒ 窗口内的 "直连/代理" 不能当两个不同出口看待；
  上表因此把窗口内的三条响应明确标为经 `-x` 取，出口 IP 以 `-x` 的实测 `188.253.121.148` 为准。
- 还原后再次复核两个通道都是 216.195.208.136，说明没有任何流量仍停留在 SG。

## 3. 默认出口的阻断事实（字节保真）

- binance 451（`application/json`）：`{"code": 0, "msg": "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. …（此处截断，完整正文见文件）"`} → `blocked-binance-ticker24hr-btcusdt.json`
- bybit 403（`application/json`）：正文是 `{ error:The Amazon CloudFront distribution is configured to block access from your country }` ——
  **不是合法 JSON**（键无引号，CloudFront 的文本体）。解析方若先 `JSON.parse` 再读码会在这里抛异常 → `blocked-bybit-ticker-btcusdt.json`

两个阻断事实与 2026-10-08 记录一致：变的是"本机另有一个可达出口"，不是阻断本身。

## 4. 负例与错误映射（三所各不相同）

| 所 | 请求 | 实测 | 正文 |
|---|---|---|---|
| gateio | `?currency_pair=ZZZ_USDT` | **400**（**不是** 200 + 空数组） | `{"label":"INVALID_CURRENCY_PAIR","message":"Invalid currency pair ZZZ_USDT"}` |
| coinbase | `/products/ZZZ-USD/ticker` | **404** | `{"message":"NotFound"}` |
| kraken | `?pair=ZZZUSDT` | **200** | `{"error":["EQuery:Unknown asset pair"]}` |

gateio 补探两点以界定错误形态（均已落盘）：
`?currency_pair=LUNA_USDT`（已下架但仍在册）→ 200 `negative-gateio-delisted-pair`（**有**行情，非空数组）；
`?currency_pair=ZZZZ_USDT`（币种本身不存在）→ 400 `{"label":"INVALID_CURRENCY","message":"Invalid currency ZZZZ"}` `negative-gateio-unknown-currency`。
即 gateio 对"查不到"给的是 **400 + `label` 字段**，不存在"200 + 空数组"这一分支；按 400/`label` 映射才与上游一致。

## 5. 字段核对（各所 200 的关键字段与实测值，抓取时刻 2026-10-15T01:55–01:56Z）

| 所 | 关键字段 | 实测值 | 备注 |
|---|---|---|---|
| gateio | `[0].last` / `[0].base_volume` | `"81761.6"` / `"10068.286254"` | 顶层是数组，价格是**字符串** |
| kucoin | `data.last` / `data.vol` / `data.time` | `"81754.6"` / `"6371.6585121413423448"` / `1792029338381` | `time` 是**毫秒数**，→ 01:55:38Z，与 `Date` 同分钟 |
| kraken | `result.XBTUSDT.c[0]` / `.v[1]` | `"81754.50000"` / `"124.87177737"` | 响应键就是 `XBTUSDT`（Kraken 用 `XBT` 命名比特币，不吃 `BTCUSDT`）；值都是字符串 |
| coinbase | `price` / `volume` / `time` | `"81652.99"` / `"6464.21286103"` / `"2026-10-15T01:55:40.107399598Z"` | **纳秒**精度 ISO8601（9 位小数） |
| bitfinex | `[6]` / `[7]` | `81750` / `788.89828075` | 数组、数值型；见 §7 的时间戳陷阱 |
| htx | `tick.close` / `tick.amount` / `ts` | `81740.35` / `3088.8491021817463` / `1792029342682` | `ts` 毫秒，→ 01:55:42Z；`tick.vol` 为 `2.5630550929211247E8`（**科学计数法**字面量） |
| okx | `data[0].last` / `.vol24h` / `.ts` | `"81761.1"` / `"6420.8244394"` / `"1792029342963"` | `ts` 是**字符串**（不是数字），→ 01:55:42Z |
| binance（SG 窗口） | `lastPrice` / `volume` | `"81722.01000000"` / `"18818.85717000"` | 字符串数值；`closeTime` 1792029373001 → 01:56:13Z |
| bybit（SG 窗口） | `result.list[0].lastPrice` / `.volume24h` | `"81714.1"` / `"9895.042448"` | 顶层 `retCode:0`，且 `result.category:"spot"` 回显；`time` 1792029373874 |
| binance klines（SG 窗口） | 5 根 1d | 每根 12 字段 | 开盘/最高/最低/收/量均字符串；`[6]` 收盘毫秒；**最后一根未收盘**（`closeTime` 1792108799999 > 抓取时刻） |

九所价格同刻落在 81.65k–81.77k，互相印证是同一时刻的真实行情，不是缓存或伪造页面。

## 6. 复现命令（逐条可粘贴）

直连（无 `-x`，需默认出口为 US 之类的非阻断地区）：

```bash
cd spikes/impl-ccxt-exchange-expansion
curl -sS -D ticker-gateio-btc-usdt.headers -o ticker-gateio-btc-usdt.json "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT"
curl -sS -D ticker-kucoin-btc-usdt.headers -o ticker-kucoin-btc-usdt.json "https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT"
curl -sS -D ticker-kraken-xbtusdt.headers -o ticker-kraken-xbtusdt.json "https://api.kraken.com/0/public/Ticker?pair=XBTUSDT"
curl -sS -D ticker-coinbase-btc-usd.headers -o ticker-coinbase-btc-usd.json "https://api.exchange.coinbase.com/products/BTC-USD/ticker"
curl -sS -D ticker-bitfinex-btcust.headers -o ticker-bitfinex-btcust.json "https://api-pub.bitfinex.com/v2/ticker/tBTCUST"
curl -sS -D ticker-bitfinex-ethust.headers -o ticker-bitfinex-ethust.json "https://api-pub.bitfinex.com/v2/ticker/tETHUST"
curl -sS -D ticker-htx-btcusdt.headers -o ticker-htx-btcusdt.json "https://api.htx.com/market/detail/merged?symbol=btcusdt"
curl -sS -D ticker-okx-btc-usdt.headers -o ticker-okx-btc-usdt.json "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"
curl -sS -D blocked-binance-ticker24hr-btcusdt.headers -o blocked-binance-ticker24hr-btcusdt.json "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"
curl -sS -D blocked-bybit-ticker-btcusdt.headers -o blocked-bybit-ticker-btcusdt.json "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT"
curl -sS -D negative-gateio-unknown-pair.headers -o negative-gateio-unknown-pair.json "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=ZZZ_USDT"
curl -sS -D negative-coinbase-unknown-product.headers -o negative-coinbase-unknown-product.json "https://api.exchange.coinbase.com/products/ZZZ-USD/ticker"
curl -sS -D negative-kraken-unknown-pair.headers -o negative-kraken-unknown-pair.json "https://api.kraken.com/0/public/Ticker?pair=ZZZUSDT"
# gateio 错误形态的补探（已落盘）
curl -sS -D negative-gateio-delisted-pair.headers -o negative-gateio-delisted-pair.json "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=LUNA_USDT"          # 200
curl -sS -D negative-gateio-unknown-currency.headers -o negative-gateio-unknown-currency.json "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=ZZZZ_USDT"  # 400 INVALID_CURRENCY
```

可达出口窗口（SG），照 `spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md` 的同一手法：

```bash
S=/var/run/clash-verge-service/users/501/verge-mihomo.sock
curl -sS --unix-socket "$S" http://localhost/version                                   # v1.19.32
curl -sS --unix-socket "$S" http://localhost/proxies/Proxies | python3 -c "import sys,json;print(json.load(sys.stdin)['now'])"
curl -sS -X PUT --unix-socket "$S" -H 'Content-Type: application/json' -d '{"name":"SG"}' http://localhost/proxies/Proxies
curl -sS https://api.ipify.org ; curl -sS -x http://127.0.0.1:7890 https://api.ipify.org  # 均应为 188.253.121.148
P=http://127.0.0.1:7890
curl -sS -x $P -D egress-binance-ticker24hr-btcusdt.headers -o egress-binance-ticker24hr-btcusdt.json "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"
curl -sS -x $P -D egress-binance-klines-btcusdt-1d.headers -o egress-binance-klines-btcusdt-1d.json "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=5"
curl -sS -x $P -D egress-bybit-ticker-btcusdt.headers -o egress-bybit-ticker-btcusdt.json "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT"
curl -sS -X PUT --unix-socket "$S" -H 'Content-Type: application/json' -d '{"name":"US"}' http://localhost/proxies/Proxies   # 还原
curl -sS https://api.ipify.org                                                          # 应回到 216.195.208.136
```

## 7. 陷阱：bitfinex 尾部元素是坏时间戳（两对都坏）

`tBTCUST` 与 `tETHUST` 都是 **11 个元素**（下标 0..10，不存在 `[11]`；任务书说的"第 11 个"是 1-based，即下标 `[10]`）：

| 文件 | 下标 `[10]` | 换算 UTC | 抓取时刻 | 差 |
|---|---|---|---|---|
| `ticker-bitfinex-btcust.json` | `1552298737974` | 2019-03-11T10:05:37Z | 2026-10-15T01:55:41Z | ≈ 7.6 年 |
| `ticker-bitfinex-ethust.json` | `1552298634552` | 2019-03-11T10:03:54Z | 2026-10-15T01:56:08Z | ≈ 7.6 年 |

**结论**：bitfinex ticker 的末位不能当行情时间戳用（实现里若拿它做 `timestamp`，会得到 2019 年的值）；价格与成交量只取 `[6]`/`[7]`。
同刻两对给出的是**同一个 2019 epoch 区间**，说明这是上游固定坏值而非偶发抖动。

## 8. 遗留限制

1. **出口地区是机器状态，不是仓库配置**：SG 窗口依赖本机 clash/mihomo 节点可用；换机器需重新找可达出口（判定手法见 §6）。
2. 默认出口（216.195.208.136，US）下 binance 451 / bybit 403 的阻断事实**未变**；Phase 2 的探针若要在默认出口跑 binance/bybit，必须先切出口，否则必然失败。
3. 价格、成交量、时间戳都是**抓取时刻的瞬时值**（2026-10-15T01:55–01:56Z），不能写成长期断言字面量；可长期断言的只有"形态"（字段名、类型、字符串/数字、正数、回显 symbol）。
4. `www.okx.com` 默认出口可用，但 `aws.okx.com` 在默认出口 TLS 失败（curl 35）；本目录未对 okx 做可达出口窗口取证。
5. `api.huobi.pro`（htx 的等价域名）**本轮未复验**，只用 `api.htx.com` 取了一份（单文件纪律）；lead 侧的"两个域名都通"本轮无独立证据。
6. HEAD 处 `packages/connector-ccxt/src/rest.ts` 的实际状态是 `SUPPORTED_EXCHANGES = ['binance','okx','bybit']`、
   `KLINE_EXCHANGES = ['binance']`（未登记所名在任何 fetch 之前拒绝），即九所直连分支**当时尚未落地**。本目录提供的是端点层的原始网络真值，
   不代表实现已经存在；Phase 2 探针需等实现落地后再跑。
7. 经 `-x` 抓取的三份 `.headers` 含两段状态行（CONNECT 隧道 + 真实响应），比对状态码时取最后一段。

## 9. Phase 2 · 连接器级实跑（真实网络，2026-10-15T02:04:52Z）

单行复跑（探针自己切换/还原出口，无需手工准备窗口）：

```bash
node_modules/.bin/tsx spikes/impl-ccxt-exchange-expansion/run-probe.ts
```

**退出码 `0`；判据 18/18 PASS**；明细落 [`probe-summary.json`](probe-summary.json)。
探针直接 import 真实 `packages/connector-ccxt/src/rest.ts` 的 `CcxtRestClient`（不复制实现、不打桩），
逐条网络调用走真实域名。

### 9.1 代码状态指纹（HEAD 尚未包含本轮实现，指纹是第二把锁）

| 项 | 值 |
|---|---|
| `git rev-parse HEAD` | `c3bdb9b4f23313ab33e08830b71071f7c0d3ae64` |
| `git hash-object packages/connector-ccxt/src/rest.ts` | `381ab9ff55ef4ddfdf0e2a83c452d5766d2811a8` |
| `git hash-object packages/connector-ccxt/src/index.ts` | `6c209a760ad20a258631df4395ceb3948f2e87a7` |
| `git status --porcelain` 行数（现场） | 51（含其它会话在飞改动） |
| `SUPPORTED_EXCHANGES`（实跑读取） | binance, okx, bybit, gateio, kucoin, kraken, coinbase, bitfinex, htx |
| `KLINE_EXCHANGES`（实跑读取） | binance |
| 探针时刻 | 2026-10-15T02:04:52.404Z |

### 9.2 出口窗口与逐条路由

| 时刻 | `Proxies` 组 `now` | ipify（plain 路由） | ipify（显式 `proxy` = `http://127.0.0.1:7890`） |
|---|---|---|---|
| 窗口前（默认出口） | `US` | 216.195.208.136 | — |
| 窗口内 | `SG` | 188.253.121.148 | 188.253.121.148 |
| 还原后 | `US` | 216.195.208.136 | — |

- 七所（okx, gateio, kucoin, kraken, coinbase, bitfinex, htx）在**默认出口**跑（`plain` 路由：不带 proxy 参数）。
- binance / bybit / K 线在 **SG 窗口**内用**显式 `proxy` 参数**跑（等价 `curl -x`）。
- plain 路由的出口 IP 用 `node:https` + `agent:false`（每次新建连接）测。首次实跑 17/18，唯一 FAIL `egress.restored`
  是 keep-alive 复用造成的**假阴性**：selector 已是 `US`，但复用了窗口期建立的连接，读到的仍是 188.253.121.148；
  改成每次新建连接后 18/18。这条说明：**只读 selector 不足以证明出口已还原，必须实测 IP**。

### 9.3 判据（18/18）

| 判据 | 结果 | 路由 | 出口 IP | 实测值 | URL |
|---|---|---|---|---|---|
| `egress.default-exit` | PASS | plain | 216.195.208.136 | 默认出口实测 216.195.208.136（期望 216.195.208.136） | — |
| `ticker.okx` | PASS | plain | 216.195.208.136 | price=81552.7 volume=6441.11662476 ts=1792029893461 | https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT |
| `ticker.gateio` | PASS | plain | 216.195.208.136 | price=81537.6 volume=10090.540895 ts=1792029895288 | https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT |
| `ticker.kucoin` | PASS | plain | 216.195.208.136 | price=81556.6 volume=6424.016579461342 ts=1792029896025 | https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT |
| `ticker.kraken` | PASS | plain | 216.195.208.136 | price=81541.9 volume=124.85765033 ts=1792029896658 | https://api.kraken.com/0/public/Ticker?pair=XBTUSDT |
| `ticker.coinbase` | PASS | plain | 216.195.208.136 | price=81545.9 volume=28.04946057 ts=1792029897278 | https://api.exchange.coinbase.com/products/BTC-USDT/ticker |
| `ticker.bitfinex` | PASS | plain | 216.195.208.136 | price=81532 volume=787.49682495 ts=1792029897982 | https://api-pub.bitfinex.com/v2/ticker/tBTCUST |
| `ticker.htx` | PASS | plain | 216.195.208.136 | price=81537.3 volume=3089.232323646486 ts=1792029898887 | https://api.htx.com/market/detail/merged?symbol=btcusdt |
| `negative.unregistered-slug.ticker` | PASS | plain | 216.195.208.136 | requests=0 | — |
| `negative.unregistered-slug.klines` | PASS | plain | 216.195.208.136 | requests=0 | — |
| `negative.okx-default-exchange.klines` | PASS | plain | 216.195.208.136 | requests=0 | — |
| `negative.unsupported-quote.BTCJPY` | PASS | plain | 216.195.208.136 | requests=0 | — |
| `negative.counter-mechanism-live` | PASS | plain | 216.195.208.136 | requests=7 | — |
| `egress.window-open` | PASS | proxy | 188.253.121.148 | selector=SG proxy 出口=188.253.121.148（plain 同刻=188.253.121.14 | — |
| `ticker.binance` | PASS | proxy | 188.253.121.148 | price=81541.27 volume=18895.09848 ts=1792029900012 | https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT |
| `ticker.bybit` | PASS | proxy | 188.253.121.148 | price=81539.4 volume=9939.035717 ts=1792029900673 | https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT |
| `klines.binance.BTCUSDT.1d` | PASS | proxy | 188.253.121.148 | 5 根 close=[83773.12, 81850, 83169, 81682.01, 81541.27] | https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=5 |
| `egress.restored` | PASS | plain | 216.195.208.136 | selector=US（原 US）默认出口实测 216.195.208.136 | — |

### 9.4 请求 URL 轨迹（10 条，全部 200）

| # | 阶段 | 路由 | HTTP | URL |
|---|---|---|---|---|
| 1 | default-exit | plain | 200 | `https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT` |
| 2 | default-exit | plain | 200 | `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT` |
| 3 | default-exit | plain | 200 | `https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT` |
| 4 | default-exit | plain | 200 | `https://api.kraken.com/0/public/Ticker?pair=XBTUSDT` |
| 5 | default-exit | plain | 200 | `https://api.exchange.coinbase.com/products/BTC-USDT/ticker` |
| 6 | default-exit | plain | 200 | `https://api-pub.bitfinex.com/v2/ticker/tBTCUST` |
| 7 | default-exit | plain | 200 | `https://api.htx.com/market/detail/merged?symbol=btcusdt` |
| 8 | egress-window | proxy | 200 | `https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT` |
| 9 | egress-window | proxy | 200 | `https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT` |
| 10 | egress-window | proxy | 200 | `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=5` |

形态要点：okx 打 `instId=BTC-USDT`（`splitPair` 变换）；kraken 打 `pair=XBTUSDT`（BTC→XBT）；
bitfinex 打 `tBTCUST`（`t` 前缀 + USDT→UST）；coinbase 打 `products/BTC-USDT/ticker`；htx 全小写 `btcusdt`；
binance / bybit 用**裸符号** `BTCUSDT` 直发（不经 `splitPair`）。

### 9.5 三条负例（零请求，计数 fetch 证明）

| 负例 | 构造 | 期望码 | 实测 | 请求数 |
|---|---|---|---|---|
| 未登记 slug（ticker） | `getTicker('BTCUSDT','bitstamp')` | `TRADING_NOT_IMPLEMENTED` | 命中 | **0** |
| 未登记 slug（klines） | `new CcxtRestClient({ exchange:'bitstamp' }).getKlines(...)` | `TRADING_NOT_IMPLEMENTED` | 命中 | **0** |
| 已登记所名的 K 线面 | `new CcxtRestClient({ exchange:'okx' }).getKlines(...)` | `TRADING_NOT_IMPLEMENTED` | 命中 | **0** |
| quote 表外符号 | `getTicker('BTCJPY','gateio')` | `TRADING_UNSUPPORTED_SYMBOL` | 命中 | **0** |

每个负例注入**独立的计数 `fetchImpl`** 证明零请求；计数机制本身另有自证判据
（`negative.counter-mechanism-live`：默认出口七所共记到 7 次请求）——否则「0」可能只是包装没被调用。

### 9.6 遗留

1. 价格/成交量是瞬时值（2026-10-15T02:04:52.404Z），可长期断言的只有形态（字段类型、正数、symbol 回显、时间戳区间）。
2. 探针依赖本机 mihomo 控制器与 `http://127.0.0.1:7890`；换机器用 `DSH_PROBE_MIHOMO_SOCKET` / `DSH_PROBE_PROXY` /
   `DSH_PROBE_EXPECT_DEFAULT_IP` / `DSH_PROBE_WINDOW_SELECTOR` 覆盖。socket 不可用时探针直接报错退出，不静默降级。
3. 指纹是**未提交工作树**的哈希：实现一旦提交或再改，指纹变化即本节结论失效，需重跑（这正是记指纹的原因）。
4. 探针覆盖到 `CcxtRestClient` 服务类这一层；cordis 工具注册层（`ctx.tools`）未启动，
   `crypto_get_ticker` / `crypto_get_klines` 的 `execute` 未走（与 P3 复验同口径）。
5. 本轮未覆盖：非 BTCUSDT 计价对、`-SWAP` 永续拒绝路径、上游 5xx 映射、`TRADING_SYMBOL_NOT_FOUND` 的真实上游触发。
