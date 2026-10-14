# @dshtrading/connector-fmp

> **状态：未实证（本仓无该上游的出网证据）**。截至 2026-10-14 检索：`spikes/` 下没有针对
> Financial Modeling Prep 的出网脚本或原始响应目录；[`spikes/impl-service-seam-gate/NET-VERIFY.md`](../../spikes/impl-service-seam-gate/NET-VERIFY.md)
> 的真实网络验证只覆盖 OKX 公共端点，其「范围与未验证项」一节明确写明 fmp/polygon/finnhub 等模拟 stub
> 的服务缝三态由离线矩阵 `test/trade-gate.test.ts` 覆盖。`spikes/impl-uscnhk-news/EVIDENCE.md` 是
> us/cn/hk 新闻源分级 spike，通篇没有 FMP 字样，不能作为本包的能力证据。本 README 的端点、字段与
> 能力面全部读自源码，不含任何实测结论。

Financial Modeling Prep 商业数据源美股连接器（`us` 市场，BYOK），实现 `@dshtrading/api` 的
`MarketDataService` 与 `TradeService`，被 `packages/us` bundle 以 `workspace:*` 依赖
（`packages/us/package.json` 第 33 行）。对外提供报价 / K 线 / 公司简介三个工具；
**不注册任何下单或撤单工具**，交易服务只经服务注入面可达。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活 FMP 连接器（`src/index.ts:43`）；`false` 时 `apply` 静默退出（`src/index.ts:171`） |
| `env` | `'demo'` | 运行环境（`src/index.ts:44`）；**当前实现未读取该字段**，`demo`/`live` 无分流效果，见「已知边界」 |
| `dryRun` | `true` | 默认模拟下单（`src/index.ts:45`）；为真时 `placeOrder` 走本地模拟回执（`src/index.ts:122`） |
| `liveTrading` | `false` | 是否允许实盘交易（`src/index.ts:46`）；非权威镜像，实盘授权由 `@dshtrading/authority` 的人工签署平面裁定（`src/index.ts:94`） |
| `apiKeyRef` | `'FMP_API_KEY'` | FMP API Key 的环境变量名（BYOK）（`src/index.ts:47`） |

## 接线

- **数据面行**：`packages/us/cordis.patch.yml` 第 30-33 行 → 行 id `dsh-trading-us-dataplane-fmp`，
  入口 `@dshtrading/connector-fmp/dataplane`，行 config 只写 `enabled: true`；
  该入口把 `(us, fmp)` 注册进 `tradingMarketDataRegistry`（`src/dataplane.ts:24-25,35-37`）。
- **preset 行**：`packages/us/assets/preset/us-trader/agent.cordis.yml` 第 62-74 行 → 组 id
  `dsh-trading-us-connector-fmp-group`（`isolate` 键 `tradingUsMarketData` + `tradingUsTrade`，第 65-67 行），
  组内行 id `dsh-trading-us-connector-fmp`（第 69 行），行 config 只写 `enabled/dryRun/liveTrading`（第 72-74 行）。
- **bundle 依赖**：`packages/us/package.json:33`（`workspace:*`）。
- **provider 词汇**：`packages/router/src/index.ts:70` 的 `PROVIDER_VOCABULARY` 含 `fmp`；
  本包导出 `ROUTER_PROVIDER = 'fmp'`（`src/index.ts:161`），`routeAllows` 只在 `us` 市场当前激活
  provider 为 `fmp` 时激活本实例（`src/index.ts:163-168`）。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:32`
  （`{ id: 'fmp', label: 'provider.fmp', url: 'https://site.financialmodelingprep.com/developer', env: 'FMP_API_KEY', type: 'commercial', markets: ['us'] }`），
  文案见 `src/client/locales.ts:244`（zh）与 `:390`（en），界面显示 `FMP (Financial Modeling Prep)`。
- **服务键**：`tradingUsMarketData`（`src/index.ts:50`）、`tradingUsTrade`（`src/index.ts:51`）。

## 上游端点

基址 `https://financialmodelingprep.com/api/v3`（`src/rest.ts:74`）；API key 以 `apikey=` 查询参数附加（`src/rest.ts:81`）。

| 用途 | 端点 | 源码 |
|---|---|---|
| 报价 | `GET /quote/<SYM>` | `src/rest.ts:103` |
| 分钟/小时 K 线 | `GET /historical-chart/<1min\|5min\|15min\|30min\|1hour\|4hour>/<SYM>` | `src/rest.ts:128-130` |
| 日线 K 线 | `GET /historical-price-full/<SYM>?timeseries=<limit>` | `src/rest.ts:147-149` |
| 公司简介 | `GET /profile/<SYM>` | `src/rest.ts:168` |
| 标的检索 | `GET /search?query=<query>&limit=10` | `src/rest.ts:174` |

## 周期与契约

- **周期词汇** `1m/5m/15m/30m/1h/4h/1d/1w/1M`（`src/rest.ts:28`），分钟/小时映射
  `1min/5min/15min/30min/1hour/4hour`（`src/rest.ts:30-40`）。工具参数的 enum 直接用该词汇表
  （`src/index.ts:201`），表外周期在工具参数校验处即被拒。
- **日内与日线走两条上游路径**：`1m/5m/15m/30m/1h/4h` 走 `/historical-chart`（`src/rest.ts:123,128-130`），
  **`1d/1w/1M` 全部走 `/historical-price-full` 日线**（`src/rest.ts:147-149`）——因为 `toFmpInterval`
  的 `default` 分支只产出 `1day`（`src/rest.ts:38`）。因此请求 `1w`/`1M` 拿到的是**日线序列**，
  只有 `closeTime` 按周/月步长标注（`src/rest.ts:152-162`）；要真周/月线需另接上游端点。
- **K 线根数与顺序**：日内路径取上游前 `limit` 行再 `reverse()`（上游新到旧，`src/rest.ts:132`）；
  日线路径 `reverse()` 后取末 `limit` 行（`src/rest.ts:151`）；两条路径都在上游返回非数组时静默返回 `[]`
  （`src/rest.ts:131,150`）。
- **符号形态**：`trim()` + 大写，只做规范化、不校验美股形态（`src/rest.ts:56-60`）；空串抛
  `TRADING_INVALID_ARGUMENT`。
- **报价取值**：`/quote` 返回非数组或空数组 → `TRADING_SYMBOL_NOT_FOUND`（`src/rest.ts:104-106`）；
  取首行，`price` 非 number 时回落 `0`、`volume` 非 number 时回落 `0`（`src/rest.ts:109-110`），
  `timestamp`（秒）转毫秒、缺失时回落 `Date.now()`（`src/rest.ts:111`）。
- **错误映射**：上游非 2xx → `TRADING_UPSTREAM_ERROR`（`src/rest.ts:88`）；`fetch` 抛错
  （不可达、响应非 JSON 等）→ `TRADING_NETWORK`（`src/rest.ts:93-97`）。错误载体
  `TradingServiceError` 携带 `code`（`src/rest.ts:17-26`）。
- 服务类成员用 TS 编译期 `private`（禁 ECMAScript `#`，cordis realm 代理会炸；`src/index.ts:54,94`）。

## 能力面

**注册工具**（`apply` 内 `ctx.inject(['tools'])`，`src/index.ts:180-221`，注册前先 `tools.get` 判重）：

| 工具 | 源码 |
|---|---|
| `us_get_ticker` | `src/index.ts:186-194` |
| `us_get_klines` | `src/index.ts:196-209` |
| `us_get_company_profile` | `src/index.ts:211-220` |

**服务方法**：

| 方法 | 有/缺席 | 说明 |
|---|---|---|
| `MarketDataService.getTicker` | 有 | `src/index.ts:65-67` → `src/rest.ts:101-119` |
| `MarketDataService.getKlines` | 有 | `src/index.ts:69-71` → `src/rest.ts:121-164` |
| `MarketDataService.subscribeTicker` | 有 | 快照轮询，`intervalMs` 下限 1000 ms、默认 5000 ms，`dispose()` 清定时器（`src/index.ts:81-89`） |
| `getProfile`（契约外扩展） | 有 | `src/index.ts:73-75` → `src/rest.ts:166-170`；对应工具 `us_get_company_profile`；上游返回空数组时回落 `{}`（`src/rest.ts:169`） |
| `MarketDataService.listInstruments`（可选契约方法，`packages/api/src/index.ts:741`） | 有 | `src/index.ts:77-79` → `src/rest.ts:172-177`；本包签名多收一个可选 `query`，返回 `{ symbol, name }` 行而非 `InstrumentRef`；无 query 时直接返回 `[]`；**未注册工具** |
| `MarketDataService.getFundamentals` / `getTickers`（可选契约方法） | 未实现 | 无对应服务方法；报价批量回落逐只 `getTicker` |
| 新闻 / 盘口 / 分笔 | 未实现 | 本包无对应服务方法与工具（新闻面见 `@dshtrading/kit-us` 的 `us_get_news`） |
| `TradeService.getBalance` | 有 | 固定返回 `{ currency: 'USD', available: 100000, total: 100000 }`（`src/rest.ts:179-181`），非真实券商余额 |
| `TradeService.placeOrder` | 有 | 服务缝三态闸门（`src/index.ts:111-138`）；无工具入口 |
| `TradeService.cancelOrder` | 有 | 与真实下单同门槛，可抛 `TRADING_LIVE_TRADING_DISABLED`；放行时返回 `{ orderId, status: 'canceled' }`（`src/index.ts:140-150`）；无工具入口 |
| `TradeService.getPositions` / `getOrders` | 有 | 恒返回 `[]`（`src/index.ts:152-158`） |
| 盘口 / 主动买盘 / 委托簿 | 未实现 | 无对应服务方法与工具 |

## 已知边界（源码级，未经网络实测）

- **rest 层是 sim stub**：`placeOrder` 恒返回 `dryRun: true` 的模拟回执（`src/rest.ts:183-195`）、
  `getBalance` 恒 100000（`src/rest.ts:179-181`）；
  `.agents/notes/implemented/feature/2026-09-01-service-seam-order-gate.md` 第 20 行把本包 rest 层记为
  「模拟 stub」。因此闸门 ③ 即使放行，也不会产生真实券商成交。
- **`1w`/`1M` 不是真周/月线**：上游路径退化为日线（`src/rest.ts:123,147-149`），只有 `closeTime`
  按 7 天/30 天步长标注（`src/rest.ts:42-54,152-162`）。周期语义与返回粒度不一致是本包已知偏差。
- **无工具层交易面**：本包只注册 3 个行情/资料工具；全仓 `us_place_order` 只出现在 connector-alpaca /
  connector-ibkr / connector-stooq / connector-yahoo。本包 `TradeService` 仅经 `tradingUsTrade`
  服务注入面被调用。
- **`env` 是死配置**：`src/index.ts:44` 声明并默认 `'demo'`，但 `src/` 内除 `apiKeyRef` 外无任何地方
  读取它（`src/index.ts:176`、`src/dataplane.ts:29` 都只用 `apiKeyRef`），`demo`/`live` 无分流效果。
- **报价缺字段静默回落 0**：`price`/`volume` 非 number 时填 `0` 而不报错（`src/rest.ts:109-110`），
  调用方无法区分「真 0」与「字段缺失」。
- **检索恒带 `limit=10`**：`/search` 硬编码 `limit=10`（`src/rest.ts:174`），无法取更多候选。
- **未实证项**：报价 / K 线 / 简介 / 检索端点的真实响应形态、字段口径、限流与额度表现，本仓均无出网证据。

## 合规记录

- **需自备 API key（BYOK）**：配置只存 ref 名 `FMP_API_KEY`；运行期先取
  `tradingMarketRouter.getCredential('fmp')` 的 `apiKey`，缺失时回落同名环境变量
  （`src/index.ts:174-176`；数据面行同法，`src/dataplane.ts:29`）。本仓不内置、不落库、不打印 key。
- **key 随查询参数出网**：每次请求把 key 以 `apikey=<key>` 拼进 URL（`src/rest.ts:81`），会进入上游访问
  日志与进程环境可见范围。上游是商业注册制数据源，设置页把该源标为 `type: 'commercial'`
  （`packages/client-ui-settings/src/client/trading-settings-controller.ts:32`）。
- **免费额度与再分发边界以 FMP 服务条款为准**：本仓不缓存、不再分发任何行情或公司资料数据。
  `docs/guides/connectors-guide.md` 第 34 行列有一句免费额度描述——该数字来自文档而非源码或 spike，
  本仓未复验，**一律以 FMP 官方条款为准**。
- **公司简介按上游原样透传**：`/profile` 返回首行对象即返回（`src/rest.ts:166-170`），不做字段筛选、不落盘。

## 出网验证

本包暂无已提交的独立出网验证脚本（`spikes/` 下没有 `impl-fmp*` 目录；
`spikes/impl-service-seam-gate/net-verify.mjs` 只 import `connector-okx` 的构建产物）。

可复跑的最小入口：

```sh
# 1) 离线契约（不需要 key，不出网）
pnpm --filter @dshtrading/connector-fmp test

# 2) 真实出网（需自备 key）。lib/ 是 tsdown 构建产物、被 .gitignore 忽略，先构建再 import：
pnpm --filter @dshtrading/connector-fmp build
FMP_API_KEY='<your-key>' node --input-type=module -e "
import { FmpRestClient } from './packages/connector-fmp/lib/rest.js'
const client = new FmpRestClient({ apiKey: process.env.FMP_API_KEY })
console.log(JSON.stringify(await client.getTicker('AAPL')))
console.log(JSON.stringify((await client.getKlines('AAPL', '1d', 5)).slice(-2)))
console.log(JSON.stringify(await client.getProfile('AAPL')))
"
```

未设 `FMP_API_KEY` 时 URL 不会附加 `apikey`（`src/rest.ts:81`），请求照发、由上游裁决，
非 2xx 一律映射为 `TRADING_UPSTREAM_ERROR`（`src/rest.ts:87-89`）。
