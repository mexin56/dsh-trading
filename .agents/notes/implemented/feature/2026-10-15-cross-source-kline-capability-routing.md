# Agent Note: 跨源 K 线能力路由（连接器能力声明 + 桥按能力换源）

Status: implemented

## Problem

客户端视图级别「行情·五日」（`'5d'`）的取数是**固定**的 `fetchKlines(market, symbol, '1m', 2500)`
加本地按交易日分组——它需要最近 5 个交易日的 1 分钟 K 线。而腾讯 A 股公开端点对 1m 是结构性
拒绝（`TRADING_UNSUPPORTED_INTERVAL`，`mkline` 端点没有 1m 档），港股更连分钟线全不支持。

于是「五日级别可不可得」这个问题，此前由客户端一张硬编码的 `(市场, 路由 provider)` 白名单
（`CAPABLE_ROUTES = us/yahoo、cn/eastmoney、hk/eastmoney`）回答。用户在设置里把 cn/hk 路由切到
腾讯，白名单不命中 → 判 `no` → 级别从胶囊里消失、回落守卫还把记忆改写成 `1d`。

但**数据本来就在**：cn/hk 的 bundle 同时装着 tencent 与 eastmoney 两个 dataplane
（`enabled: true`，注册不按路由过滤），路由只决定谁 `active`；东财 `trends2 ndays=5` 能诚实
给出最近 5 个交易的 1m（实测 cn 1061 根 / hk 1421 根，见
[spike 证据](../../../../spikes/impl-cross-source-kline-routing/EVIDENCE.md)）。缺的不是数据源，
而是「当前源结构性没有这份能力时，去同市场其它已注册源取」这条解析路径——以及客户端据以
判断级别可得性的**事实来源**。

## Decision

**能力由连接器声明，路由由桥按能力裁决，客户端只读桥上报的并集。**

1. **声明面（`@dshtrading/api`）**：`MarketDataService` 新增**可选**方法
   `klineCapabilities?(): readonly KlineCapability[]`，`KlineCapability = { interval, maxBars }`。
   `maxBars` 是本源**能承接的 `limit` 上限**，不是返回根数保证（窗口型源按自己的窗口给根数，
   但不得因请求更大而静默降级到更浅的历史）；方法缺席 = **未声明**，不是「不支持」。
2. **桥的候选序（`bot-api/bridge.ts`）**：`active` 在最前，其后 `registry.list(market)` 其余项
   按 `provider` 名升序（沿用 [#resolveSouthboundService](2026-10-12-hk-connect-holding-indicator.md)
   的既有约定）。选择规则：active 声明覆盖请求 → 用 active；否则取候选序中第一个声明覆盖者；
   无人声明覆盖 → 用 active（未声明路径）。
3. **换源只由结构性错误触发**：仅当被选中的服务抛 `TRADING_UNSUPPORTED_INTERVAL` 时，沿候选序
   继续试下一个未试过的候选（不论它是否声明——声明是预判，错误码才是事实）；耗尽则原样抛最后
   一个错误。**其它任何错误码（网络/限流/坏符号/交易所错误）一律原样抛，绝不换源**：不得把
   「这个源现在答不出」掩盖成「另一个源的数据」。
4. **wire（客户端的事实来源）**：`/klines` 响应带 `provider`（本次**实际供数**的 slug，问不到时
   省略）；`/markets` 每项带 `klineCapabilities`（该市场**全部注册项**声明的并集，同周期取最大
   深度；无声明则字段缺席）；`/tickers` 新增可选 `provider`（必须是该市场已注册项，未注册或注册表
   缺席一律 400，不静默降级到 active）。
5. **连接器声明**（本批三个，其余连接器不声明、走错误码路径）：腾讯 cn `5m/30m/1d/1w/1M@800`、
   hk `1d/1w/1M@800`（800 = `mkline` 单请求上限，超过上游静默降到 320；**不含 1m**）；东财
   cn/hk 8 周期 @2500（1m 走 `trends2 ndays=5` 窗口）；雅虎 `1m@2730`（`range=7d` 实测）与其余
   周期 @2500（承接闸门）。
6. **客户端**（`client-ui-trading`）：`'5d'` 判据改为「并集里存在 `1m` 且 `maxBars ≥
   FIVE_DAY_KLINE_LIMIT`」；并集缺席仍是 `unknown`（保留记忆、不动，绝不判不可得）；
   `CAPABLE_ROUTES` 删除，`chartIntervals`/`supportedIntervals`/`fiveDayCapability` 改收能力并集。
7. **跨源时该级别同源取价**：五日级别的 bar 来自非 active 的源时，该级别的 ticker 也向同一
   `provider` 取（`/tickers?provider=`），且只在 ticker 与 bar **同源**时才 `withTickerBar`
   合并进最后一根；同源或来源未知时维持现行 5s 合并。合流判定发生在 ticker 响应回来当刻
   （用当时的序列来源），否则在途的跨源报价会合并进切级别后的新序列。
8. **来源静默**（owner 裁决）：GUI 不标注数据来源，事实只落实现与本记录。

## Alternatives considered

- **只为五日级别开一条特例取数口（窄修）**：否决——owner 裁决要的是通用能力路由；且窄修会
  把「腾讯路由下港股分钟线全不可得」这个同源缺口留着（该缺口由本机制一并补齐）。
- **客户端扩白名单（cn/hk 认 tencent 也可得）**：否决——把「另一个源装着」硬编码进客户端，
  与安装实况脱节：卸载东财、或某个源声明能力变化时客户端不会跟着变，且违反「一个事实只有一个家」。
- **纯错误码探测（不加能力声明契约）**：否决——每次跨源都先打一次注定失败的请求，且客户端
  无从预知级别可得性（胶囊会出现「有、点了取不到」）。
- **上游失败也换源（静默回落）**：否决——违反本仓 fail-closed 铁律（同类前车之鉴：connector-tiger
  曾在上游失败时静默回落腾讯公开端点，现行判据是 `packages/connector-tiger/test/market-data-fail-closed.test.ts`
  的「零跨源出网」断言）；换源必须只由**结构性缺能力**触发，否则故障与能力缺口不可区分。
- **注册时给源打「可参与跨源」开关**：否决——多一个需人工维护的配置面，而能力声明本身已经
  表达了「能不能供这份数据」。
- **让客户端自己按标的探测哪个源可用**：否决——探测成本进客户端、且与桥的裁决可能不一致；
  客户端只信任桥的解析结果。

## Consequences

- 用户可见：cn/hk 路由为腾讯时「行情·五日」照常出现（1m 与最新价同源自东财）；腾讯路由下港股
  分钟级别由东财补齐；`us/yahoo`、`cn/eastmoney`、`hk/eastmoney` 行为不变（active 声明覆盖请求
  → 永远用 active，零跨源）。
- 未声明能力的连接器（crypto/futures/global 等）行为与改动前逐字一致：只有 `active` 可用，
  出错照旧。
- 换源面很窄：客户端日线档 `limit=750`、其它级别 500，均落在腾讯声明的 800 之内，所以实践中
  只有五日的 `1m/2500` 触发跨源（实测 cn `1d/750` 仍由腾讯供数）。
- 五日级别末根的价格源 = 该级别 bar 的来源（跨源时同源取价）；头部报价仍是路由源的报价。
- `maxBars` 是承接闸门语义：东财声明 2500 而实际返回 5 个交易日的根数（cn≈1061/hk≈1421），
  这是「诚实承接、按自己窗口给根数」，不是「返回 2500 根」的承诺——消费方不得据此断言根数。
- 验证：`bot-api/test/bridge-kline-cross-source.test.ts`（候选序 / 规则 a·b·c / 错误码兜底 /
  候选耗尽 / markets 并集 / tickers 指定源与 400）、三个连接器的
  `test/kline-capabilities.test.ts`、`client-ui-trading` 的 `five-day-series` /
  `market-providers` / `quote-stage.smoke` 用例；真实网络原始响应见
  [spike 证据](../../../../spikes/impl-cross-source-kline-routing/EVIDENCE.md)。
