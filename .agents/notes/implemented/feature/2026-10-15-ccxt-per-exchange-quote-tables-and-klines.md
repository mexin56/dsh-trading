# Agent Note: connector-ccxt 按所维护 quote 表并把 K 线切到九所

Status: implemented

## Problem

- 同日两张卡把 ccxt 所名面先收窄、再补齐之后，仍留着三条边界（见
  [九所 ticker 分支](2026-10-15-ccxt-nine-exchange-ticker-branches.md) 的 Consequences「剩余边界」）：
  ① 需要形态变换的七条分支（okx/kucoin/gateio/kraken/coinbase/bitfinex/htx）共用 8 个 quote 后缀
  （`QUOTE_SUFFIXES`），而各所真实挂牌的计价币远多于此——`BTCJPY` 在 kraken 上确实存在、在 gateio 上
  不存在，共享表把两者当成同一件事；
  ② `TRADING_SYMBOL_NOT_FOUND` 被 8 个连接器实际抛出却不在 `@dshtrading/api` 的 `TradingErrorCode` 里，
  ccxt 只能在包内声明 `CcxtErrorCode` 收口；
  ③ `getKlines` 只有 binance 一条路径且不吃所名（撤形参那次是「最小且不撒谎的收口」）：用户拿不到
  其余八所的 K 线，而每所的端点、周期词汇与行结构都不同。
- 三条都要真值：quote 资产集必须来自该所公开挂牌端点的普查；K 线的周期映射必须逐所实测（哪些档位
  该所根本不接受）；错误码收录必须核对全仓消费方。

## Decision

- **quote 表按所维护**：`QUOTE_TABLES`（`packages/connector-ccxt/src/rest.ts`）为七条变换分支各存一份
  资产表，`splitPair(symbol, exchange)` 只按**该所**的表最长优先切 base+quote。表内容 = 该所公开挂牌
  端点普查结果：okx 13（`/api/v5/public/instruments?instType=SPOT` 的 `quoteCcy`）、kucoin 10
  （`/api/v2/symbols`）、gateio 8（`currency_pairs`）、kraken 24（`AssetPairs` 的 `wsname` quote 段——
  kraken 的 `quote` 字段是 Z/X 前缀旧代号 `ZEUR`/`XXBT`，请求符号用现代形）、coinbase 13
  （`products`）、bitfinex 9（`pair`+`currency` 两个 conf 端点取最长货币后缀，`UST` 归一成 `USDT`）、
  htx 20（`settings/common/symbols` 的 `qcdn`）。表外计价币仍是本地 `TRADING_UNSUPPORTED_SYMBOL` 且零请求；
  binance/bybit 不经过任何表。
- **K 线九所按所取**：`KLINE_EXCHANGES` 登记九所，`getKlines(symbol, interval, limit, exchange)` 逐所
  打自己的端点、按所解析行结构（gateio/kucoin 行的 OHLC 排列与 binance 不同、kraken 的 `result` 里除
  pair 数组还有一个 `last` 数字、htx 是对象数组），`volume` 一律取基础币量；输出一律**升序（旧→新）**、
  按 openTime 去重、只留最新 `limit` 根（只有 binance/kraken 的上游本来就是升序）；单请求根数按所上限
  裁剪（okx 300、binance/bybit/gateio 1000、bitfinex 10000、htx 2000；kucoin/kraken/coinbase 没有根数
  参数，回多少切多少），**不翻页**。
- **周期按所映射，不支持的档位零请求拒绝**：`KLINE_INTERVAL_PARAMS` 逐所存映射（kraken 分钟数、
  coinbase 秒、bybit 单字母、okx 取 `1Dutc`/`1Wutc`/`1Mutc` 与 connector-okx 同裁决、htx
  `1day`/`1mon`、gateio 1w→`7d`），该所不支持的档位抛 `TRADING_UNSUPPORTED_INTERVAL`
  （照 connector-okx 的既有范式）。**实测与卡的假设有两处出入，按实测落表**：coinbase 也没有 30m 与 4h
  （granularity 1800/14400 都回 400 `Unsupported granularity`，卡上只写了「无 1w/1M」）；bitfinex 的 4h
  上游接受（卡的假设是「无 4h」）。故词汇表内不支持的集合是 coinbase {30m,4h,1w,1M}、gateio/kucoin {1M}，
  其余六所支持全部九档。
- **`exchange` 只进连接器自有面**：客户端方法收第四形参、`crypto_get_klines` 工具加 `exchange`
  （枚举 = `KLINE_EXCHANGES`）；`@dshtrading/api` 的
  `MarketDataService.getKlines(symbol, interval, limit?)` 不动，服务缝 `CcxtMarketDataService.getKlines`
  保持三形参与契约同形，工具经公开的 `CcxtMarketDataService.client` 走客户端方法。
- **错误码词汇表收敛**：`TRADING_SYMBOL_NOT_FOUND` 收录进 `@dshtrading/api` 的 `TradingErrorCode`，
  包内 `CcxtErrorCode` 下线、`TradingServiceError.code` 恢复为 `TradingErrorCode`（运行时错误码不变）；
  理由、消费方核查与另外两处注释保鲜见
  [词汇表 note](../architecture/2026-10-15-trading-error-code-vocabulary-symbol-not-found.md)。
- **证据**：`spikes/impl-ccxt-exchange-expansion/`——七份挂牌普查原始响应 + 九份 K 线原始响应
  （binance/bybit 在可达出口窗口内取）+ 六份「上游 400 不支持周期」原文；
  `run-probe.ts` 扩到 63 条判据（九所 ticker + 每所一条非 USDT 对 + 七所 quote 表现场复核 + 九所 K 线
  两档周期逐字比对 + 逐所不支持周期/表外计价币零请求负例），**退出码 0、63/63 PASS**；
  出口窗口结束后已还原并**实测出口 IP** 复核（keep-alive 会让只读 selector 造假阴性）。

## Alternatives considered

- **把各所 quote 表并成一份超集**：落选——那份表既不是任何一所的真相，又会把「本地能判的事」推给网络
  （gateio 的 `BTCJPY` 会拿到上游的 `INVALID_CURRENCY_PAIR`）。
- **各所表只登记常见 fiat（剔除 TEST\*、XAUT、SOL 等）**：落选——表必须等于普查结果，否则「表 = 该所
  挂牌计价币」这句话不再可复验；探针按同一条规则现场复核，人工删减会让判据 FAIL。
- **K 线按所翻页取满 limit（照 connector-okx 的 after 游标）**：落选（本卡边界）——九所游标语义各异
  （kucoin `startAt/endAt`、gateio `from/to`、coinbase 分页…），先把「按所取 + 该所不支持的档位零请求
  拒绝」定死；单请求上限内的最新 limit 根已够消费方看近期结构。
- **把 `exchange` 加进 `MarketDataService.getKlines`**：落选——那是 api 契约变更（所有市场与消费方一起
  动），而按所取 K 线只有 ccxt 这一家有；契约同形、形参留在自有面更小也更诚实。
- **保留 `CcxtErrorCode` 别名不改 api**：落选（上一轮的边界）——别名只让一个包自洽，另外 7 个包继续
  各带同类 tsc 债，bybit/qmt 的注释也继续传播「词汇表里没有」这个过时事实。

## Consequences

- 七条变换分支的 quote 表各不相同且可复验：探针 `quote-census.<所>` 把代码表与现场响应的派生集合逐字
  比对，上游新增 quote 而表未跟进即 FAIL（刷新方式 = 重跑普查 → 更新表 → 重跑探针）。
- K 线九所按所取，`crypto_get_klines` 的 `exchange` 枚举 = `KLINE_EXCHANGES`（九所）；该所不支持的
  周期与未登记 slug 都在 fetch 之前结构化拒绝（探针逐所一条零请求判据证明）。
- 与上一轮的两条事实反向：K 线的 `exchange` 形参**恢复**（但只到连接器自有面），K 线不再「只有 binance
  一条路径」；`KLINE_EXCHANGES` 从用途单一的守卫表变回真正的登记面。
- 离线回归：`pnpm --filter @dshtrading/connector-ccxt test` 9 文件 55 例通过（新增
  `test/klines-per-exchange.test.ts`：九所端点/行结构/周期映射/根数裁剪）；包内 tsc **6 条**
  （与上一轮同，均为基线的存量债）；`pnpm --filter @dshtrading/api test` 3 文件 15 例通过。
- 未做（本卡边界）：K 线翻页取满 limit；各所私有账户面与合约面；`CcxtRestOptions.apiKey`/`secret`
  两个已不参与请求的字段仍是 tsc 存量债（见包 README 已知边界第 9 条）。
