# @dshtrading/connector-tushare

Tushare Pro A 股连接器：提供 `tradingCnMarketData` 行情服务与 3 个 `cn_*` 工具
（`cn_get_ticker` / `cn_get_klines` / `cn_get_valuation`），Token 走 BYOK（设置中心
`credentials.tushare.token` 优先，`tokenRef` 指向的环境变量兜底）。包内另有
`TushareTradeService`，但未注册进交易注册表、无下单工具，其 rest 层是本地模拟、账户读面失败关闭（见「已知边界」）。

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
| `enabled` | `true` | 是否激活本连接器（`src/index.ts:41`） |
| `dryRun` | `true` | 默认模拟下单（`src/index.ts:42`） |
| `liveTrading` | `false` | 是否允许实盘；非权威镜像，实盘授权在 `@dshtrading/authority`（`src/index.ts:43`） |
| `tokenRef` | `'TUSHARE_TOKEN'` | 兜底取 Token 的环境变量名（BYOK）；设置中心 `dshtrading.credentials.tushare.token` 优先（`src/index.ts:44`、`src/index.ts:185-190`） |

## 接线

- **数据面行**：`packages/cn/cordis.patch.yml:31-34` → 行 id `dsh-trading-cn-dataplane-tushare`
  （name `@dshtrading/connector-tushare/dataplane`，行 config 只写 `enabled: true`）。
  注册 `(cn, tushare)` 进 `tradingMarketDataRegistry`（`src/dataplane.ts:40`），不占根市场键。
- **preset 行**：`packages/cn/assets/preset/cn-trader/agent.cordis.yml:55-60` → 行 id
  `dsh-trading-cn-connector-tushare`（`config: {enabled: true, dryRun: true, liveTrading: false}`）。
- **bundle 依赖**：`packages/cn/package.json:36` 的 `"@dshtrading/connector-tushare": "workspace:*"`。
- **provider 词汇**：`packages/router/src/index.ts:76`；与 `src/index.ts:166` 的
  `ROUTER_PROVIDER = 'tushare'` 同名。
- **服务键**：`tradingCnMarketData`（`src/index.ts:47`；dataplane 侧 isolate 同名，`src/dataplane.ts:38`）。
- **凭证解析只有一份**（`createTokenProvider`，`src/index.ts:185-190`）：设置中心
  `dshtrading.credentials.tushare.token`（router `getCredential('tushare').token`）优先、
  `process.env[config.tokenRef]` 兜底，**每次请求解析**（惰性）——settings 用户层加载/修改
  晚于插件 `apply` 也生效。主入口（`src/index.ts:196-198`）与数据面行（`src/dataplane.ts:32`）
  同用这一份，故设置页写入的 Token 在宿主面数据行与工具面都生效；`tokenRef` 只是环境变量名，
  凭证值只经 ref 与设置中心，不进日志/回执（收敛记录见
  [.agents/notes/implemented/bug-fix/2026-10-15-connector-tushare-dataplane-lazy-credential.md](../../.agents/notes/implemented/bug-fix/2026-10-15-connector-tushare-dataplane-lazy-credential.md)）。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:58`
  （`PROVIDER_LABELS` 的 `tushare` 条目：`env: 'TUSHARE_TOKEN'`、`markets: ['cn']`）与
  `packages/client-ui-settings/src/client/locales.ts` 的 `'provider.tushare'` 条目（zh / en 都是 `Tushare Pro`）。
  凭据卡片字段 `token`（`trading-settings-controller.ts:160`）由本包的 `createTokenProvider` 消费。

## 上游端点

| 用途 | 端点 | 源码 |
|---|---|---|
| 全部接口（单端点 POST，`api_name` 分流） | `POST http://api.tushare.pro`，体 `{api_name, token, params, fields}` | `src/rest.ts:72`、`src/rest.ts:97-101` |
| 报价 | `api_name: 'daily'`，`params: {ts_code, limit: 1}` | `src/rest.ts:147` |
| 分钟线 | `api_name: 'stk_mins'`，`params: {ts_code, freq}`（`1h` → `60min`），`fields: trade_time,open,close,high,low,vol` | `src/rest.ts:171-181` |
| 日线 / 周线 / 月线 | `api_name: 'daily'` / `'weekly'` / `'monthly'`，`fields: trade_date,open,high,low,close,vol` | `src/rest.ts:198-207` |
| 估值 | `api_name: 'daily_basic'`，`params: {ts_code, limit: 1}` | `src/rest.ts:229` |

响应形态固定为 `{code, msg, data: {fields, items}}`，按 `fields` × `items` 逐位展开成对象
（`src/rest.ts:119-124`）。

## 周期与契约

- **周期词汇**：`INTERVAL_VOCABULARY = ['1m','5m','15m','30m','1h','1d','1w','1M']`（`src/rest.ts:27`），
  同一数组进 `cn_get_klines` 的 `interval` 枚举（`src/index.ts:221`）。
- **周期分流**（`src/rest.ts:171,198`）：`1m/5m/15m/30m/1h` → `stk_mins`（`freq` 为 `1min`/`5min`/…/`60min`），
  `1w` → `weekly`，`1M` → `monthly`，其余 → `daily`。
- **符号形态**（`toTushareCode`，`src/rest.ts:29-42`）：含 `.` 原样；裸码 `6`/`5`/`9`→`.SH`，
  `0`/`3`/`1`→`.SZ`，`8`/`4`→`.BJ`，其余→`.SH`。
- **`getTicker` 不是实时报价**：取最近一根 `daily` 的 `close`（`src/rest.ts:161`），
  `timestamp` 按 `trade_date` 的当地 15:00 用本地时区构造（`src/rest.ts:154-157`），
  且回执不含 `prevClose` / `changePercent`。
- **`limit` 只在本地下刀**：K 线请求不带日期窗口或上游 limit，返回后做
  `items.slice(0, limit).reverse()`（`src/rest.ts:183`、`src/rest.ts:209`）——可取根数由上游默认窗口决定。
- **错误映射**：无 Token → `TRADING_CREDENTIALS_MISSING`（`src/rest.ts:82`）；
  非 2xx → `TRADING_UPSTREAM_ERROR`（`src/rest.ts:103`）；业务 `code !== 0` 或缺 `data`
  → `TRADING_EXCHANGE_ERROR`（`src/rest.ts:113`）；不可达或响应非 JSON → `TRADING_NETWORK`（`src/rest.ts:129`）；
  `daily` 空结果 → `TRADING_SYMBOL_NOT_FOUND`（`src/rest.ts:150`）。

## 能力面

| 服务方法 | 本包实现 | 工具暴露 |
|---|---|---|
| `TushareMarketDataService.getTicker`（最近日线收盘，非实时） | 有（`src/index.ts:62`） | `cn_get_ticker`（`src/index.ts:207`） |
| `TushareMarketDataService.getKlines` | 有（`src/index.ts:66`） | `cn_get_klines`（`src/index.ts:217`） |
| `TushareMarketDataService.getDailyBasic` | 有（`src/index.ts:70`） | `cn_get_valuation`（`src/index.ts:232`） |
| `TushareMarketDataService.subscribeTicker`（轮询，最小 1000 ms、默认 5000 ms） | 有（`src/index.ts:74-82`） | 缺席 |
| `TushareTradeService.placeOrder` / `cancelOrder` | 有闸门；rest 层为本地模拟，不发请求（`src/index.ts:100`、`src/index.ts:129`；`src/rest.ts:233`、`src/rest.ts:248`） | 未实现 |
| `TushareTradeService.getOrder` | 有（失败关闭：恒抛 `TRADING_NOT_IMPLEMENTED`，`src/index.ts:149-155`） | 未实现 |
| `TushareTradeService.getPositions` | 有（失败关闭：恒抛 `TRADING_NOT_IMPLEMENTED`，`src/index.ts:157-163`） | 未实现 |
| `TushareTradeService.getBalance` / `getOrders` | 缺席（非契约方法未定义，`src/index.ts`） | 未实现 |
| `getBalances` / `listOpenOrders` / `listTradeFills` | 缺席（可选方法未定义，消费方按「缺席」处理） | 未实现 |
| `listInstruments` / 盘口 / 财务报表 | 未实现 | 未实现 |

## 已知边界

- **无交易通道**：`TushareTradeService` 未注册进 `tradingTradeRegistry`，`apply` 里构造的 `trade`
  实例没有任何工具使用（`src/index.ts:198`）；rest 层 `placeOrder` / `cancelOrder` 是本地合成回执
  （`src/rest.ts:233-250`），不发请求。Tushare Pro 是行情数据服务，本连接器没有券商/交易所账户通道，
  所以**账户读面失败关闭**：`getOrder` / `getPositions` 恒抛 `TRADING_NOT_IMPLEMENTED`（语义是「不可用」，
  不是「订单不存在」或「没有持仓」）；非契约方法 `getBalance` / `getOrders` 与可选方法
  `getBalances` / `listOpenOrders` / `listTradeFills` 直接缺席。此前编造的 1000000 CNY 余额与恒空数组已删除。
- **dataplane 与主入口凭证来源一致**（见「接线」）：两处都经 `createTokenProvider` 每请求解析
  （设置中心优先、env 兜底），凭证缺失时 fail-closed 抛 `TRADING_CREDENTIALS_MISSING`，不静默回落。
- **`stk_mins` 属 Tushare 积分/权限面接口**：分钟线是否对本账号开放取决于用户积分，本仓无权限证据（未实证）。
- **无 `listInstruments`**：名册检索未实现；能力面只有拉取式 REST，无实时推送。
- 报价无官方昨收锚点，`prevClose` / `changePercent` 缺席（同类缺口登记在
  [.agents/notes/implemented/bug-fix/2026-09-01-us-quote-prevclose-yahoo-anchor.md](../../.agents/notes/implemented/bug-fix/2026-09-01-us-quote-prevclose-yahoo-anchor.md)）。
- 服务缝三态矩阵由离线测试覆盖，未做真实网络验证（同引
  [spikes/impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md) 的范围说明）。

## 合规记录

Tushare Pro 是商业数据服务：Token 属用户 BYOK，经 `createTokenProvider` 注入
（`src/index.ts:185-190`：设置中心 `credentials.tushare.token` 优先、`tokenRef` 指向的环境变量兜底），
本包不内置、不落日志；接口访问受 Tushare 积分与权限规则约束，
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
账户读面失败关闭 `packages/connector-tushare/test/account-read-surface.test.ts`、
数据面装配 `packages/connector-tushare/test/dataplane-loader.test.ts`。
