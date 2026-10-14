# @dshtrading/connector-tushare

Tushare Pro A 股连接器：提供 `tradingCnMarketData` 行情服务与 3 个 `cn_*` 工具
（`cn_get_ticker` / `cn_get_klines` / `cn_get_valuation`），Token 走 BYOK
（`tokenRef` 指向环境变量）。包内另有 `TushareTradeService`，但未注册进交易注册表、
无下单工具，其 rest 层是本地模拟（见「已知边界」）。

## 状态

**未实证**。本仓没有已提交的 tushare 出网脚本或原始响应证据：
[spikes/impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md)（2026-09-01）
只在「范围与未验证项」里把 tushare 归为「模拟 stub、未做真实网络验证」。

2026-10-14 本次会话实测了凭据缺失路径（无需 Token、不触网）：

    ./node_modules/.bin/tsx -e "import('./packages/connector-tushare/src/rest.ts').then(async m => { try { await new m.TushareRestClient().getTicker('600519.SH') } catch (e) { console.log(e.name, e.code) } })"
    # TradingServiceError TRADING_CREDENTIALS_MISSING

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器（`src/index.ts:43`） |
| `env` | `'demo'` | `demo` / `live`（`src/index.ts:44`） |
| `dryRun` | `true` | 默认模拟下单（`src/index.ts:45`） |
| `liveTrading` | `false` | 是否允许实盘；非权威镜像，实盘授权在 `@dshtrading/authority`（`src/index.ts:46`） |
| `tokenRef` | `'TUSHARE_TOKEN'` | 取 Token 的环境变量名（BYOK）（`src/index.ts:47`） |

## 接线

- **数据面行**：`packages/cn/cordis.patch.yml:31-34` → 行 id `dsh-trading-cn-dataplane-tushare`
  （name `@dshtrading/connector-tushare/dataplane`，行 config 只写 `enabled: true`）。
  注册 `(cn, tushare)` 进 `tradingMarketDataRegistry`（`src/dataplane.ts:37`），不占根市场键。
- **preset 行**：`packages/cn/assets/preset/cn-trader/agent.cordis.yml:55-60` → 行 id
  `dsh-trading-cn-connector-tushare`（`config: {enabled: true, dryRun: true, liveTrading: false}`）。
- **bundle 依赖**：`packages/cn/package.json:36` 的 `"@dshtrading/connector-tushare": "workspace:*"`。
- **provider 词汇**：`packages/router/src/index.ts:76`；与 `src/index.ts:157` 的
  `ROUTER_PROVIDER = 'tushare'` 同名。
- **服务键**：`tradingCnMarketData`（`src/index.ts:50`；dataplane 侧 isolate 同名，`src/dataplane.ts:35`）。
- **凭证有两条路径、且不一致**：主入口 `apply` 先读 router 凭证
  （`router.getCredential('tushare').token`）、再回落 `process.env[config.tokenRef]`（`src/index.ts:170-172`）；
  **dataplane 行只读 `process.env[config.tokenRef]`**（`src/dataplane.ts:29`）。
  宿主面数据行挂的正是 dataplane 入口，故设置页写入的 Token 到不了它（同类根因的对照记录见
  [.agents/notes/implemented/feature/2026-09-12-futures-market-group.md](../../.agents/notes/implemented/feature/2026-09-12-futures-market-group.md)）。
- **设置页显示名**：`packages/client-ui-settings/src/client/locales.ts:251`（zh `Tushare Pro`）与
  `:397`（en `Tushare Pro`）；凭证字段
  `packages/client-ui-settings/src/client/trading-settings-controller.ts:41`
  （`key: 'token'`、`secret: true`、env `TUSHARE_TOKEN`、`markets: ['cn']`）。

## 上游端点

| 用途 | 端点 | 源码 |
|---|---|---|
| 全部接口（单端点 POST，`api_name` 分流） | `POST http://api.tushare.pro`，体 `{api_name, token, params, fields}` | `src/rest.ts:70`、`src/rest.ts:91-95` |
| 报价 | `api_name: 'daily'`，`params: {ts_code, limit: 1}` | `src/rest.ts:141` |
| 分钟线 | `api_name: 'stk_mins'`，`params: {ts_code, freq}`（`1h` → `60min`），`fields: trade_time,open,close,high,low,vol` | `src/rest.ts:166-175` |
| 日线 / 周线 / 月线 | `api_name: 'daily'` / `'weekly'` / `'monthly'`，`fields: trade_date,open,high,low,close,vol` | `src/rest.ts:192-201` |
| 估值 | `api_name: 'daily_basic'`，`params: {ts_code, limit: 1}` | `src/rest.ts:223` |

响应形态固定为 `{code, msg, data: {fields, items}}`，按 `fields` × `items` 逐位展开成对象
（`src/rest.ts:112-119`）。

## 周期与契约

- **周期词汇**：`INTERVAL_VOCABULARY = ['1m','5m','15m','30m','1h','1d','1w','1M']`（`src/rest.ts:28`），
  同一数组进 `cn_get_klines` 的 `interval` 枚举（`src/index.ts:197`）。
- **周期分流**（`src/rest.ts:165,192`）：`1m/5m/15m/30m/1h` → `stk_mins`（`freq` 为 `1min`/`5min`/…/`60min`），
  `1w` → `weekly`，`1M` → `monthly`，其余 → `daily`。
- **符号形态**（`toTushareCode`，`src/rest.ts:30-43`）：含 `.` 原样；裸码 `6`/`5`/`9`→`.SH`，
  `0`/`3`/`1`→`.SZ`，`8`/`4`→`.BJ`，其余→`.SH`。
- **`getTicker` 不是实时报价**：取最近一根 `daily` 的 `close`（`src/rest.ts:155`），
  `timestamp` 按 `trade_date` 的当地 15:00 用本地时区构造（`src/rest.ts:148-151`），
  且回执不含 `prevClose` / `changePercent`。
- **`limit` 只在本地下刀**：K 线请求不带日期窗口或上游 limit，返回后做
  `items.slice(0, limit).reverse()`（`src/rest.ts:177`、`src/rest.ts:203`）——可取根数由上游默认窗口决定。
- **错误映射**：无 Token → `TRADING_CREDENTIALS_MISSING`（`src/rest.ts:77`）；
  非 2xx → `TRADING_UPSTREAM_ERROR`（`src/rest.ts:97`）；业务 `code !== 0` 或缺 `data`
  → `TRADING_EXCHANGE_ERROR`（`src/rest.ts:106`）；不可达或响应非 JSON → `TRADING_NETWORK`（`src/rest.ts:122`）；
  `daily` 空结果 → `TRADING_SYMBOL_NOT_FOUND`（`src/rest.ts:144`）。

## 能力面

| 服务方法 | 本包实现 | 工具暴露 |
|---|---|---|
| `TushareMarketDataService.getTicker`（最近日线收盘，非实时） | 有（`src/index.ts:65`） | `cn_get_ticker`（`src/index.ts:183`） |
| `TushareMarketDataService.getKlines` | 有（`src/index.ts:69`） | `cn_get_klines`（`src/index.ts:193`） |
| `TushareMarketDataService.getDailyBasic` | 有（`src/index.ts:73`） | `cn_get_valuation`（`src/index.ts:208`） |
| `TushareMarketDataService.subscribeTicker`（轮询，最小 1000 ms、默认 5000 ms） | 有（`src/index.ts:77-85`） | 缺席 |
| `TushareTradeService.placeOrder` / `cancelOrder` | 有闸门；rest 层为本地模拟，不发请求（`src/index.ts:107`、`src/index.ts:136`；`src/rest.ts:231`、`src/rest.ts:246`） | 未实现 |
| `TushareTradeService.getBalance` | 硬编码 `{currency: 'CNY', available: 1000000, total: 1000000}`（`src/rest.ts:228`） | 未实现 |
| `TushareTradeService.getPositions` / `getOrders` | 恒返回 `[]`（`src/index.ts:148-154`） | 未实现 |
| `listInstruments` / 盘口 / 财务报表 | 未实现 | 未实现 |

## 已知边界

- **无交易通道**：`TushareTradeService` 未注册进 `tradingTradeRegistry`，`apply` 里构造的 `trade`
  实例没有任何工具使用（`src/index.ts:174`）；rest 层 `placeOrder` / `cancelOrder` 是本地合成回执
  （`src/rest.ts:231-248`），`getBalance` 是硬编码常量，`getPositions` / `getOrders` 恒空。
- **dataplane 与主入口的凭证来源不一致**（见「接线」）：宿主面数据行下，设置页写入的 Token 不生效，
  只有 `process.env[config.tokenRef]` 有效；且 `src/dataplane.ts:29` 在 apply 期一次性快照环境变量，
  运行中改 env 不会重读。
- **`stk_mins` 属 Tushare 积分/权限面接口**：分钟线是否对本账号开放取决于用户积分，本仓无权限证据（未实证）。
- **无 `listInstruments`**：名册检索未实现；能力面只有拉取式 REST，无实时推送。
- 报价无官方昨收锚点，`prevClose` / `changePercent` 缺席（同类缺口登记在
  [.agents/notes/implemented/bug-fix/2026-09-01-us-quote-prevclose-yahoo-anchor.md](../../.agents/notes/implemented/bug-fix/2026-09-01-us-quote-prevclose-yahoo-anchor.md)）。
- 服务缝三态矩阵由离线测试覆盖，未做真实网络验证（同引
  [spikes/impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md) 的范围说明）。

## 合规记录

Tushare Pro 是商业数据服务：Token 属用户 BYOK，经 `tokenRef` 指向的环境变量或 router 凭证注入
（`src/index.ts:170-173`），本包不内置、不落日志；接口访问受 Tushare 积分与权限规则约束，
以 tushare.pro 服务条款为准。本仓不缓存、不再分发行情与财务数据。

## 出网验证

本包暂无已提交的独立出网验证脚本。最小复跑方式：

```sh
# 凭据缺失时的 fail-closed（无需 Token、不触网；2026-10-14 实测 code=TRADING_CREDENTIALS_MISSING）
./node_modules/.bin/tsx -e "import('./packages/connector-tushare/src/rest.ts').then(async m => { try { await new m.TushareRestClient().getTicker('600519.SH') } catch (e) { console.log(e.name, e.code) } })"

# 有 Token 时的真实取数（需 Tushare 账号与相应积分）
TUSHARE_TOKEN=<token> ./node_modules/.bin/tsx -e "import('./packages/connector-tushare/src/rest.ts').then(async m => console.log(JSON.stringify(await new m.TushareRestClient({ token: process.env.TUSHARE_TOKEN }).getKlines('600519.SH', '1d', 5))))"
```

不触网的离线矩阵：服务缝三态 `packages/connector-tushare/test/trade-gate.test.ts`、
数据面装配 `packages/connector-tushare/test/dataplane-loader.test.ts`。
