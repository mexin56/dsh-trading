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
| `enabled` | `true` | 是否激活 Polygon 连接器（`src/index.ts:42`）；`false` 时 `apply` 静默退出（`src/index.ts:165`） |
| `dryRun` | `true` | 默认模拟下单（`src/index.ts:43`）；为真时 `placeOrder` 走本地模拟回执（`src/index.ts:116`） |
| `liveTrading` | `false` | 是否允许实盘交易（`src/index.ts:44`）；非权威镜像，实盘授权由 `@dshtrading/authority` 的人工签署平面裁定（`src/index.ts:88`） |
| `apiKeyRef` | `'POLYGON_API_KEY'` | Polygon API Key 的环境变量名（BYOK）（`src/index.ts:45`） |

## 接线

- **数据面行**：`packages/us/cordis.patch.yml` 第 38-41 行 → 行 id `dsh-trading-us-dataplane-polygon`，
  入口 `@dshtrading/connector-polygon/dataplane`，行 config 只写 `enabled: true`；
  该入口把 `(us, polygon)` 注册进 `tradingMarketDataRegistry`（`src/dataplane.ts:24-25,38-40`）。
- **凭证解析只有一份**（`createApiKeyProvider`，`src/index.ts:172-176`）：设置中心
  `dshtrading.credentials.polygon.apiKey`（router `getCredential('polygon').apiKey`）优先、
  `process.env[config.apiKeyRef]` 兜底，**每次请求解析**（惰性，`src/rest.ts:116`）——settings 用户层
  加载/修改晚于插件 `apply` 也生效。主入口（`src/index.ts:183`）与数据面行（`src/dataplane.ts:32`）
  同用这一份，故设置页填的 key 在宿主面行情注册行与 preset 工具面都生效。
- **preset 行**：`packages/us/assets/preset/us-trader/agent.cordis.yml` 第 90-102 行 → 组 id
  `dsh-trading-us-connector-polygon-group`（`isolate` 键 `tradingUsMarketData` + `tradingUsTrade`，第 93-95 行），
  组内行 id `dsh-trading-us-connector-polygon`（第 97 行），行 config 只写 `enabled/dryRun/liveTrading`（第 100-102 行）。
- **bundle 依赖**：`packages/us/package.json:35`（`workspace:*`）。
- **provider 词汇**：`packages/router/src/index.ts:72` 的 `PROVIDER_VOCABULARY` 含 `polygon`；
  本包导出 `ROUTER_PROVIDER = 'polygon'`（`src/index.ts:155`），`routeAllows` 只在 `us` 市场当前激活
  provider 为 `polygon` 时激活本实例（`src/index.ts:157-162`）。
- **设置页显示名**：`PROVIDER_LABELS` 的 `polygon` 条目
  （`packages/client-ui-settings/src/client/trading-settings-controller.ts:51`：
  `{ id: 'polygon', label: 'provider.polygon', url: 'https://polygon.io', env: 'POLYGON_API_KEY', type: 'commercial', markets: ['us'] }`），
  文案见 `packages/client-ui-settings/src/client/locales.ts` 的 `'provider.polygon'` 条目
  （zh / en 都是 `Polygon.io (Massive)`），界面显示 `Polygon.io (Massive)`。凭据卡片字段 `apiKey`
  （`trading-settings-controller.ts:157`）由本包的 `getCredential` 读点消费。
- **服务键**：`tradingUsMarketData`（`src/index.ts:48`）、`tradingUsTrade`（`src/index.ts:49`）。

## 上游端点

基址 `https://api.polygon.io`（`src/rest.ts:96`）；API key 以 `apiKey=` 查询参数附加（`src/rest.ts:103`）。

| 用途 | 端点 | 源码 |
|---|---|---|
| 报价（上一交易日收盘聚合，默认 `adjusted=true` 复权；`t` 为聚合窗口起点 Unix 毫秒） | `GET /v2/aggs/ticker/<SYM>/prev` | `src/rest.ts:141` |
| K 线 | `GET /v2/aggs/ticker/<SYM>/range/<multiplier>/<timespan>/<from>/<to>?limit=<limit>&sort=asc` | `src/rest.ts:173` |
| 标的资料 | `GET /v3/reference/tickers/<SYM>` | `src/rest.ts:192` |

## 周期与契约

- **周期词汇** `1m/5m/15m/30m/1h/4h/1d/1w/1M`（`src/rest.ts:29`），映射到 Polygon
  `multiplier/timespan`：分钟 1/5/15/30，小时 1/4，日/周/月 1 day / 1 week / 1 month
  （`src/rest.ts:48-61`）。**周线与月线是上游原生粒度**（与 connector-fmp 的日线退化不同）。
  `toPolygonTimespan` / `parseIntervalMs` 先过 `assertSupportedInterval`（`src/rest.ts:39-46`）：
  与 connector-xysz 同**错误码与消息风格**，但签名不同——xysz 那支是 `: void`
  （`packages/connector-xysz/src/rest.ts:34`），本包是类型断言
  `asserts interval is SupportedInterval`，把 `interval` 收窄到 9 档联合，使下游 `switch` 穷尽、
  不留产出 `undefined` 的路径。**表外周期（`3m/2h/6h/8h/12h/3d`）显式抛
  `TRADING_UNSUPPORTED_INTERVAL`**；`getKlines` 顶部同样先过闸
  （`src/rest.ts:157`），表外周期在发请求之前就抛。工具参数的 enum 直接用该词汇表
  （`src/index.ts:195`），表外周期在工具参数校验处即被拒。
- **报价是「上一交易日聚合」，不是实时报价**：`getTicker` 打的是 `/prev`（`src/rest.ts:141`），
  返回体 `results[0]` 的 `c/h/l/o/v/t` 即价格与上一交易日成交量；`Ticker.timestamp` 直接取 `row.t`
  （`src/rest.ts:147-153`）。已核对官方字段定义：`/prev` = Previous Close，返回**上一交易日**的
  OHLC 聚合，默认 `adjusted=true` → `c` 是**复权**价；`results[].t` 是聚合窗口起点的 **Unix 毫秒**，
  与本仓 `Ticker.timestamp` 的 epoch ms 契约一致，**无需秒→毫秒换算**。该语义已写进
  `us_get_ticker` 的工具描述（`src/index.ts:182`），工具不再暗示实时报价。
- **K 线窗口**：`to = 今天`、`from = 今天 - limit × 周期毫秒 × 2`，都是 `YYYY-MM-DD`（`src/rest.ts:161-162`），
  `limit` 原样透传给上游（`src/rest.ts:173`）；`results` 缺失或非数组时静默返回 `[]`（`src/rest.ts:175-177`），
  `closeTime = t + 周期 - 1 ms`（`src/rest.ts:186`）。
- **符号形态**：`trim()` + 大写，只做规范化、不校验美股形态（`src/rest.ts:78-82`）；空串抛
  `TRADING_INVALID_ARGUMENT`。
- **报价取值**：`results` 缺失或空数组 → `TRADING_SYMBOL_NOT_FOUND`（`src/rest.ts:143-145`）。
- **错误映射**：上游非 2xx → `TRADING_UPSTREAM_ERROR`，消息带 HTTP 状态与 `statusText`（`src/rest.ts:110-112`）；
  `fetch` 抛错（不可达、响应非 JSON 等）→ `TRADING_NETWORK`（`src/rest.ts:114-120`）。错误载体
  `TradingServiceError` 携带 `code`（`src/rest.ts:17-26`）。
- 服务类成员用 TS 编译期 `private`（禁 ECMAScript `#`，cordis realm 代理会炸；`src/index.ts:52,90`）。

## 能力面

**注册工具**（`apply` 内 `ctx.inject(['tools'])`，`src/index.ts:174-215`，注册前先 `tools.get` 判重）：

| 工具 | 源码 |
|---|---|
| `us_get_ticker` | `src/index.ts:180-188` |
| `us_get_klines` | `src/index.ts:190-203` |
| `us_get_ticker_details` | `src/index.ts:205-214` |

**服务方法**：

| 方法 | 有/缺席 | 说明 |
|---|---|---|
| `MarketDataService.getTicker` | 有 | `src/index.ts:63-65` → `src/rest.ts:124-154`；底层是 `/prev` 上一交易日收盘聚合 |
| `MarketDataService.getKlines` | 有 | `src/index.ts:67-69` → `src/rest.ts:156-188`（顶部过周期闸，`src/rest.ts:157`） |
| `MarketDataService.subscribeTicker` | 有 | 快照轮询，`intervalMs` 下限 1000 ms、默认 5000 ms，`dispose()` 清定时器（`src/index.ts:75-83`） |
| `getDetails`（契约外扩展） | 有 | `src/index.ts:71-73` → `src/rest.ts:190-194`（内部方法名 `getTickerDetails`）；对应工具 `us_get_ticker_details`；上游无 `results` 时回落 `{}`（`src/rest.ts:193`） |
| `MarketDataService.listInstruments`（可选契约方法，`packages/api/src/index.ts:741`） | **缺席** | 无名册端点实现；`/v3/reference/tickers` 需按符号单取 |
| `MarketDataService.getFundamentals` / `getTickers`（可选契约方法） | 未实现 | 无对应服务方法；报价批量回落逐只 `getTicker` |
| `TradeService.getBalance` | 有 | 固定返回 `{ currency: 'USD', available: 100000, total: 100000 }`（`src/rest.ts:196-198`），非真实券商余额 |
| `TradeService.placeOrder` | 有 | 服务缝三态闸门（`src/index.ts:105-132`）；无工具入口 |
| `TradeService.cancelOrder` | 有 | 与真实下单同门槛，可抛 `TRADING_LIVE_TRADING_DISABLED`；放行时返回 `{ orderId, status: 'canceled' }`（`src/index.ts:134-144`）；无工具入口 |
| `TradeService.getPositions` / `getOrders` | 有 | 恒返回 `[]`（`src/index.ts:146-152`） |
| 盘口 / 分笔 / 主动买盘 | 未实现 | 契约可选方法全缺（`packages/api/src/index.ts:768,774,792`）；见「已知边界」 |

## 已知边界（源码级，未经网络实测）

- **报价语义是上一交易日收盘聚合**：底层打 `/v2/aggs/ticker/<SYM>/prev`（`src/rest.ts:141`），
  所以 `price` 是上一交易日收盘聚合、默认 `adjusted=true` 的复权价，`volume` 是上一交易日成交量，
  不能当盘中最新价用。该语义已由 `us_get_ticker` 的工具描述显式声明（`src/index.ts:182`），
  工具面不再暗示实时报价；`timestamp` 是聚合窗口起点的 Unix 毫秒，不需要换算。
  **未改端点的理由**（官方文档所述，本仓未出网实测）：免费 Basic 档下实时快照
  `/v2/snapshot/...`、`/v2/last/trade`、`/v2/last/nbbo` 全部 Not included；延迟档从 Starter $29
  起（15 分钟延迟），`/v2/last/trade` 需 Developer $79，NBBO 需 Advanced $199；且这些端点的
  时间字段是纳秒（需 `/1e6` 换算）。本机无 `POLYGON_API_KEY`，替换端点也拿不到真实响应证据。
- **rest 层是 sim stub**：`placeOrder` 恒返回 `dryRun: true` 的模拟回执（`src/rest.ts:200-212`）、
  `getBalance` 恒 100000（`src/rest.ts:196-198`）；
  `.agents/notes/implemented/feature/2026-09-01-service-seam-order-gate.md` 第 20 行把本包 rest 层记为
  「模拟 stub」。因此闸门 ③ 即使放行，也不会产生真实券商成交。
- **盘口未接**：`spikes/impl-orderbook-ticks/EVIDENCE.md` 第 32 行记明 us 盘口（含 polygon）未实现，
  需凭证或本地网关；本包也没有 `getOrderbook` / `getRecentTrades`。
- **无名册**：未实现 `listInstruments`，无法一次取回全部可交易标的。
- **无工具层交易面**：本包只注册 3 个行情/资料工具；全仓 `us_place_order` 只出现在 connector-alpaca /
  connector-ibkr / connector-stooq / connector-yahoo。本包 `TradeService` 仅经 `tradingUsTrade`
  服务注入面被调用。
- **K 线窗口在短周期上偏窄**：`from = 今天 - limit × 周期毫秒 × 2`（`src/rest.ts:162`）只是请求下界，
  真实可取根数由上游历史深度与账号权限裁决；`limit` 原样透传，超限由服务端处理（`src/rest.ts:173`）。
- **未实证项**：`/prev`、`/range`、`/v3/reference/tickers` 的真实响应形态、字段口径、限流与额度表现，
  本仓均无出网证据。

## 合规记录

- **需自备 API key（BYOK）**：配置只存 ref 名 `POLYGON_API_KEY`；运行期按请求取
  `tradingMarketRouter.getCredential('polygon')` 的 `apiKey`，缺失时回落同名环境变量
  （`src/index.ts:172-176`；主入口与数据面行共用这一份，`src/index.ts:183`、`src/dataplane.ts:32`）。
  本仓不内置、不落库、不打印 key。
- **key 随查询参数出网**：每次请求把 key 以 `apiKey=<key>` 拼进 URL（`src/rest.ts:117`），会进入上游访问
  日志与进程环境可见范围。上游是商业注册制数据源（设置页标为 `type: 'commercial'`，
  `packages/client-ui-settings/src/client/trading-settings-controller.ts:51`）。
- **免费额度与再分发边界以 Polygon.io 服务条款为准**：本仓不缓存、不再分发任何行情或标的资料数据。
  `docs/guides/connectors-guide.md` 第 36 行列有一句免费计划额度描述——该数字来自文档而非源码或 spike，
  本仓未复验，**一律以 Polygon.io 官方条款为准**。
- **标的资料按上游原样透传**：`/v3/reference/tickers` 的 `results` 对象直接返回（`src/rest.ts:190-194`），
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

未设 `POLYGON_API_KEY` 时 URL 不会附加 `apiKey`（`src/rest.ts:103`），请求照发、由上游裁决，
非 2xx 一律映射为 `TRADING_UPSTREAM_ERROR`（`src/rest.ts:110-112`）。
