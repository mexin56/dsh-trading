# Agent Note: 连接器周期闸门与取价语义（fmp / longbridge / polygon）

Status: implemented

## Problem

`@dshtrading/api` 的 `Interval` 是 15 档规范联合（`packages/api/src/index.ts:25-40`），
而每个连接器实际能服务的只是其中一个子集。三个连接器各用不同方式掩盖了这个差：

- **connector-fmp**：`toFmpInterval` 的 `default` 分支只产出 `1day`，`getKlines` 的 `isIntraday`
  也只含 6 个日内档。请求 `1w`/`1M` 拿到的是**日线序列**（只有 `closeTime` 按 7 天/30 天步长标注），
  `3m/2h/6h/8h/12h/3d` 连步长都是 `undefined` → `NaN`。周期语义与返回粒度不一致。
- **connector-longbridge**：`toLongbridgePeriod` 与 `parseIntervalMs` 的 `switch` 既无 case 也无
  `default`，`3m/2h/4h/6h/8h/12h/3d` 返回 `undefined` → 出站请求拼出 `period=undefined`、
  `closeTime` 为 `NaN`（工具面被 enum 挡住，服务直调可达，后果当时未实证）。
- **connector-polygon**：`getTicker` 打 `/v2/aggs/ticker/<SYM>/prev`（官方语义 Previous Close，
  上一交易日聚合、默认 `adjusted=true` 复权价），工具描述却写 "Get the latest trade price and
  quote"，`price` 被当成实时价消费。`Ticker.timestamp` 直接取 `results[].t` 的单位当时未核对。

## Decision

**每个包导出的周期词汇表就是该包的真实支持集，表外周期一律显式抛 `TRADING_UNSUPPORTED_INTERVAL`，
不静默降级。** 闸门形态三包一致：

- 新增 `assertSupportedInterval(interval: Interval): asserts interval is SupportedInterval`，并导出
  `SupportedInterval = (typeof INTERVAL_VOCABULARY)[number]`（fmp `src/rest.ts:31-46`、
  longbridge `:26-41`、polygon `:31-46`）。断言签名而非 `void`：收窄后下游 `switch` 对词汇表穷尽，
  「漏掉一档映射」成为编译错误而不是运行期回落，同时消掉五条存量 `TS2366`。
- `toXInterval` / `parseIntervalMs` 先过闸门，`switch` 覆盖词汇表全部档位且无 `default`。
- 服务方法在**分支判定/取 period 之前**显式过闸门（fmp `getKlines` `:142`、longbridge `:204`、
  polygon `:157`）——否则表外周期会绕过映射函数继续发请求。测试断言「出站 URL 数为 0」把这条钉住。
- 拒绝码与消息风格沿用 connector-xysz 既有语义（见
  [xysz 连接器决策](./2026-09-28-xysz-amazingdata-cn-data-source.md)）：`'<Upstream> upstream does
  not serve interval "<x>"; supported: ...'`。
- 词汇表取值：fmp 收窄为 7 档 `1m/5m/15m/30m/1h/4h/1d`；longbridge 保持 8 档
  `1m/5m/15m/30m/1h/1d/1w/1M`；polygon 保持 9 档 `1m/5m/15m/30m/1h/4h/1d/1w/1M`。
  工具参数 enum 直接引用词汇表，因此收窄自动传导到工具面。

**fmp 的 `1w`/`1M` 选择拒绝而不是补端点**：FMP 官方文档枚举的 K 线端点只有 6 个日内档
（`/historical-chart/<interval>/<SYM>`）+ 日线 EOD（`/historical-price-full/<SYM>`），**没有原生
周/月端点**；官方 how-to 明确教客户端从日线 resample。本机无 FMP 凭证，任何新增端点都拿不到真实响应
证据，因此本包既不加端点也不做本地 resample（hithink 的「3d/1w/1M 由日线本地聚合」先例不适用于本轮）。

**longbridge 的 `3m`/`2h`/`4h` 也不映射**：官方口径自相矛盾——现代口径（objects 页 Period 定义表、
proto `quote/api.proto`、Node/Rust/Python SDK 枚举、官方 skills 字符串表）含 `3 Minutes` /
`Two Hours` / `Four Hours`（字符串 `3m` / `120m` / `240m`），旧口径（CLI 文档、Go SDK 注释、
objects 页 Protobuf 代码块）只承认 `1m/5m/15m/30m/60m/day/week/month/year`；`6h/8h/12h/3d` 在任何
口径里都不存在。更关键的是 K 线**在官方 REST 参考里没有登记 HTTP 端点**（39 个登记了 `HTTP URL` 的
接口里没有 `/v1/quote/candlesticks`，candlestick 页只给 gRPC/protobuf 面），本包打的这条路径属文档未载。
本地清晰拒绝优于依赖未实证的上游行为。

**polygon 保留 `/prev`，只把语义写实**：端点与返回结构不动，语义写进 `us_get_ticker` 的工具描述与
README——`price` 是上一交易日收盘聚合（默认复权）、`timestamp` 是聚合窗口起点的 Unix 毫秒。
`results[].t` 的单位经官方字段定义核对为**毫秒**（REST aggregates 一律毫秒，trades/quotes 才是纳秒），
与本仓 `Ticker.timestamp` 的 epoch ms 契约一致，**无需换算**。不改端点的判据：免费 Basic 档下
`/v2/snapshot/...`、`/v2/last/trade`、`/v2/last/nbbo` 全部 Not included；延迟档从 Starter $29 起，
`/v2/last/trade` 需 Developer $79，NBBO 需 Advanced $199，且这些端点的时间字段是纳秒。本机无
`POLYGON_API_KEY`，替换端点同样拿不到真实响应证据。取价路径的降级契约见
[Ticker 派生快照决策](../feature/2026-10-14-quote-path-degradation.md)。

## Alternatives considered

- **fmp 补原生周/月端点**：上游不存在该端点，只有 stable/legacy 的日线 EOD；且接入需要凭证出网验证，
  本轮无凭证。落败。
- **fmp 本地 resample 出真周/月线**：能保住 `1w`/`1M` 能力，但要新增一条未经出网实证的聚合路径，
  并定义周界（ISO 周 vs 美东自然周/月）与 OHLCV 聚合口径；在「消除歧义」这一目标下，收益不足以承担
  未实证面。落败（本轮）。
- **longbridge 映射 `3m`/`120m`/`240m`**：这三个字面量在现代官方口径里有登记，但本包使用的 HTTP 路径
  文档未载、无凭证无法实测；映射等于把确定性换成不确定行为。落败。
- **polygon 改打 `/v2/snapshot/...` 或 `/v2/last/trade`**：需要付费 plan，会让免费档部署直接失败，
  且新端点时间字段是纳秒需 `/1e6` 换算。落败。
- **闸门用 `: void` + 各 `switch` 补 `default: throw`**：可编译，但同一份消息要重复两份，且 `void` 不
  收窄类型——fmp `toFmpInterval` 会**新增**一条 `TS2366`（18→19），typecheck 棘轮只许降，直接判红。
  落败。
- **长期口径改为「工具 enum 保留全 15 档、由服务层抛码」**：会让工具参数校验与错误码不一致（消费者
  拿到的是参数校验失败而非 `TRADING_UNSUPPORTED_INTERVAL`）。维持「enum = 词汇表 = 支持集」，与
  xysz/alpaca/tencent/yahoo 既有形态一致。落败。

## Consequences

- 消费方按 `code === 'TRADING_UNSUPPORTED_INTERVAL'` 分支即可，不解析文案；三包各有逐档断言钉住
  支持集与抛码行为，并各有一条「表外周期出站 URL 数为 0」的断言证明不静默降级。
- fmp 的 `1w`/`1M` 由「拿到日线」变为显式拒绝：**能力收窄**，属纠正而非回归；需要周/月线的调用方
  应改用原生支持周/月的 source（如 connector-polygon）。
- 三包 `tsc --noEmit` 存量错误数下降（fmp 18→17、longbridge 23→21、polygon 15→13），减少的正是
  五条 `TS2366`（fmp 1 条、longbridge 2 条、polygon 2 条）——三包的 `switch` 均已穷尽。
  计数低于 `scripts/typecheck-baseline.json` 基线**不构成违规**（门禁只判「超基线 / 新 tsconfig /
  基线含已消失配置」），故未刷新基线，避免在并发会话期间重写共享快照。
- 既有正确路径未动：符号归一、签名、日线/分钟内取数与排序、错误映射、`closeTime` 算术、
  longbridge 的 `timestamp * 1000`（官方为 Unix 秒）均保持原样。
- 三包 README「周期与契约」「已知边界」两段已改写为与代码一致的事实，并重核了因插行而移动的
  `src/*.ts:NN` 全部引用；上游能力结论一律标注「官方文档所述，本仓未出网实测」。
