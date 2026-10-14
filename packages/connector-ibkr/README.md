# @dshtrading/connector-ibkr

美股（us）**行情 + 交易双面**连接器：上游不是公开 REST，而是**用户本机的 Interactive Brokers
Client Portal Gateway**（IBKR Client Portal Web API）。实现 `@dshtrading/api` 的 `MarketDataService` /
`TradeService` 两个契约，注册服务键 `tradingUsMarketData` / `tradingUsTrade`，注册 5 个 `us_*` 工具。
被 us bundle 以 `workspace:*` 依赖（`packages/us/package.json`）。

## 状态

**未实证**：本包没有已提交的真实网关请求记录（无原始响应、无真机错误码分布）。上游路径与字段映射全部
取自源码（下文逐条给出行号），**未经真机核对**。已提交的相关证据只有两类：

- `spikes/impl-service-seam-gate/NET-VERIFY.md`（2026-09-01，第 36 行）：明确记录未对各家券商网关做真实
  下单验证；本轮唯一真实网络验证对象是 OKX。
- `spikes/verify-connectors-suite/EVIDENCE.md`（2026-08-31，第 37-39 行）：当时的评审随测把 ibkr 交易面
  判为「本地 stub：`placeOrder` 不发网络请求、`getBalance()` 硬编码 USD 100000」。该结论对应 commit
  `b80000e` 的代码，与当前源码（`src/rest.ts:192-253` 真实 POST 网关）**已不一致**，仅作历史记录，
  不代表现状，也不构成现状的实证。
- `.agents/notes/implemented/feature/2026-09-01-service-seam-order-gate.md`：记录本包服务缝三态闸门的
  离线测试覆盖，非出网证据。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；注意与其他连接器不同，本包默认开启（`src/index.ts:51`） |
| `env` | `'demo'` | 运行环境标签；只进意图台账作用域，**不改变网关地址**（`src/index.ts:52,116-121`） |
| `dryRun` | `true` | 强制模拟：为 true 时即使请求 `dryRun:false` 也只回本地模拟回执（`src/index.ts:139`） |
| `liveTrading` | `false` | 实盘请求的**非权威镜像**；真实放行需 `@dshtrading/authority` 平面的人工签署授权（`liveTradingEnabled()`，`src/index.ts:132`） |
| `gatewayUrl` | `'https://127.0.0.1:5000/v1/api'` | 本地 Client Portal Gateway 地址（`src/index.ts:55`） |
| `accountId` | 无默认（可选） | IBKR 账户 ID；台账账户定位与全部账户级端点都依赖它（`src/index.ts:56,117-121`） |

字段名与默认值见 `src/index.ts:50-57`。与 alpaca 的关键差异：

- **没有凭证 ref 字段**：认证由本机网关的登录会话承担，本连接器不发任何凭证头——`requestJson` 只设
  `Content-Type: application/json`（`src/rest.ts:56-59`）。用户需自行启动并登录 Client Portal Gateway。
- **`accountId` 是硬前置**：余额/持仓/下单/撤单在缺 `accountId` 时抛 `TRADING_AUTH_FAILED`
  （`src/rest.ts:145,166,189,258`）；`accountId` 未配置时会回落到环境变量 `IBKR_ACCOUNT_ID`
  （`src/rest.ts:49`）。
- **交易安全三件套**：下单默认 dry-run（工具参数 `dryRun` 默认 `true`，`src/index.ts:251`；工具执行
  `args.dryRun !== false` 才走实盘，第 260 行；服务内 `order.dryRun ?? true`，第 131 行）；`liveTrading`
  必须显式开启且只是镜像，权威是签署平面（工具层第 282-288 行、服务缝第 132-138 行，撤单同门槛
  第 177-182 行）；工具名 `us_place_order` / `us_cancel_order` 命中 base 统一审批闸门
  `LIVE_ACTION_GATE_PATTERN`（`packages/base/src/index.ts:63`），无人在场时 ask 降级为 deny
  （`packages/base/src/index.ts:20-24`）。
- **实盘幂等**：意图台账作用域含 `provider: 'ibkr'` / `env` / `accountId ?? 'default'`（`src/index.ts:117-121`）；
  venue 侧用官方 `cOID`，由 intentId 确定性派生、前缀 `dsht`、上限 40（`src/index.ts:68,167`）。

## 接线

- **数据面行**：`packages/us/cordis.patch.yml:42-45` → 行 id `dsh-trading-us-dataplane-ibkr`，
  `name: '@dshtrading/connector-ibkr/dataplane'`，行 config 只写 `enabled: true`。
  `src/dataplane.ts` 重导出 `Config`（第 10 行）让 loader 补全 schema 默认值，在 `tradingUsMarketData`
  isolate realm 内构造行情服务（第 34 行）并 `register('us', 'ibkr', …)` 进 `tradingMarketDataRegistry`
  （第 36 行）；无注册表的老部署回退直接构造（第 30-33 行）。
  **该文件不解析也不注册 `tradingTradeRegistry`**（全文件无此键）——交易服务只在 preset 面可用，
  不进行情/交易注册表消费链路。
- **preset 行**：`packages/us/assets/preset/us-trader/agent.cordis.yml:104-117` → 组 id
  `dsh-trading-us-connector-ibkr-group`，`isolate: {tradingUsMarketData, tradingUsTrade}`（第 107-109 行），
  行 id `dsh-trading-us-connector-ibkr`，行 config `enabled: true` / `dryRun: true` / `liveTrading: false`。
  该行的 `apply` 直接构造行情与交易两个服务（`src/index.ts:208-209`），不经注册表。
- **provider 词汇**：`packages/router/src/index.ts:73`（`PROVIDER_VOCABULARY` 的 `'ibkr'`）。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:35`
  （`PROVIDER_LABELS`，`type: 'gateway'`，`env: 'IBKR_GATEWAY_URL'`，`markets: ['us', 'hk']`）与
  `packages/client-ui-settings/src/client/locales.ts:247`（中文 `IBKR (盈透证券)`）/ 第 393 行
  （英文 `IBKR (Interactive Brokers)`）；凭据表单字段为 `gatewayUrl`（第 139-140 行）。
- **bundle 依赖**：`packages/us/package.json` 的 `@dshtrading/connector-ibkr: workspace:*`。
- **激活条件**：`routeAllows()` 要求 `enabled` 且 `tradingMarketRouter.activeProvider('us') === 'ibkr'`
  （`src/index.ts:197-202`）。

## 上游端点

全部路径相对 `gatewayUrl`（默认 `https://127.0.0.1:5000/v1/api`，`src/rest.ts:48`）。网关是用户本机的
IBKR Client Portal Gateway，不是公开互联网端点。

| 用途 | 端点 | 源码 |
|---|---|---|
| 行情快照 | `GET /iserver/marketdata/snapshot?symbols={sym}&fields=31,84,86` | `src/rest.ts:77-79` |
| 历史 K 线 | `GET /hmds/history?symbol={sym}&period={limit}d&bar={interval}` | `src/rest.ts:107-109` |
| 账户台账 | `GET /portfolio/{accountId}/ledger` | `src/rest.ts:147-149` |
| 持仓 | `GET /portfolio/{accountId}/positions/0` | `src/rest.ts:175` |
| 下单 | `POST /iserver/account/{accountId}/orders`（`secType: STK`，`tif: DAY`，可带 `cOID`） | `src/rest.ts:192-213` |
| 下单预警确认 | `POST /iserver/reply/{replyId}`（`{confirmed: true}`） | `src/rest.ts:222-228` |
| 撤单 | `DELETE /iserver/account/{accountId}/order/{orderId}` | `src/rest.ts:260-262` |
| 行情回退源 | `GET https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=…&range=…` | `src/rest.ts:91,123` |

## 周期与契约

- **周期词汇 9 个**：`1m/5m/15m/30m/1h/4h/1d/1w/1M`（`src/rest.ts:28`），但**没有到上游的映射表**：
  `interval` 原样作为 `bar=` 透传（`src/rest.ts:108`），Yahoo 回退也原样作 `interval=`（第 123 行）。
  因此本包不产生 `TRADING_UNSUPPORTED_INTERVAL`，非法周期由上游拒绝。
- **`period` 恒按天**：`period={limit}d`（`src/rest.ts:108`）与周期无关；`limit` 缺省 100
  （`src/rest.ts:104`，工具默认同为 100，`src/index.ts:233`），不做上限夹取。
- **符号形态**：只做 trim + 大写，空串抛 `TRADING_INVALID_ARGUMENT`（`src/rest.ts:30-34`）；
  **无格式白名单**（与 alpaca 的 `^[A-Z]{1,10}(\.[A-Z]{1,4})?$` 强校验不同）。
- **错误映射**：任何非 2xx → `TRADING_UPSTREAM_ERROR`（`src/rest.ts:60-62`，401/403 也走这一条，
  不单列认证错误）；请求抛错 → `TRADING_NETWORK`（第 64-71 行）；缺 `accountId` →
  `TRADING_AUTH_FAILED`（第 145,166,189,258 行）；空账本 → `TRADING_EXCHANGE_ERROR`（第 152-154 行）；
  下单空响应 → `TRADING_EXCHANGE_ERROR`（第 215-217 行）；回执无真实 `order_id` →
  `TRADING_EXCHANGE_ERROR`（第 235-240 行，绝不自造 id）。
- **无本地超时**：`requestJson` 不设 `AbortController`/超时（`src/rest.ts:53-72`），网关无响应时请求
  没有连接器侧上限（对比 alpaca 的 10 s）。
- **下单预警自动确认**：响应里出现 `id` 且没有 `order_id` 时，连接器自动 `POST /iserver/reply/{id}`
  带 `confirmed: true`（`src/rest.ts:219-229`）——上游的 pre-order warning 不再回到用户面前。
- **回执语义**：下单成功以真实 `order_id` 为准（`src/rest.ts:234-240`）；`status` 取网关
  `order_status` 小写原样（第 247 行）。
- **服务类字段用 TS 编译期 `private`**（禁 ECMAScript `#`，cordis realm 代理会炸）。

## 能力面

| 面 | 服务方法 | 状态 |
|---|---|---|
| 行情 | `getTicker` | 有（快照 `field 31`；失败时静默回退 Yahoo，`src/rest.ts:74-102`） |
| 行情 | `getKlines` | 有（`/hmds/history`；失败时静默回退 Yahoo，`src/rest.ts:104-140`） |
| 行情 | `subscribeTicker` | 有（快照轮询，缺省 5000 ms、下限 1000 ms，`src/index.ts:90-98`） |
| 行情 | `listInstruments` | 缺席 |
| 行情 | `getOrderbook` | 缺席（`fields=31,84,86` 已请求 84/86 但只解析 `31`，`src/rest.ts:77-87`） |
| 行情 | `getTickers`（批量） | 缺席 |
| 交易 | `placeOrder` | 有（三态闸门 + 意图台账） |
| 交易 | `cancelOrder` | 有（与下单同门槛：需 `liveTrading` 且 `dryRun=false`，`src/index.ts:177-182`） |
| 交易 | `getBalance` | 有（返回形状与 `AccountBalance` 契约不一致，见「已知边界」） |
| 交易 | `getPositions` | 有（返回形状与 `Position` 契约不一致，见「已知边界」） |
| 交易 | `getOrder` | **缺席**（`@dshtrading/api` 的 `TradeService.getOrder` 是必选方法，`packages/api/src/index.ts:839`） |
| 交易 | `listOpenOrders` / `listTradeFills` / `getBalances` / `setLeverage` | 缺席 |
| 交易 | `getOrders`（非契约方法） | 恒返回空数组（`src/index.ts:190-192`） |

注册的工具（`src/index.ts` 的 `register` 调用，同名已存在则跳过，第 213-215 行）：

| 工具 | 注册位置 | 说明 |
|---|---|---|
| `us_get_ticker` | `src/index.ts:217-225` | 最新价 |
| `us_get_klines` | `src/index.ts:227-240` | interval 用 9 词汇枚举，缺省 `1d`；limit 缺省 100 |
| `us_place_order` | `src/index.ts:242-300` | `dryRun !== false` 时回本地模拟回执（带参照价）；否则要求 `liveTrading` |
| `us_cancel_order` | `src/index.ts:302-311` | 参数名 `ordId`；实盘动作，同样需 `liveTrading` 且 `dryRun=false` |
| `us_get_balance` | `src/index.ts:313-322` | 账户余额（与 base 的只读同名工具重名，见「已知边界」） |

## 已知边界

- **未实证项**：全部网关端点、真机错误码、本地自签证书下的 HTTPS 连通性均未验证。
  `spikes/impl-service-seam-gate/NET-VERIFY.md:36` 明确记录未对券商网关做真实下单验证。
- **历史结论已过期**：`spikes/verify-connectors-suite/EVIDENCE.md:37-39`（2026-08-31）把 ibkr 交易面记为
  本地 stub（不发网络、余额硬编码）；当前源码已是真实网关调用（`src/rest.ts:192-253`），
  但**现状同样没有实证**。
- **静默回退公共源**：`getTicker` / `getKlines` 在 `requestJson` 抛任何错（含非 2xx）时改打
  `query1.finance.yahoo.com`（`src/rest.ts:89-99,121-137`），成功后按本连接器的输出返回该价格——
  网关未登录或故障时，用户看到的可能不是 IBKR 数据（详见「合规记录」）。
- **回退路径的 `closeTime` 恒按一天**：回退分支 `openTime + 86400 s − 1`（`src/rest.ts:118,135`），
  非日线周期下与周期无关。
- **契约形状不符**：`getBalance` 返回 `{currency, available, total}`（`src/rest.ts:156-160`），而
  `AccountBalance` 是 `{asset, free, locked}`（`packages/api/src/index.ts:578-582`）；`getPositions` 返回
  `{symbol, quantity, entryPrice, unrealizedPnl}`（`src/rest.ts:178-183`），而 `Position` 要求
  `{symbol, side, size, entryPrice, timestamp}`（`packages/api/src/index.ts:499-519`）。运行期后果
  （消费方读到 undefined 的表现）**未实证**。
- **`getOrder` 缺席**：`TradeService` 的必选方法未实现（`packages/api/src/index.ts:839`），本包也没有
  单笔订单查询工具。
- **交易面不进交易注册表**：`src/dataplane.ts` 只注册行情注册表，`tradingTradeRegistry` 里没有
  `(us, ibkr)` 条目；读该注册表的 base 只读账户/交易工具（`packages/base/src/market-tools.ts:471`）
  因此看不到 ibkr 交易服务。
- **`us_get_balance` 与 base 只读工具同名**：base 的同名工具先到先得、不覆盖已注册者
  （`packages/base/src/market-tools.ts:463-464`），实际生效的是本连接器版本（返回形状见上一条契约不符）。
- **设置页登记了 hk，连接器只覆盖 us**：`PROVIDER_LABELS` 里 ibkr 的 `markets` 是 `['us', 'hk']`
  （`trading-settings-controller.ts:35`），但本包 `MARKET = 'us'`（`src/dataplane.ts:25,36`）、
  `routeAllows(ctx, config, 'us')`（`src/index.ts:206`）——hk 选择没有对应的数据面实例。
- **`IBKR_GATEWAY_URL` 在插件路径下不生效**：`Config` 的 schema 默认值总会先填上 `gatewayUrl`
  （`src/index.ts:55`），`src/rest.ts:48` 的环境变量回落只在直连 `IbkrRestClient` 且不传
  `gatewayUrl` 时命中。
- **无本地超时**：`requestJson` 不带超时/中止（`src/rest.ts:53-72`）。
- **pre-order warning 自动确认**：上游预警被连接器自动接受（`src/rest.ts:219-229`）。

## 合规记录

**IBKR 走用户本机的 Client Portal Gateway，不是公开端点**：连接器不携带也不保存任何 IBKR 凭证
（认证靠用户自己在本地网关建立的会话，`src/rest.ts:56-59`），本仓不缓存、不再分发任何行情或账户数据；
使用边界以 Interactive Brokers 的 Client Portal Web API 条款为准。

**回退源是 Yahoo 公开端点**：网关不可达时 `getTicker`/`getKlines` 会改打
`query1.finance.yahoo.com`（`src/rest.ts:91,123`）。该端点非官方、无 key、无 SLA，其边界与合规口径见
[connector-yahoo 的合规记录](../connector-yahoo/README.md)；用户需知悉回退发生时的数据并非来自 IBKR。
合规要求见 README 铁律 #5。

## 出网验证

本包暂无已提交的独立出网验证脚本（`spikes/verify-connectors-suite/` 只提交了 `EVIDENCE.md`，没有可跑
脚本；`spikes/impl-qmt-alpaca-dataplane-activation/run-loader-activation-probe.mjs` 只覆盖 qmt/alpaca 两行）。
可复跑的最小入口（不触网）：

```sh
pnpm --filter @dshtrading/connector-ibkr test    # 离线契约测试（fake 网关，无真实网络）
```

真机复跑需先在本机启动并登录 IBKR Client Portal Gateway（默认 `https://127.0.0.1:5000/v1/api`），
配好 `accountId`（或 `IBKR_ACCOUNT_ID`）后自写探针；本仓未提交任何真实网关的请求或响应记录。
