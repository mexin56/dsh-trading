# Agent Note: 批量报价能力 getTickers（自选栏每市场每拍 N 次请求降成 1 次）

Status: implemented

## Problem

GUI 左侧自选栏每 8s 一拍按市场取价（MarketSidebar 的报价轮询；持仓抽屉与行情舞台另有消费方），
而桥的 `/dshtrading/api/tickers` 对每个 symbol 独立调 `MarketDataService.getTicker`——N 只自选
就是 N 次上游请求。自选到几十行时，一拍几十次公共端点请求：既把并发的延时叠成一批，也逼近免密
公共源的限频边界（东财公共端的限频敏感性 2026-09-08 已有实测记录）。而数据源侧早有原生批量端点：
东财 `ulist.np/get?secids=a,b,c`、腾讯 `qt.gtimg.cn/q=a,b,c` 都吃逗号列表，一次请求即可取全。

## Decision

`MarketDataService` 增**可选**方法 `getTickers?(symbols: string[]): Promise<Record<string, Ticker>>`，
语义四条（写在契约注释里，调用方与实现共同遵守）：

- 键 = **入参原字符串**（调用方按它一一对应），值 `Ticker.symbol` 仍是市场规范形；
- 只返回**确实拿到**的标的：未收录/无法解析的符号不出现在结果里，由桥回落 `getTicker` 单取，
  保住各符号自己的错误码（`TRADING_UNSUPPORTED_SYMBOL` / `TRADING_SYMBOL_NOT_FOUND`）；实现不得为凑齐入参造假行；
- 整批取数失败（网络/上游故障）抛出，桥按整批失败上报，不做 N 次重试；
- 实现不分片，单次请求标的数由调用方按桥侧 `MAX_SYMBOLS`（32）裁剪。

桥侧 `TradingBridge.tickers()`：有 `getTickers` 时一次调用取全批，只有**缺行**（含批量返回
`null`/非对象这类契约外坏值，由 `isBatchTicker` 守卫收口）的符号才逐个回落 `getTicker`；整批抛错时
全批记同一份 `errorPayload` 信封并直接返回；无 `getTickers` 的连接器逐只路径逐字节不变；结果键序
始终等于入参顺序。

实现的两个连接器（本机 cn/hk 活跃源是 eastmoney；tencent 是仓内 `DEFAULT_MARKETS` 的 cn/hk 默认源，
两者都做才有覆盖面）：

- **connector-eastmoney**：同一条 `ulist.np/get` 传多 secid。行→符号用响应行的 `f13`+`f12` 拼回 secid
  再查请求表，**不依赖上游返回顺序**；取价仍按行 `f1`（该端点事实见
  [eastmoney hk 市场记录](2026-09-08-eastmoney-hk-market.md)）。单标的与批量共用同一个 `parseQuoteRow`。
- **connector-tencent**：`q=<wire,wire,…>` 一次请求，整段 GBK 文本按 `v_<wire>="…"` 拆行。行正则、字段
  校验、Ticker 出口都从单标的路径抽出共用。wire 按入参原样拼 URL——**hk 指数 wire 大小写敏感**
  （`r_hkHSI` 有行、`r_hkhsi` 返回 `v_pv_none_match="1"`，2026-10-14 实测），只有响应查表键小写归一，
  规范形由请求侧持有的符号还原（否则指数会变成 `hsi.HK`）。

## Alternatives considered

- **不改契约，只在桥侧逐只并发**：现状就是 `Promise.all` 逐只并发——延时能摊平，请求数仍是 N，
  限频与上游压力一点没减。
- **桥侧加进程内报价缓存/TTL**：请求数会降，但引入"多久算新鲜"的策略债，且首拍与刷新仍是 N 次；
  批量端点把请求数直接压到 1，缓存收益与之不叠加。
- **只做 eastmoney**：本机够用，但 tencent 是仓内默认 cn/hk 源，默认路由下拿不到收益；两个端点都已实证，一起做。
- **把 `getTickers` 定为必选方法**：绝大多数连接器没有原生批量端点，定为必选会逼它们为凑契约写 N 次循环；
  可选方法 + 桥自动回落才是诚实形状。
- **连接器内部分片（超过 32 只自动拆多请求）**：调用方已按 `MAX_SYMBOLS` 裁剪，再分片只把契约变复杂；
  实测 40 个 secid / 40 个码单请求都正常。

## Consequences

- **8s 报价轮询**的上游请求数降到「每个市场 1 次」（对实现了批量能力的源）。实测：cn 5 只 1 次请求、
  hk 2 只 1 次请求、空入参 0 次请求。走势迷你图的 K 线序列是另一条路径（60s 节拍，仍每行一次），不受本变更影响。
- 单只取价（行情舞台、Agent 工具调用）不受影响：单标的路径与批量共用同一解析器，实测同标的读数一致。
- 契约是公开可选能力，bubble 连接器可自行实现；坏值（`null`/非对象）被桥挡在 `{ok:true}` 之外——
  前端 `displayTickerEqual` 不会再因 `prices[key]` 是 `null` 而抛 TypeError。
- 其余连接器维持逐只路径，行为逐字节不变。
- 真实网络证据：spikes/impl-eastmoney-quote-endpoint/（p2 探针 + EVIDENCE 的「附.」节）、
  spikes/impl-tencent-quote-batch/（r0 探针 + 原始 GBK 响应 + 零网络离线重放）；用例见两个连接器各自的
  getTickers describe 与 bot-api 的批量用例。
