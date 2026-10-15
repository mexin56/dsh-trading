# Agent Note: connector-ccxt 补齐九所 ticker 直连分支，K 线面撤掉 exchange 形参

Status: implemented

## Problem

- 同日早先那一轮把 ccxt 所名面收窄到实现事实（[declared-registration-face-equals-implementation](../simplification/2026-10-15-declared-registration-face-equals-implementation.md)）：
  `SUPPORTED_EXCHANGES = ['binance','okx','bybit']`、`KLINE_EXCHANGES = ['binance']`，登记面之外的
  slug 在任何 fetch 之前抛 `TRADING_NOT_IMPLEMENTED`。它把「补齐六条直连分支」明确列为**另开卡的
  未实现项**（Alternatives 落选 + Consequences 未实现清单）——收窄解决了「选 kraken 拿到 Binance
  报价」，但没有解决「用户根本拿不到 kraken 报价」：gateio / kucoin / kraken / coinbase / bitfinex /
  htx 六所在仓内**没有专包**（只有 binance / okx / bybit 各有专包），`ccxt` 是它们唯一的入口。
- `getKlines` 的 `exchange` 形参只剩一个取值（binance）：形态上仍收所名、语义上等于「要么 binance
  要么拒绝」，是假形参；`@dshtrading/api` 的 `MarketDataService.getKlines(symbol, interval, limit?)`
  本来也没有这个参数。
- 六所端点在本仓没有任何证据（README 当时把它们的直连分支记为「未实现」）。

## Decision

- `SUPPORTED_EXCHANGES` 登记九条 ticker 直连分支（`binance / okx / bybit / gateio / kucoin / kraken /
  coinbase / bitfinex / htx`）；六条新分支各自只打自己的公共现货端点：gateio `GET /api/v4/spot/tickers
  ?currency_pair=`、kucoin `GET /api/v1/market/stats?symbol=`、kraken `GET /0/public/Ticker?pair=`、
  coinbase `GET /products/{pair}/ticker`、bitfinex `GET /v2/ticker/{tPAIR}`、htx
  `GET /market/detail/merged?symbol=`（主机与源码行见包 README「上游端点」）。
- **请求符号按所归一**：需要形态变换的七条分支共享 `splitPair`（`QUOTE_SUFFIXES` =
  `USDT/USDC/USD/EUR/TRY/BRL/BTC/ETH`，最长优先）+ `requestSymbol`（okx/kucoin/coinbase 用 `-`、
  gateio 用 `_`、kraken `BTC`→`XBT`、bitfinex 前缀 `t` 且 `USDT`→`UST`、htx 全小写）。类型收窄到
  `TransformExchange` 的**穷尽 switch、无 default**：binance / bybit 结构上不可能被调错，它们把裸符号
  原样发出，`ETHBNB` / `BTCFDUSD` 这类 quote 表外的合法对零回归。拼不出 base+quote → 
  `TRADING_UNSUPPORTED_SYMBOL` 且零请求。**共享 quote 表已于同日按所替换**：各所一份资产表
  （数据来源 = 该所公开挂牌端点普查，最长优先只按该所的表切），见
  [ccxt quote 表与九所 K 线](2026-10-15-ccxt-per-exchange-quote-tables-and-klines.md)。
- **K 线面撤形参**：`getKlines` 不再收 `exchange`（客户端方法、服务方法、`crypto_get_klines` 工具三处），
  `KLINE_EXCHANGES` 只剩一个用途——客户端默认所名落在表外时在 fetch 之前拒绝；服务签名与
  `MarketDataService` 契约同形。**同日后续变更已把 K 线按所切换**（九条分支、周期按所映射）并恢复
  **连接器自有**的 `exchange` 形参，见
  [ccxt quote 表与九所 K 线](2026-10-15-ccxt-per-exchange-quote-tables-and-klines.md)；
  服务契约仍是三形参，撤形参时确立的「不留假形参」判据不变。
- **错误映射**：非 2xx 先读正文（**容忍非 JSON**：bybit 的 403 正文就是 CloudFront 拦截片段），压成单行
  200 字符片段进 message；其中 404 与「400 且正文 `label` 以 `INVALID_` 开头」（gateio 实测
  `INVALID_CURRENCY_PAIR` / `INVALID_CURRENCY`）→ `TRADING_SYMBOL_NOT_FOUND`，其余 → 
  `TRADING_UPSTREAM_ERROR`；行级判空（上游 200 但没有可用的行）统一 `TRADING_SYMBOL_NOT_FOUND`。
  该码当时用包内 `CcxtErrorCode` 收口；同日后续变更已把它收录进 api 的 `TradingErrorCode`、别名下线，
  见 [词汇表 note](../architecture/2026-10-15-trading-error-code-vocabulary-symbol-not-found.md)。
- **时间戳口径统一**：上游给服务器时间就用它（binance `closeTime`、okx `ts`、kucoin `data.time`、
  htx `ts`），否则用本地观测时刻（bybit / gateio / kraken / bitfinex / coinbase）。两条被点名的陷阱：
  coinbase 的 `time` 是**最后成交时间**（薄标的实测可读到 449 秒前，会让消费方把当前有效报价读成陈旧）、
  bitfinex 数组下标 10 是上游坏值（实测 2019-03-11，两对都坏），两者都不当时间戳用。
- 登记面 / 工具枚举与 description / 设置页显示名 / 包 README 四节 / `scripts/tool-contract-freeze.json`
  在同一变更内同步；证据落在 `spikes/impl-ccxt-exchange-expansion/`（九所原始响应 + 出口说明 +
  可复跑 `run-probe.ts`）。

## Alternatives considered

- **给九所都补 K 线分支**：落选——撤形参是最小且不撒谎的收口；各所周期子集不同（coinbase 无 1w/1M、
  bitfinex 无 4h），补面还会把解析与证据量各放大一倍，且没有消费方要求按所取 K 线。
  **同日后续变更推翻了「没有消费方要求」这半条理由**：按所取 K 线由后续卡交付（九所端点、周期映射与
  行结构各有真实证据；实测还改了两处周期假设），见
  [ccxt quote 表与九所 K 线](2026-10-15-ccxt-per-exchange-quote-tables-and-klines.md)。
- **把共享 quote 表扩成各所白名单**：落选（本轮边界）——普查出的各所 quote 有数十个（kraken 另有
  GBP/JPY/CHF/CAD/DAI…、htx 另有 TUSD/HT/RUB…），扩表会把「共享近似」变成事实上的白名单却仍不可
  逐个验证；本轮先把「拼不出来就不发」定死，缺口写进 README 已知边界第 10 条。**该边界同日已交付**：
  改成按所维护 quote 表（每所一份、探针按普查规则现场复核），见
  [ccxt quote 表与九所 K 线](2026-10-15-ccxt-per-exchange-quote-tables-and-klines.md)。
- **把 `TRADING_SYMBOL_NOT_FOUND` 补进 `@dshtrading/api` 的 `TradingErrorCode`**：落选（本轮边界）——
  那是 api 的公共词汇变更（影响多个连接器与消费方的错误分支），本轮改用包内 `CcxtErrorCode`
  单点声明，**运行时错误码不变**；缺口记入 README 已知边界第 11 条。**该边界同日已交付**：收录进
  词汇表、包内别名下线，见
  [词汇表 note](../architecture/2026-10-15-trading-error-code-vocabulary-symbol-not-found.md)。
- **恢复「其余所名落 Binance 兜底」或只改文案**：落选（上一轮已裁决，理由不重复）。

## Consequences

- 九所 ticker 各有直连分支，登记面 = 实现面 = `crypto_get_ticker` 的 `exchange` 枚举；`crypto_get_klines`
  没有任何 `exchange` 参数，非 binance 的 `defaultExchange` 在 fetch 之前结构化拒绝（零请求）。
- 证据：`spikes/impl-ccxt-exchange-expansion/`——18 对原始响应（九所 ticker 200 + 默认出口
  binance 451 / bybit 403 阻断原文 + 三个「找不到符号」负例 + 可达出口窗口内的 binance K 线）、
  `EVIDENCE.md`（出口说明表 + Phase 2 连接器级实跑）、`run-probe.ts` 与 `probe-summary.json`
  （记 HEAD sha 与两个源文件内容指纹）。可达出口窗口只覆盖抓取时段，结束后已还原并复核出口 IP。
- 离线回归：`pnpm --filter @dshtrading/connector-ccxt test` 8 文件 49 例通过；包内 tsc 错误 10 →
  **6**（新增九处行级判空由 `CcxtErrorCode` 收口，新增 0 条）；`node scripts/test-audit.mjs` 无新增
  测试债；`node scripts/tool-contract-gate.mjs --update` 的唯一差异是撤掉的 `exchange` 参数。
- 当时记下的三条「剩余边界」（quote 表的按所覆盖缺口、`TRADING_SYMBOL_NOT_FOUND` 的 api 类型层缺口、
  K 线仍只有 binance 一条路径）**已于同日交付**：七条变换分支各有一份按所维护的 quote 表、该码收录进
  `TradingErrorCode`、K 线扩到九所（周期按所映射、该所不支持的周期零请求拒绝），见
  [ccxt quote 表与九所 K 线](2026-10-15-ccxt-per-exchange-quote-tables-and-klines.md) 与
  [词汇表 note](../architecture/2026-10-15-trading-error-code-vocabulary-symbol-not-found.md)。
