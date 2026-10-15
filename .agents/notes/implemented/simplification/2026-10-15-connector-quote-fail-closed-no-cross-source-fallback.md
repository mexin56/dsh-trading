# Agent Note: ibkr/tiger 行情面删除跨源回落，改 fail-closed

Status: implemented

## Problem

`connector-ibkr` 与 `connector-tiger` 的 `getTicker` / `getKlines` 用 `try/catch` 包住整段上游调用，
catch 里改打公共端点（Yahoo `query1.finance.yahoo.com` / 腾讯 `qt.gtimg.cn`、`web.ifzq.gtimg.cn`），
并把回落结果按本连接器自己的输出形状返回——回执里没有任何来源标记。三个后果：

- 网关未登录或故障时，用户与消费方拿到的是别家源的价格，却处在「选了 IBKR / 老虎」的语义下
  （`tradingMarketRouter.activeProvider('us') === 'ibkr'` 这类选择被静默改写）；
- 同一个 catch 把「网关回 200 但没有可用数据」也吞成静默降级：IBKR 快照缺 `31` 时 `parseFloat`
  得到 `NaN`，Tiger 业务码非 0 时直接 `return { price: 0, ... }`——伪行情与真报价在消费方无法区分；
- 回落分支在本仓没有真机证据（两包 README 的「状态」段写明未实证），周期语义也与主路径不一致
  （Tiger 回落恒日线，IBKR 回落忽略 `interval`）。

这与 `docs/current-state.md` 的 fail-closed 不变量 #6「跨源永不混显」相反。

## Decision

两包行情面只认各自网关一个源，采用 fail-closed（方案 A）：删除两处 `try/catch` 与全部回落分支，
错误映射固定为下表，价格判定统一为 `Number.isFinite(price) && price > 0`（0、负数、NaN 都视为
「没有可用价格」，绝不回伪行情）。

| 情形 | 错误码 | 来源 |
|---|---|---|
| 网关不可达 / 请求抛错 | `TRADING_NETWORK` | `requestJson` 既有映射，两包未动 |
| HTTP 非 2xx | `TRADING_UPSTREAM_ERROR` | `requestJson` 既有映射，两包未动 |
| IBKR：快照非数组 / 空数组 / `31` 非有限正数；`/hmds/history` 的 `data` 非数组 | `TRADING_EXCHANGE_ERROR`（消息带原样回包摘要） | 本次新增 |
| Tiger：业务码非 0；`code === 0` 但无可用报价行或 `latestPrice` 非有限正数；K 线 `data` 非数组或 `items` 非数组 | `TRADING_EXCHANGE_ERROR`（业务码分支与同文件 `getBalance`/`getPositions` 同口径） | 本次新增 |
| 上游明确的空序列（两包 `data: []`） | 返回 `[]`（合法空值，不升级为错误） | 本次新增 |

测试：两包夹具（`fake-ibkr-venue` / `fake-tiger-venue`）扩展出行情面与故障注入（网关抛错、非 2xx、
业务码错误、空回包、不可识别回包），逐条记录收到的 URL 并对非测试网关地址抛错；新增
`test/market-data-fail-closed.test.ts`（IBKR 10 例 / Tiger 9 例）断言错误码与「零跨源出网」。
反证：把两包 `rest.ts` 换回 HEAD 实现后 IBKR 8/10、Tiger 7/9 用例变红（正常路径与「空序列合法」
两例两版都过），恢复后文件 md5 与原文件一致。

文档：两包 README 按零跨源回落重写（含按新行数重算的全部 `src/rest.ts:NNN` 引用与错误映射条目）；
Tiger 的 `package.json` description 去掉「网关不可用时静默回落腾讯公开源」。

同类先例（同一条「不静默降级」纪律在别处的落点，各自的事实归各自的记录）：
`feature/2026-10-08-contract-trading-tier2-semantics-and-gates.md`（Binance 合约下单不回落现货端点）、
`architecture/2026-08-29-okx-dual-connector-and-demo-gate.md`（存在 credentials seam 即 fail-closed，
不回落 ambient 环境变量）。

## Alternatives considered

**B：保留回落但显式标注来源**（返回值与工具回执带 `source: 'yahoo' | 'tencent' | 'gateway'`）。
落败原因有三：① `Ticker` / `Kline` 契约（`packages/api/src/index.ts:53`、`:75`）没有 `source` 字段，
B 要动 `@dshtrading/api` 这个跨市场公共契约，触面是全部连接器与消费方；② 更根本的是 B 会伪造来源——
「网关 200 但没有数据行」这条路径返回的 `price: 0` / `NaN` 在 B 下恰好会被标成 `gateway`，
标注没能解决问题，反而把「无数据」写成「来自券商的 0 价」；③ 回落分支没有任何真机证据，
保留它等于把一个未实证的静默分支留在用户据以决策的数据路径上。

## Consequences

- 两包行情可用性等于各自网关可用性：IBKR 需要用户本机 Client Portal Gateway 在线且已登录，
  Tiger 需要网关可用且凭证有效；失败以结构化错误呈现，不再有「看起来有数据」的降级。
- 公共源只能由用户显式选择 `connector-yahoo` / `connector-tencent` 得到，其 ToS 边界分别归这两个包的
  README（两包 README 的「合规记录」已按此改写，本仓不缓存、不再分发任何行情数据）。
- 消费方（GUI 行情卡、`us_get_ticker` / `hk_get_ticker` 工具、`subscribeTicker` 轮询）在网关故障时
  收到错误，而不是 0 价或别家价格——这是本次变更的目的，代价是此前被静默掩盖的网关不可用状态
  会显式暴露。
- 未实证：网关真机的错误码分布与「未登录时快照回什么」仍无出网证据（本仓没有 ibkr/tiger 的探针），
  错误映射按上游文档与源码推导。
- 删行让两包源码行号整体位移，README 的行号引用已逐条重算；后续再改这两个包需同样处理。
