# @dshtrading/connector-finnhub

> **状态：未实证（本仓无该上游的出网证据）**。截至 2026-10-14 检索：`spikes/` 下没有针对 Finnhub 的
> 出网脚本或原始响应目录；[`spikes/impl-service-seam-gate/NET-VERIFY.md`](../../spikes/impl-service-seam-gate/NET-VERIFY.md)
> 的真实网络验证只覆盖 OKX 公共端点，其「范围与未验证项」一节明确写明 fmp/polygon/finnhub 等模拟 stub
> 的服务缝三态由离线矩阵 `test/trade-gate.test.ts` 覆盖。本 README 的端点、字段与能力面全部读自源码，
> 不含任何实测结论。

Finnhub 商业数据源美股连接器（`us` 市场，BYOK），实现 `@dshtrading/api` 的 `MarketDataService`
与 `TradeService`，被 `packages/us` bundle 以 `workspace:*` 依赖（`packages/us/package.json` 第 32 行）。
对外提供报价 / K 线 / 公司新闻三个行情工具；**不注册任何下单或撤单工具**，交易服务只经服务注入面可达。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活 Finnhub 连接器（`src/index.ts:44`）；`false` 时 `apply` 静默退出（`src/index.ts:176`） |
| `env` | `'demo'` | 运行环境（`src/index.ts:45`）；**当前实现未读取该字段**，`demo`/`live` 无分流效果，见「已知边界」 |
| `dryRun` | `true` | 默认模拟下单（`src/index.ts:46`）；为真时 `placeOrder` 走本地模拟回执（`src/index.ts:127`） |
| `liveTrading` | `false` | 是否允许实盘交易（`src/index.ts:47`）；非权威镜像，实盘授权由 `@dshtrading/authority` 的人工签署平面裁定（`src/index.ts:99-100`） |
| `apiKeyRef` | `'FINNHUB_API_KEY'` | Finnhub API Key 的环境变量名（BYOK）（`src/index.ts:48`） |

## 接线

- **数据面行**：`packages/us/cordis.patch.yml` 第 34-37 行 → 行 id `dsh-trading-us-dataplane-finnhub`，
  入口 `@dshtrading/connector-finnhub/dataplane`，行 config 只写 `enabled: true`；
  该入口把 `(us, finnhub)` 注册进 `tradingMarketDataRegistry`（`src/dataplane.ts:24-25,35-37`）。
- **preset 行**：`packages/us/assets/preset/us-trader/agent.cordis.yml` 第 76-88 行 → 组 id
  `dsh-trading-us-connector-finnhub-group`（`isolate` 键 `tradingUsMarketData` + `tradingUsTrade`，第 79-81 行），
  组内行 id `dsh-trading-us-connector-finnhub`（第 83 行），行 config 只写 `enabled/dryRun/liveTrading`（第 86-88 行）。
- **bundle 依赖**：`packages/us/package.json:32`（`workspace:*`）。
- **provider 词汇**：`packages/router/src/index.ts:71` 的 `PROVIDER_VOCABULARY` 含 `finnhub`；
  本包导出 `ROUTER_PROVIDER = 'finnhub'`（`src/index.ts:166`），`routeAllows` 只在 `us` 市场当前激活
  provider 为 `finnhub` 时激活本实例（`src/index.ts:168-173`）。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:33`
  （`{ id: 'finnhub', label: 'provider.finnhub', url: 'https://finnhub.io/register', env: 'FINNHUB_API_KEY', type: 'commercial', markets: ['us'] }`），
  文案见 `src/client/locales.ts:245`（zh）与 `:391`（en），界面显示 `Finnhub`。
- **服务键**：`tradingUsMarketData`（`src/index.ts:51`）、`tradingUsTrade`（`src/index.ts:52`）。

## 上游端点

基址 `https://finnhub.io/api/v1`（`src/rest.ts:75`）；API key 以 `token=` 查询参数附加（`src/rest.ts:82`）。

| 用途 | 端点 | 源码 |
|---|---|---|
| 报价 | `GET /quote?symbol=<SYM>` | `src/rest.ts:104-106` |
| K 线 | `GET /stock/candle?symbol=<SYM>&resolution=<R>&from=<sec>&to=<sec>` | `src/rest.ts:129-137` |
| 公司新闻 | `GET /company-news?symbol=<SYM>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>`（近 7 天，取前 10 条） | `src/rest.ts:163-170` |
| 基本面指标 | `GET /stock/metric?symbol=<SYM>&metric=all` | `src/rest.ts:175-177` |
| 标的检索 | `GET /search?q=<query>` | `src/rest.ts:195-197` |

## 周期与契约

- **周期词汇** `1m/5m/15m/30m/1h/1d/1w/1M`（`src/rest.ts:29`），映射到 Finnhub resolution
  `1/5/15/30/60/D/W/M`（`src/rest.ts:31-42`）。**不含 `4h`**：工具参数的 enum 直接用该词汇表
  （`src/index.ts:208`），传 `4h` 在工具参数校验处即被拒，不会静默降级。
- **K 线窗口与截取**：请求区间 `to = now`、`from = now - limit × 周期秒数 × 2`（`src/rest.ts:126-127`）；
  上游 `s !== 'ok'` 或时间数组为空时**返回空数组而不抛错**（`src/rest.ts:139-141`）；
  成功时取最后 `limit` 根（`src/rest.ts:143-145`），`closeTime = openTime + 周期 - 1 ms`（`src/rest.ts:156`）。
- **符号形态**：`trim()` + 大写，只做规范化、不校验美股形态（`src/rest.ts:57-60`）；空串抛
  `TRADING_INVALID_ARGUMENT`。Finnhub 支持的指数/外汇/加密等符号会原样透传。
- **报价取值**：`c === undefined || c === 0` → `TRADING_SYMBOL_NOT_FOUND`（`src/rest.ts:108-110`）；
  返回 `{ symbol, price: c, timestamp }`，`t`（秒）转毫秒、缺失时回落 `Date.now()`（`src/rest.ts:113-119`）。
- **错误映射**：上游非 2xx → `TRADING_UPSTREAM_ERROR`（`src/rest.ts:89`）；`fetch` 抛错
  （不可达、响应非 JSON 等）→ `TRADING_NETWORK`（`src/rest.ts:94-98`）。错误载体
  `TradingServiceError` 携带 `code`（`src/rest.ts:18-27`）。
- 服务类成员用 TS 编译期 `private`（禁 ECMAScript `#`，cordis realm 代理会炸；`src/index.ts:55,100`）。

## 能力面

**注册工具**（`apply` 内 `ctx.inject(['tools'])`，`src/index.ts:187-228`，注册前先 `tools.get` 判重）：

| 工具 | 源码 |
|---|---|
| `us_get_ticker` | `src/index.ts:193-201` |
| `us_get_klines` | `src/index.ts:203-216` |
| `us_get_news` | `src/index.ts:218-227` |

**服务方法**：

| 方法 | 有/缺席 | 说明 |
|---|---|---|
| `MarketDataService.getTicker` | 有 | `src/index.ts:66-68` → `src/rest.ts:102-120` |
| `MarketDataService.getKlines` | 有 | `src/index.ts:70-72` → `src/rest.ts:122-161` |
| `MarketDataService.subscribeTicker` | 有 | 快照轮询，`intervalMs` 下限 1000 ms、默认 5000 ms，`dispose()` 清定时器（`src/index.ts:86-94`） |
| `getNews`（契约外扩展） | 有 | `src/index.ts:74-76` → `src/rest.ts:163-171`；对应工具 `us_get_news` |
| `MarketDataService.getFundamentals`（可选契约方法，`packages/api/src/index.ts:748`） | 有 | `src/index.ts:82-84` → `src/rest.ts:173-191`；**未注册工具**，`/stock/metric` 失败时静默回落空指标（`src/rest.ts:177,179-180`） |
| `MarketDataService.listInstruments`（可选契约方法，`packages/api/src/index.ts:741`） | 有 | `src/index.ts:78-80` → `src/rest.ts:193-200`；本包签名多收一个可选 `query`，返回 `{ symbol, name }` 行而非 `InstrumentRef`；无 query 时直接返回 `[]`；**未注册工具** |
| `MarketDataService.getTickers`（可选批量报价，`packages/api/src/index.ts:733`） | 未实现 | 无批量端点实现，调用方回落逐只 `getTicker` |
| `getOrderbook` / `getRecentTrades` | 未实现 | 契约可选方法全缺（`packages/api/src/index.ts:768,774`） |
| `TradeService.getBalance` | 有 | 固定返回 `{ currency: 'USD', available: 100000, total: 100000 }`（`src/rest.ts:202-204`），非真实券商余额 |
| `TradeService.placeOrder` | 有 | 服务缝三态闸门（`src/index.ts:116-143`）；无工具入口 |
| `TradeService.cancelOrder` | 有 | 与真实下单同门槛，可抛 `TRADING_LIVE_TRADING_DISABLED`（`src/index.ts:145-155`）；无工具入口 |
| `TradeService.getPositions` / `getOrders` | 有 | 恒返回 `[]`（`src/index.ts:157-163`） |
| 盘口 / 主动买盘 / 委托簿 | 未实现 | 无对应服务方法与工具 |

## 已知边界（源码级，未经网络实测）

- **rest 层是 sim stub**：`placeOrder` 恒返回 `dryRun: true` 的模拟回执（`src/rest.ts:206-218`）、
  `getBalance` 恒 100000（`src/rest.ts:202-204`）；
  `.agents/notes/implemented/feature/2026-09-01-service-seam-order-gate.md` 第 20 行把本包 rest 层记为
  「模拟 stub」。因此闸门 ③ 即使放行，也不会产生真实券商成交。
- **无工具层交易面**：本包只注册 3 个行情工具；全仓 `us_place_order` 只出现在 connector-alpaca /
  connector-ibkr / connector-stooq / connector-yahoo。本包 `TradeService` 仅经 `tradingUsTrade`
  服务注入面被调用——服务缝闸门正是为这条绕过工具层的路径设的。
- **`env` 是死配置**：`src/index.ts:45` 声明并默认 `'demo'`，但 `src/` 内除 `apiKeyRef` 外无任何地方
  读取它（`src/index.ts:181`、`src/dataplane.ts:29` 都只用 `apiKeyRef`），`demo`/`live` 无分流效果。
- **周期词汇比同市场另两个商业源少一个 `4h`**：fmp / polygon 的 `INTERVAL_VOCABULARY` 含 `4h`，本包不含。
- **0 价被当作未找到**：`c === 0` 同样判为 `TRADING_SYMBOL_NOT_FOUND`（`src/rest.ts:108`）。
- **K 线空回不区分原因**：上游 `s !== 'ok'`（无数据、额度或权限受限等）一律静默返回 `[]`
  （`src/rest.ts:139-141`），调用方拿不到区分信号。
- **`us_get_news` 与 `@dshtrading/kit-us` 同名双源**：
  `.agents/notes/implemented/feature/2026-09-08-agent-native-tool-surface.md` 第 63 行记录该同名**不做合并**——
  kit 侧走 Yahoo + Google News RSS 的当前新闻，本包走 Finnhub `/company-news` 的近 7 天历史序列，
  语义与供应商都不同。
- **未实证项**：报价 / K 线 / 新闻 / 指标端点的真实响应形态、字段口径、限流与额度表现，本仓均无出网证据。

## 合规记录

- **需自备 API key（BYOK）**：配置只存 ref 名 `FINNHUB_API_KEY`；运行期先取
  `tradingMarketRouter.getCredential('finnhub')` 的 `apiKey`，缺失时回落同名环境变量
  （`src/index.ts:179-181`；数据面行同法，`src/dataplane.ts:29`）。本仓不内置、不落库、不打印 key。
- **key 随查询参数出网**：每次请求把 key 以 `token=<key>` 拼进 URL（`src/rest.ts:82`），会进入上游访问
  日志与进程环境可见范围。上游是商业注册制数据源，设置页把该源标为 `type: 'commercial'`
  （`packages/client-ui-settings/src/client/trading-settings-controller.ts:33`）。
- **免费额度与再分发边界以 Finnhub 服务条款为准**：本仓不缓存、不再分发任何行情或新闻数据。
  `docs/guides/connectors-guide.md` 第 35 行列有一句免费额度描述——该数字来自文档而非源码或 spike，
  本仓未复验，**一律以 Finnhub 官方条款为准**。
- **新闻条目不做本地持久化**：`/company-news` 返回体按上游原样取前 10 条即返回（`src/rest.ts:170`），
  不落盘。

## 出网验证

本包暂无已提交的独立出网验证脚本（`spikes/` 下没有 `impl-finnhub*` 目录；
`spikes/impl-service-seam-gate/net-verify.mjs` 只 import `connector-okx` 的构建产物）。

可复跑的最小入口：

```sh
# 1) 离线契约（不需要 key，不出网）
pnpm --filter @dshtrading/connector-finnhub test

# 2) 真实出网（需自备 key）。lib/ 是 tsdown 构建产物、被 .gitignore 忽略，先构建再 import：
pnpm --filter @dshtrading/connector-finnhub build
FINNHUB_API_KEY='<your-key>' node --input-type=module -e "
import { FinnhubRestClient } from './packages/connector-finnhub/lib/rest.js'
const client = new FinnhubRestClient({ apiKey: process.env.FINNHUB_API_KEY })
console.log(JSON.stringify(await client.getTicker('AAPL')))
console.log(JSON.stringify((await client.getKlines('AAPL', '1d', 5)).slice(-2)))
"
```

未设 `FINNHUB_API_KEY` 时 URL 不会附加 `token`（`src/rest.ts:82`），请求照发、由上游裁决，
非 2xx 一律映射为 `TRADING_UPSTREAM_ERROR`（`src/rest.ts:88-90`）。
