# @dshtrading/connector-polygon

> **状态：未实证（本仓无该上游的出网证据）**。截至 2026-10-14 检索：`spikes/` 下没有针对 Polygon.io
> 的出网脚本或原始响应目录；[`spikes/impl-service-seam-gate/NET-VERIFY.md`](../../spikes/impl-service-seam-gate/NET-VERIFY.md)
> 的真实网络验证只覆盖 OKX 公共端点，其「范围与未验证项」一节明确写明 fmp/polygon/finnhub 等模拟 stub
> 的服务缝三态由离线矩阵 `test/trade-gate.test.ts` 覆盖。另 [`spikes/impl-orderbook-ticks/EVIDENCE.md`](../../spikes/impl-orderbook-ticks/EVIDENCE.md)
> 第 32 行记有「us 盘口未实现：alpaca/polygon/ibkr 均需凭证或本地网关，本轮不接」——那是**未接**的结论，
> 不是能力证据。本 README 的端点、字段与能力面全部读自源码，不含任何实测结论。

Polygon.io（Massive）商业数据源美股连接器（`us` 市场，BYOK），实现 `@dshtrading/api` 的
`MarketDataService` 与 `TradeService`，被 `packages/us` bundle 以 `workspace:*` 依赖
（`packages/us/package.json` 第 35 行）。对外提供报价 / K 线 / 标的资料三个工具；
**不注册任何下单或撤单工具**，交易服务只经服务注入面可达。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活 Polygon 连接器（`src/index.ts:43`）；`false` 时 `apply` 静默退出（`src/index.ts:167`） |
| `env` | `'demo'` | 运行环境（`src/index.ts:44`）；**当前实现未读取该字段**，`demo`/`live` 无分流效果，见「已知边界」 |
| `dryRun` | `true` | 默认模拟下单（`src/index.ts:45`）；为真时 `placeOrder` 走本地模拟回执（`src/index.ts:118`） |
| `liveTrading` | `false` | 是否允许实盘交易（`src/index.ts:46`）；非权威镜像，实盘授权由 `@dshtrading/authority` 的人工签署平面裁定（`src/index.ts:90`） |
| `apiKeyRef` | `'POLYGON_API_KEY'` | Polygon API Key 的环境变量名（BYOK）（`src/index.ts:47`） |

## 接线

- **数据面行**：`packages/us/cordis.patch.yml` 第 38-41 行 → 行 id `dsh-trading-us-dataplane-polygon`，
  入口 `@dshtrading/connector-polygon/dataplane`，行 config 只写 `enabled: true`；
  该入口把 `(us, polygon)` 注册进 `tradingMarketDataRegistry`（`src/dataplane.ts:24-25,35-37`）。
- **preset 行**：`packages/us/assets/preset/us-trader/agent.cordis.yml` 第 90-102 行 → 组 id
  `dsh-trading-us-connector-polygon-group`（`isolate` 键 `tradingUsMarketData` + `tradingUsTrade`，第 93-95 行），
  组内行 id `dsh-trading-us-connector-polygon`（第 97 行），行 config 只写 `enabled/dryRun/liveTrading`（第 100-102 行）。
- **bundle 依赖**：`packages/us/package.json:35`（`workspace:*`）。
- **provider 词汇**：`packages/router/src/index.ts:72` 的 `PROVIDER_VOCABULARY` 含 `polygon`；
  本包导出 `ROUTER_PROVIDER = 'polygon'`（`src/index.ts:157`），`routeAllows` 只在 `us` 市场当前激活
  provider 为 `polygon` 时激活本实例（`src/index.ts:159-164`）。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:34`
  （`{ id: 'polygon', label: 'provider.polygon', url: 'https://polygon.io', env: 'POLYGON_API_KEY', type: 'commercial', markets: ['us'] }`），
  文案见 `src/client/locales.ts:246`（zh）与 `:392`（en），界面显示 `Polygon.io (Massive)`。
- **服务键**：`tradingUsMarketData`（`src/index.ts:50`）、`tradingUsTrade`（`src/index.ts:51`）。

## 上游端点

基址 `https://api.polygon.io`（`src/rest.ts:76`）；API key 以 `apiKey=` 查询参数附加（`src/rest.ts:83`）。

| 用途 | 端点 | 源码 |
|---|---|---|
| 报价（上一交易日聚合） | `GET /v2/aggs/ticker/<SYM>/prev` | `src/rest.ts:118` |
| K 线 | `GET /v2/aggs/ticker/<SYM>/range/<multiplier>/<timespan>/<from>/<to>?limit=<limit>&sort=asc` | `src/rest.ts:149` |
| 标的资料 | `GET /v3/reference/tickers/<SYM>` | `src/rest.ts:168` |

## 周期与契约

- **周期词汇** `1m/5m/15m/30m/1h/4h/1d/1w/1M`（`src/rest.ts:28`），映射到 Polygon
  `multiplier/timespan`：分钟 1/5/15/30，小时 1/4，日/周/月 1 day / 1 week / 1 month
  （`src/rest.ts:30-42`）。**周线与月线是上游原生粒度**（与 connector-fmp 的日线退化不同）。
  工具参数的 enum 直接用该词汇表（`src/index.ts:197`），表外周期在工具参数校验处即被拒。
- **报价是「上一交易日聚合」，不是实时报价**：`getTicker` 打的是 `/prev`（`src/rest.ts:118`），
  返回体 `results[0]` 的 `c/h/l/o/v/t` 即价格与上一交易日成交量；`Ticker.timestamp` 直接取 `row.t`
  （Polygon 给毫秒时间戳，不做秒转毫秒，`src/rest.ts:124-130`）。
- **K 线窗口**：`to = 今天`、`from = 今天 - limit × 周期毫秒 × 2`，都是 `YYYY-MM-DD`（`src/rest.ts:137-138`），
  `limit` 原样透传给上游（`src/rest.ts:149`）；`results` 缺失或非数组时静默返回 `[]`（`src/rest.ts:151-153`），
  `closeTime = t + 周期 - 1 ms`（`src/rest.ts:162`）。
- **符号形态**：`trim()` + 大写，只做规范化、不校验美股形态（`src/rest.ts:58-62`）；空串抛
  `TRADING_INVALID_ARGUMENT`。
- **报价取值**：`results` 缺失或空数组 → `TRADING_SYMBOL_NOT_FOUND`（`src/rest.ts:120-122`）。
- **错误映射**：上游非 2xx → `TRADING_UPSTREAM_ERROR`，消息带 HTTP 状态与 `statusText`（`src/rest.ts:90-92`）；
  `fetch` 抛错（不可达、响应非 JSON 等）→ `TRADING_NETWORK`（`src/rest.ts:96-100`）。错误载体
  `TradingServiceError` 携带 `code`（`src/rest.ts:17-26`）。
- 服务类成员用 TS 编译期 `private`（禁 ECMAScript `#`，cordis realm 代理会炸；`src/index.ts:54,90`）。

## 能力面

**注册工具**（`apply` 内 `ctx.inject(['tools'])`，`src/index.ts:176-217`，注册前先 `tools.get` 判重）：

| 工具 | 源码 |
|---|---|
| `us_get_ticker` | `src/index.ts:182-190` |
| `us_get_klines` | `src/index.ts:192-205` |
| `us_get_ticker_details` | `src/index.ts:207-216` |

**服务方法**：

| 方法 | 有/缺席 | 说明 |
|---|---|---|
| `MarketDataService.getTicker` | 有 | `src/index.ts:65-67` → `src/rest.ts:104-131`；底层是 `/prev` 上一交易日聚合 |
| `MarketDataService.getKlines` | 有 | `src/index.ts:69-71` → `src/rest.ts:133-164` |
| `MarketDataService.subscribeTicker` | 有 | 快照轮询，`intervalMs` 下限 1000 ms、默认 5000 ms，`dispose()` 清定时器（`src/index.ts:77-85`） |
| `getDetails`（契约外扩展） | 有 | `src/index.ts:73-75` → `src/rest.ts:166-170`（内部方法名 `getTickerDetails`）；对应工具 `us_get_ticker_details`；上游无 `results` 时回落 `{}`（`src/rest.ts:169`） |
| `MarketDataService.listInstruments`（可选契约方法，`packages/api/src/index.ts:741`） | **缺席** | 无名册端点实现；`/v3/reference/tickers` 需按符号单取 |
| `MarketDataService.getFundamentals` / `getTickers`（可选契约方法） | 未实现 | 无对应服务方法；报价批量回落逐只 `getTicker` |
| `TradeService.getBalance` | 有 | 固定返回 `{ currency: 'USD', available: 100000, total: 100000 }`（`src/rest.ts:172-174`），非真实券商余额 |
| `TradeService.placeOrder` | 有 | 服务缝三态闸门（`src/index.ts:107-134`）；无工具入口 |
| `TradeService.cancelOrder` | 有 | 与真实下单同门槛，可抛 `TRADING_LIVE_TRADING_DISABLED`；放行时返回 `{ orderId, status: 'canceled' }`（`src/index.ts:136-146`）；无工具入口 |
| `TradeService.getPositions` / `getOrders` | 有 | 恒返回 `[]`（`src/index.ts:148-154`） |
| 盘口 / 分笔 / 主动买盘 | 未实现 | 契约可选方法全缺（`packages/api/src/index.ts:768,774,792`）；见「已知边界」 |

## 已知边界（源码级，未经网络实测）

- **报价语义是上一交易日**：底层打 `/v2/aggs/ticker/<SYM>/prev`（`src/rest.ts:118`），
  所以 `price` 是上一交易日收盘聚合、`volume` 是上一交易日成交量，不能当盘中最新价用。
- **rest 层是 sim stub**：`placeOrder` 恒返回 `dryRun: true` 的模拟回执（`src/rest.ts:176-188`）、
  `getBalance` 恒 100000（`src/rest.ts:172-174`）；
  `.agents/notes/implemented/feature/2026-09-01-service-seam-order-gate.md` 第 20 行把本包 rest 层记为
  「模拟 stub」。因此闸门 ③ 即使放行，也不会产生真实券商成交。
- **盘口未接**：`spikes/impl-orderbook-ticks/EVIDENCE.md` 第 32 行记明 us 盘口（含 polygon）未实现，
  需凭证或本地网关；本包也没有 `getOrderbook` / `getRecentTrades`。
- **无名册**：未实现 `listInstruments`，无法一次取回全部可交易标的。
- **无工具层交易面**：本包只注册 3 个行情/资料工具；全仓 `us_place_order` 只出现在 connector-alpaca /
  connector-ibkr / connector-stooq / connector-yahoo。本包 `TradeService` 仅经 `tradingUsTrade`
  服务注入面被调用。
- **`env` 是死配置**：`src/index.ts:44` 声明并默认 `'demo'`，但 `src/` 内除 `apiKeyRef` 外无任何地方
  读取它（`src/index.ts:172`、`src/dataplane.ts:29` 都只用 `apiKeyRef`），`demo`/`live` 无分流效果。
- **K 线窗口在短周期上偏窄**：`from = 今天 - limit × 周期毫秒 × 2`（`src/rest.ts:138`）只是请求下界，
  真实可取根数由上游历史深度与账号权限裁决；`limit` 原样透传，超限由服务端处理（`src/rest.ts:149`）。
- **未实证项**：`/prev`、`/range`、`/v3/reference/tickers` 的真实响应形态、字段口径、限流与额度表现，
  本仓均无出网证据。

## 合规记录

- **需自备 API key（BYOK）**：配置只存 ref 名 `POLYGON_API_KEY`；运行期先取
  `tradingMarketRouter.getCredential('polygon')` 的 `apiKey`，缺失时回落同名环境变量
  （`src/index.ts:170-172`；数据面行同法，`src/dataplane.ts:29`）。本仓不内置、不落库、不打印 key。
- **key 随查询参数出网**：每次请求把 key 以 `apiKey=<key>` 拼进 URL（`src/rest.ts:83`），会进入上游访问
  日志与进程环境可见范围。上游是商业注册制数据源（设置页标为 `type: 'commercial'`，
  `packages/client-ui-settings/src/client/trading-settings-controller.ts:34`）。
- **免费额度与再分发边界以 Polygon.io 服务条款为准**：本仓不缓存、不再分发任何行情或标的资料数据。
  `docs/guides/connectors-guide.md` 第 36 行列有一句免费计划额度描述——该数字来自文档而非源码或 spike，
  本仓未复验，**一律以 Polygon.io 官方条款为准**。
- **标的资料按上游原样透传**：`/v3/reference/tickers` 的 `results` 对象直接返回（`src/rest.ts:166-170`），
  不做字段筛选、不落盘。

## 出网验证

本包暂无已提交的独立出网验证脚本（`spikes/` 下没有 `impl-polygon*` 目录；
`spikes/impl-service-seam-gate/net-verify.mjs` 只 import `connector-okx` 的构建产物）。

可复跑的最小入口：

```sh
# 1) 离线契约（不需要 key，不出网）
pnpm --filter @dshtrading/connector-polygon test

# 2) 真实出网（需自备 key）。lib/ 是 tsdown 构建产物、被 .gitignore 忽略，先构建再 import：
pnpm --filter @dshtrading/connector-polygon build
POLYGON_API_KEY='<your-key>' node --input-type=module -e "
import { PolygonRestClient } from './packages/connector-polygon/lib/rest.js'
const client = new PolygonRestClient({ apiKey: process.env.POLYGON_API_KEY })
console.log(JSON.stringify(await client.getTicker('AAPL')))
console.log(JSON.stringify((await client.getKlines('AAPL', '1d', 5)).slice(-2)))
console.log(JSON.stringify(await client.getTickerDetails('AAPL')))
"
```

未设 `POLYGON_API_KEY` 时 URL 不会附加 `apiKey`（`src/rest.ts:83`），请求照发、由上游裁决，
非 2xx 一律映射为 `TRADING_UPSTREAM_ERROR`（`src/rest.ts:90-92`）。
