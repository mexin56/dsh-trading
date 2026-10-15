# @dshtrading/connector-ccxt

加密现货连接器（crypto 市场），沿用 CCXT 的交易所词汇做**九所免密行情**
（binance / okx / bybit / gateio / kucoin / kraken / coinbase / bitfinex / htx 九条直连分支）：
实现 `@dshtrading/api` 的 `MarketDataService`，行情快照按所切换；K 线只有 Binance 一条路径，
且 `getKlines` 不接收所名（裁决对象是客户端默认所名，形参面已撤）。
所名登记面 = 实现面：九个所名各有自己的请求符号形态与解析分支；登记面之外的 slug
在任何请求之前结构化拒绝，不静默落 Binance 兜底。
本包**不依赖也不打包 `ccxt` 库**，也没有合约（永续/交割）面——`-SWAP` 入参显式拒绝。
交易面保留服务缝三态闸门与私有账户读面的失败关闭语义，**私有账户面与真实下单均未实现**。

## 状态

**九所 ticker 与 binance K 线均有真实网络原始响应证据**（2026-10-15 一轮，含出口说明与可复跑探针）：
原始响应与出口记录见 [impl-ccxt-exchange-expansion/EVIDENCE.md](../../spikes/impl-ccxt-exchange-expansion/EVIDENCE.md)。

- **2026-10-15 九所取证（本轮）**：默认出口（美国节点 `216.195.208.136`）直连可达
  gateio / kucoin / kraken / coinbase / bitfinex / htx / okx 七所（各落一份 200 原始响应，字节保真）；
  binance / bybit 在默认出口仍是 **451 / 403**（阻断原始响应入档），改在**可达出口**取 200
  原始响应（mihomo 规则组切 SG，出口 `188.253.121.148`，窗口结束已还原并用 `api.ipify.org` 复核）。
  连接器级实跑（九所真实取价 + binance K 线 + 三条零请求负例）见同目录 `run-probe.ts` 与
  `EVIDENCE.md` 的「Phase 2」一节：**退出码 0、18/18 判据通过**（`probe-summary.json` 记 HEAD sha
  与两个源文件的内容指纹）。探针记录了一条过程事实：只读 mihomo selector 不足以证明出口已还原
  （keep-alive 会复用窗口期连接），必须实测出口 IP。
- **2026-08-31 评审随测**（对象 commit `b80000e`，九所补齐之前的历史记录）：ccxt binance ticker
  `BTCUSDT` 77767.66（第 8 项）、ccxt 切 bybit 所的 klines `ETHUSDT` 5m 8 根 close 2420.08（第 9 项）——
  两项均为真实网络调用、无 stub。证据
  [verify-connectors-suite/EVIDENCE.md](../../spikes/verify-connectors-suite/EVIDENCE.md)。
  注意第 9 项（bybit 切所那次）走的是 **Binance 端点**：当时 `getKlines` 忽略 `exchange` 形参；
  该形参已在 2026-10-15 撤掉，K 线只剩 binance 一条路径（见「已知边界」第 2 条）。
  该 spike 目录只提交了 EVIDENCE.md，随测脚本未入仓（`git ls-files spikes/verify-connectors-suite`
  只有一份 EVIDENCE.md）；本节其余证据都带可复跑脚本。
- **2026-10-08 的出口结论仍是端点级的**（[reverify 记录](../../spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md)
  第 1/2 节）：那次没有在本包上跑；本轮已在本包上复现同样的阻断事实（见上一条与「已知边界」第 8 条）。
- **未实现**（不是未实证）：私有账户读面的实际读实现（读方法失败关闭，见「已知边界」第 5 条）
  与真实下单；登记面之外 slug 的直连分支。逐条见「已知边界」。
- **九所登记面 = 实现面**（2026-10-15）：`SUPPORTED_EXCHANGES` 登记九条 ticker 直连分支；
  同日早先那一轮曾把登记面收窄到三所并撤掉 K 线的 `exchange` 形参，本轮补齐六所分支后
  ticker 登记面重新等于实现面，K 线面仍只有 binance 一条路径且不再有该形参。
  登记面之外的 slug 在**任何 fetch 之前**抛 `TRADING_NOT_IMPLEMENTED`（点名所名、列出实现面、
  零网络请求），回归 `test/exchange-registry-fail-closed.test.ts`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器；`false` 时 `apply` 立即返回 |
| `dryRun` | `true` | 强制模拟下单：为 `true` 时即使 `liveTrading=true` 且请求 `dryRun=false`，也只回本地模拟回执 |
| `liveTrading` | `false` | 实盘开关的**非权威镜像**；真正授权由 `@dshtrading/authority` 的人工签署平面裁定 |
| `defaultExchange` | `'binance'` | 首选所名（schema 是开放 `string`：任何 slug 都能填，解析期不收窄）；传给 REST 客户端作为默认 `exchange`。九所都有 ticker 直连分支；K 线只有 binance 一条路径（该面不接受所名形参），其余所名在请求前结构化拒绝 |

依据：`src/index.ts:41-49`（schema 与默认值）、`src/index.ts:179-180`（只把 `defaultExchange`
传给客户端）。**本包没有凭证字段**——`Config` 里没有 key/secret ref，
`apply` 也不读任何环境变量；所有请求都是免密公共端点。
设置页也不再挂 `CCXT_API_KEY` / `CCXT_API_SECRET` 占位（2026-10-15 撤：面板写进
`dshtrading.credentials.ccxt` 的键无人读，见「已知边界」第 6 条）。

## 接线

- **数据面行**：`packages/crypto/cordis.patch.yml:36-38` → 行 id `dsh-trading-crypto-dataplane-ccxt`，
  模块 `@dshtrading/connector-ccxt/dataplane`。该入口只把 `(crypto, ccxt)` 注册进
  `tradingMarketDataRegistry`（`src/dataplane.ts:36`），**既不注册交易面也不注册工具**。
- **preset 行**：`packages/crypto/assets/preset/crypto-trader/agent.cordis.yml:79-90` → isolate 组
  id `dsh-trading-crypto-connector-ccxt-group`（isolate `tradingCryptoMarketData` 与
  `tradingCryptoTrade`），内层行 id `dsh-trading-crypto-connector-ccxt`（第 86-87 行），
  行内只写 `enabled: true` / `dryRun: true` / `liveTrading: false`。
  交易服务只在 preset 主入口构造（`src/index.ts:180`），**不经 `tradingTradeRegistry`**。
- **服务键**：`tradingCryptoMarketData`（`src/index.ts:51`）、`tradingCryptoTrade`（`src/index.ts:52`）。
- **provider 词汇**：`packages/router/src/index.ts:66` 登记 `ccxt`。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:46`
  （`PROVIDER_LABELS` 的 `ccxt` 条目：`type: 'public'`、无 `env`、无凭据字段）与
  `packages/client-ui-settings/src/client/locales.ts` 的 `'provider.ccxt'` 条目
  （zh `CCXT (9 所直连：Binance/OKX/Bybit/Gate/KuCoin/Kraken/Coinbase/Bitfinex/HTX)` / en
  `CCXT (9 direct venues: Binance / OKX / Bybit / Gate / KuCoin / Kraken / Coinbase / Bitfinex / HTX)`，
  2026-10-15 随九所补齐同步），与本包登记的实现面一致。
- **profile overrides**：`node scripts/sync-profile-overrides.mjs --all --dsh-home ~/.dsh-trading`
  （注意 `--dsh-home`；宿主会话继承的 `DSH_HOME` 指向别处会找错 profile 集）。

用户切换：设置 → 数据源 → crypto → CCXT。

## 上游端点

| 用途 | 端点 | 源码行 |
|---|---|---|
| 快照（`exchange=binance`） | `GET https://api.binance.com/api/v3/ticker/24hr?symbol=` | `src/rest.ts:370` |
| 快照（`exchange=okx`） | `GET https://www.okx.com/api/v5/market/ticker?instId=` | `src/rest.ts:270` |
| 快照（`exchange=bybit`） | `GET https://api.bybit.com/v5/market/tickers?category=spot&symbol=` | `src/rest.ts:254` |
| 快照（`exchange=gateio`） | `GET https://api.gateio.ws/api/v4/spot/tickers?currency_pair=` | `src/rest.ts:288` |
| 快照（`exchange=kucoin`） | `GET https://api.kucoin.com/api/v1/market/stats?symbol=` | `src/rest.ts:299` |
| 快照（`exchange=kraken`） | `GET https://api.kraken.com/0/public/Ticker?pair=` | `src/rest.ts:314` |
| 快照（`exchange=coinbase`） | `GET https://api.exchange.coinbase.com/products/{pair}/ticker` | `src/rest.ts:327` |
| 快照（`exchange=bitfinex`） | `GET https://api-pub.bitfinex.com/v2/ticker/{tPAIR}` | `src/rest.ts:339` |
| 快照（`exchange=htx`） | `GET https://api.htx.com/market/detail/merged?symbol=` | `src/rest.ts:354` |
| K 线（客户端默认所名 = binance） | `GET https://api.binance.com/api/v3/klines?symbol=&interval=&limit=` | `src/rest.ts:388` |

主机共九个（`api.binance.com` / `www.okx.com` / `api.bybit.com` / `api.gateio.ws` / `api.kucoin.com` /
`api.kraken.com` / `api.exchange.coinbase.com` / `api-pub.bitfinex.com` / `api.htx.com`），
K 线复用 `api.binance.com`；所有请求只带 `Accept: application/json`（`src/rest.ts:216-245`），无签名头。
`SUPPORTED_EXCHANGES`（`src/rest.ts:46`）登记这九条 ticker 分支；`KLINE_EXCHANGES`
（`src/rest.ts:54`）只剩一个用途——客户端默认所名落在表外时在 fetch 之前拒绝（`src/rest.ts:387`）。
登记面之外的 slug（如 `bitstamp`）在入口守卫（`src/rest.ts:247`、`:387`）即抛
`TRADING_NOT_IMPLEMENTED`，**不发任何请求**（见「已知边界」第 1、2 条）。

## 周期与契约

- **周期词汇**：`1m / 5m / 15m / 30m / 1h / 4h / 1d / 1w / 1M`（`src/rest.ts:37`）——只有 K 线面用它。
  没有映射表：词汇原文直接作为 Binance `interval` 参数发出（`src/rest.ts:388`），即 `1M` 就是
  Binance 的月线；词汇表外的值在类型层即不可表达。
- **所名守卫**：`getTicker` / `getKlines` 在 `normalizeSymbol` 之后、任何 fetch 之前按登记面裁决
  （`src/rest.ts:247`、`:387`）：登记面之外的所名 → `TRADING_NOT_IMPLEMENTED`（点名所名、列出
  实现面、零请求）。两处文案由同一个 `notImplementedError` helper 构造（`src/rest.ts:70-76`）。
- **现货限定**：`normalizeSymbol`（`src/rest.ts:93-104`）先转大写；形态由 `@dshtrading/api` 的
  `instrumentFormOf` 裁决，命中永续形态即抛 `TRADING_UNSUPPORTED_SYMBOL`，**不剥后缀、不发任何请求**；
  随后删 `-`/`_` 分隔符、去掉 `/`。返回值是该所侧的裸符号（如 `BTCUSDT`），
  也就是响应里的 `symbol` 字段。
- **符号按所归一**：需要形态变换的七条分支（okx / kucoin / gateio / kraken / coinbase / bitfinex / htx）
  先 `splitPair`（`src/rest.ts:117-128`）按 `QUOTE_SUFFIXES`（`src/rest.ts:107`，**最长优先**）
  `USDT / USDC / USD / EUR / TRY / BRL / BTC / ETH` 切成 base+quote，再按所映射
  （`requestSymbol`，`src/rest.ts:146-164`）：okx/kucoin/coinbase `BTC-USDT`、gateio `BTC_USDT`、
  kraken `BTC`→`XBT`（`XBTUSDT`）、bitfinex 前缀 `t` 且 `USDT`→`UST`（`tBTCUST`）、htx 全小写（`btcusdt`）。
  变换分支的类型集合是 `TransformExchange`（`src/rest.ts:138`），switch 穷尽无 default——
  binance / bybit **不经过这张表**：它们把裸符号原样发出，`ETHBNB` / `BTCFDUSD` 这类 quote 表外的
  合法对不受影响（回归见 `test/symbol-normalization.test.ts`）。拼不出 base+quote
  （quote 表外或 base 为空）→ `TRADING_UNSUPPORTED_SYMBOL` 且零请求。
- **错误映射**（`src/rest.ts:216-245`）：fetch 抛错 → `TRADING_NETWORK`；非 2xx → 先读正文
  （**容忍非 JSON**：bybit 的 403 正文就是 CloudFront 的地域拦截片段）、压成单行 200 字符片段进 message，
  其中 **404** 与 **400 且正文 `label` 以 `INVALID_` 开头**（gateio 实测 `INVALID_CURRENCY_PAIR`）
  → `TRADING_SYMBOL_NOT_FOUND`，其余非 2xx → `TRADING_UPSTREAM_ERROR`。行级判空（上游 200
  但没有可用的行）统一 `TRADING_SYMBOL_NOT_FOUND`（`src/rest.ts:79-84`）。
- **K 线解析**：按 Binance 数组行解析 `[openTime, open, high, low, close, volume, closeTime]`
  （`src/rest.ts:391-399`），非数组响应返回空数组（`src/rest.ts:390`）。
- **快照字段**：只回 `symbol / price / volume / timestamp`；`price` / `volume` 一律取**基础币 24h 量**
  （binance `volume`、okx `vol24h`、bybit `volume24h`、gateio `base_volume`、kucoin `vol`、
  kraken `v[1]`、coinbase `volume`、bitfinex `[7]`、htx `tick.amount`）。
  `timestamp` 分两类：**上游给服务器时间就用它**（binance `closeTime`、okx `ts`、kucoin `data.time`、
  htx `ts`），**否则用本地观测时刻**（bybit / gateio / kraken / bitfinex / coinbase）——
  coinbase 的 `time` 是**最后成交时间**不是服务器时间（薄标的可读到数小时前），bitfinex 数组下标 10
  是上游坏值（实测 2019-03-11，两对都坏），两处都不用，并在代码注释里点名。

## 能力面

服务方法（`CcxtMarketDataService` / `CcxtTradeService`）：

| 方法 | 有/缺席 | 说明 |
|---|---|---|
| `getTicker` | 有 | 第二参数 `exchange` 生效：九所直连分支；登记面之外的所名结构化拒绝（`TRADING_NOT_IMPLEMENTED`，零请求）（`src/index.ts:66-68`） |
| `getKlines` | 有 | 形参不含所名：只有 binance 一条路径，裁决对象是客户端默认所名，非 binance 结构化拒绝（零请求）（`src/index.ts:70-74`） |
| `subscribeTicker` | 有 | 快照轮询，最小 1000 ms、缺省 5000 ms（`src/index.ts:76-84`） |
| `listInstruments` | 缺席 | 未实现，调用方按可选方法缺席处理 |
| `getOrderbook` / `getRecentTrades` | 缺席 | 未实现 |
| `getDerivatives` / `getDerivativesHistory` | 缺席 | 未实现 |
| `placeOrder` | 有（模拟） | 三态闸门；模拟回执由服务层本地合成（`src/index.ts:102-129`） |
| `cancelOrder` | 有（受限） | 未获实盘授权或 `dryRun=true` 时结构化拒绝（`src/index.ts:131-141`） |
| `getOrder` | 有（失败关闭） | 契约必需方法，恒抛 `TRADING_NOT_IMPLEMENTED`（语义是「不可用」，不是「订单不存在」）（`src/index.ts:149-155`） |
| `getPositions` | 有（失败关闭） | 契约必需方法，恒抛 `TRADING_NOT_IMPLEMENTED`（语义是「不可用」，不是「没有持仓」）（`src/index.ts:157-163`） |
| `getBalance` / `getOrders` | 缺席 | 非契约方法，已删除：不再回常量 USDT 余额，也不再用恒空数组冒充「没有挂单」 |
| `getBalances` / `listOpenOrders` / `listTradeFills` / `setLeverage` | 缺席 | 可选方法未定义 |

工具（`apply` 内注册，duplicate-safe，`src/index.ts:183-215`）：

| 工具 | 参数 | 说明 |
|---|---|---|
| `crypto_get_ticker` | `symbol`（必填）/ `exchange`（枚举 = `SUPPORTED_EXCHANGES`，即九所，缺省 `binance`） | 九条直连分支；枚举外的所名在请求前结构化拒绝（`TRADING_NOT_IMPLEMENTED`，零请求） |
| `crypto_get_klines` | `symbol` / `interval`（枚举 = 周期词汇，缺省 `1d`）/ `limit`（缺省 100）——**没有 `exchange` 参数** | 只有 Binance 一条路径（按 `defaultExchange` 裁决）；非 binance 所名在请求前结构化拒绝（零请求） |

**本包只注册这 2 个工具**，且都是行情工具；交易面没有注册任何工具。

## 已知边界

1. **登记面 = 实现面（ticker 九所）**：`SUPPORTED_EXCHANGES`（`src/rest.ts:46`）登记九条 ticker
   直连分支，`getTicker` 在入口守卫（`src/rest.ts:247`）就拦下登记面之外的 slug（如 `bitstamp`），
   抛 `TRADING_NOT_IMPLEMENTED` 且**不发任何请求**——此前「选 kraken 会拿到 Binance 的报价、
   没有任何提示」的静默兜底已不存在。2026-10-15 早先那轮曾把登记面收窄到三所，本轮补齐六所
   分支，登记面重新等于实现面；工具描述与设置页显示名同步（`src/index.ts:190`、`locales.ts`
   的 `'provider.ccxt'` 条目）。
2. **K 线只有 Binance 一条路径，且不接受所名形参**：`KLINE_EXCHANGES`（`src/rest.ts:54`）只登记
   `binance`，`getKlines`（`src/rest.ts:385-400`）没有任何 `exchange` 形参（客户端方法、服务方法、
   工具三处都已撤），裁决对象是**客户端默认所名**：`defaultExchange` 非 binance 时在 fetch 之前抛
   `TRADING_NOT_IMPLEMENTED`（零请求）。此前「形态上接收 `exchange`、实现上忽略它恒打 Binance」
   的假形参已不存在；按所取 K 线是另一张卡。
3. **不是通用 CCXT 大包**：`package.json` 的 dependencies 只有 `@dshtrading/authority` 与
   `@dshtrading/api`，**没有 `ccxt` 依赖**；本包是自写的九条 ticker 直连分支 + 一条 K 线路径，
   只沿用 CCXT 的所名词汇。
4. **现货限定**：`-SWAP` 入参抛 `TRADING_UNSUPPORTED_SYMBOL` 且零网络请求
   （`src/rest.ts:71-81`，回归见 `test/spot-only-form.test.ts`）；本包没有合约面，
   需要永续报价应换 bybit / okx 连接器。
5. **私有账户读面失败关闭**：本包没有签名私有账户读路径，两类必需读方法都显式拒绝——
   `getOrder` 抛 `TRADING_NOT_IMPLEMENTED`（`src/index.ts:149-155`）、`getPositions` 抛
   `TRADING_NOT_IMPLEMENTED`（`src/index.ts:157-163`），文案写明语义是「不可用」，不是
   「订单不存在」或「没有持仓」；可选方法 `getBalances` / `listOpenOrders` /
   `listTradeFills` 直接缺席，消费方按「可选方法缺席」处理。此前硬编码的 100000 USDT
   余额、恒空数组的 `getPositions` 与非契约的 `getOrders` 已删除；回归
   `test/account-read-surface.test.ts`。
6. **凭证字段已撤（2026-10-15）**：设置页不再为 ccxt 挂 `apiKey` / `apiSecret`——本连接器既不声明
   凭证字段、也不读设置字典（`src/index.ts:41-49`、`:179-180`；`CcxtRestOptions` 的 `apiKey`/`secret`
   只被赋值，从不进请求），面板字段是纯承诺，故撤下；日后接签名面时随消费点一起回来。
   撤字段的理由、逐条对照与一致性用例见[设置页凭据面收窄](../../.agents/notes/implemented/simplification/2026-10-15-settings-credential-surface-narrowed.md)。
7. **live 下单路径是本地 sim stub**：闸门③放行后 `CcxtRestClient.placeOrder`
   返回 `sim-ccxt-*` 回执（`src/rest.ts:402-415`），不触网。
8. **地域限制由上游实施**：默认出口对 `api.binance.com` 451、`api.bybit.com` 403
   （2026-10-08 记录；2026-10-15 本轮在本包上复现并落原始响应）。九所里其余七所
   （okx / gateio / kucoin / kraken / coinbase / bitfinex / htx）默认出口直连即 200，
   只有 binance / bybit 需要可达出口；换出口属用户侧环境选择，不是仓库配置。
9. **类型存量债**：本包 `tsconfig.json` 原有 10 条 tsc 错误记在
   `scripts/typecheck-baseline.json:36`；本轮新增的九处行级判空用包内 `CcxtErrorCode`
   单点收口后现状 **6 条**（降 4、新增 0），其余都是基线内的存量债。
10. **quote 表是共享近似，不是各所白名单**：需要形态变换的七条分支共用 8 个 quote 后缀
    （`QUOTE_SUFFIXES`，`src/rest.ts:107`），而各所真实存在的 quote 更多（本轮对各所公开端点
    普查：kraken 另有 GBP/JPY/CHF/CAD/AUD/DAI/PYUSD…、coinbase 另有 GBP/AUD/CAD/SGD/INR/DAI、
    gateio 另有 GUSD/USD1、kucoin 另有 KCS/TRX/DOGE、htx 另有 TUSD/HT/GBP/RUB…）。
    表外计价的对在这七条分支上是**本地 `TRADING_UNSUPPORTED_SYMBOL` 且零请求**——不是回归
    （改动前这些所名会拿到 Binance 的报价或拼出错符号），且 binance / bybit 不受影响。
    扩表或改成按所维护 quote 表属后续卡；本轮先把「拼不出来就不发」定死。
11. **`TRADING_SYMBOL_NOT_FOUND` 不在 api 的错误码词汇表里**：`TradingErrorCode`
    （`packages/api/src/index.ts:870`）没有这个码，而本包行级判空与另外多个连接器都在抛它
    （与 `TRADING_UPSTREAM_ERROR` 曾经的类型层缺口同形）。本包用 `CcxtErrorCode`
    （`src/rest.ts:24-35`）在包内声明一次，**运行时错误码不变**；把码补进 api 联合是 api 的卡
    （会同时清掉多个包的同类 tsc 债），不在本轮边界内。
12. **请求符号决定拿到哪个盘**：`BTCUSDT` 在 coinbase 上归一成 `products/BTC-USDT/ticker`——
    实测该盘 24h 量只有 28.05（同一时刻 `BTC-USD` 是 6464.21），是薄盘。要拿 USD 盘就传
    `BTCUSD`（映射成 `BTC-USD`）；各所同理（如 bitfinex 走 `tBTCUST` 即 USDT 盘）。
    本包不改写所名，符号怎么给就怎么映射。

## 合规记录

- 九个主机（`api.binance.com` / `www.okx.com` / `api.bybit.com` / `api.gateio.ws` / `api.kucoin.com` /
  `api.kraken.com` / `api.exchange.coinbase.com` / `api-pub.bitfinex.com` / `api.htx.com`）的公共行情端点：
  公开、免密；本包不内置密钥，不读凭证环境变量，不把任何值写进日志或回执。
- 本包不依赖也不打包 `ccxt`：名字里的 CCXT 指沿用的交易所词汇，不代表引入该库或该库的运行时。
- 本仓不缓存、不再分发行情数据。
- 各所的地域限制（Binance 451 / Bybit 403 记录）是上游按出口国家实施的政策，
  不是本包可控项；换出口属用户侧环境选择，不是仓库配置的一部分。
- 许可：`PolyForm-Noncommercial-1.0.0`（`package.json`）。
- 本包是数据与执行通道的技术实现，不构成投资建议。

## 出网验证

```sh
pnpm --filter @dshtrading/connector-ccxt test   # 离线：现货限定/符号归一/所名登记面/错误映射/账户读面/三态闸门/dataplane
node_modules/.bin/tsx spikes/impl-ccxt-exchange-expansion/run-probe.ts   # 出网：九所 ticker + binance K 线 + 三条零请求负例（失败即退出码 1）
```

- **出网脚本已入仓**（2026-10-15）：`spikes/impl-ccxt-exchange-expansion/run-probe.ts`——
  九所 ticker 真实取价 + binance K 线 + 未登记 slug / 非 binance K 线的零请求负例；
  逐条判据、出口 IP 与源码指纹落在同目录 `probe-summary.json` 与 `EVIDENCE.md`。
  **注意出口**：binance / bybit 在默认出口是 451 / 403，走可达出口窗口时须切 mihomo 规则组
  并在结束后还原（手法见 `spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md` 第 2 节）。
  更早一轮 2026-08-31 的评审随测其脚本未随证据入仓（`spikes/verify-connectors-suite/` 只有 EVIDENCE.md）。
- 离线证据：`test/spot-only-form.test.ts`（永续入参拒绝 + 零请求断言 + 现货零回归）、
  `test/symbol-normalization.test.ts`（九所请求符号形态 + binance/bybit 不走 quote 表 +
  变换分支的零请求拒绝）、`test/upstream-error-mapping.test.ts`（404 / 400 `INVALID_*` /
  非 JSON 正文 / 正文截断 / 网络错误）、`test/exchange-registry-fail-closed.test.ts`
  （登记面之外 fail-closed + 九所各自主机 + K 线无 `exchange` 形参 + 工具枚举与登记面一致）、
  `test/account-read-surface.test.ts`（账户读面失败关闭：必需读方法拒绝 + 可选读方法缺席 +
  撤单闸门回归）、`test/trade-gate.test.ts`（服务缝三态矩阵）、
  `test/dataplane-loader.test.ts`（数据面行解析）。
- 真实网络下的服务缝闸门验证只覆盖 okx 连接器（
  [impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md)），
  与本包无关；本包未做真实下单验证。

## 参见

- Owning Note：[crypto-perp-data-plane-bybit-ccxt.md](../../.agents/notes/implemented/feature/2026-10-08-crypto-perp-data-plane-bybit-ccxt.md)
- 本轮九所补齐与 K 线撤形参：[2026-10-15-ccxt-nine-exchange-ticker-branches.md](../../.agents/notes/implemented/feature/2026-10-15-ccxt-nine-exchange-ticker-branches.md)
- 上一轮登记面收窄（本卡承接其「另开卡」项）：[2026-10-15-declared-registration-face-equals-implementation.md](../../.agents/notes/implemented/simplification/2026-10-15-declared-registration-face-equals-implementation.md)
- 全仓当前状态与硬停：[docs/current-state.md](../../docs/current-state.md)
- 连接器横向对照：[connectors-guide.md](../../docs/guides/connectors-guide.md)
