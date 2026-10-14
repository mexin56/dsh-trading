# @dshtrading/connector-qmt

迅投 MiniQMT A 股**券商实盘交易 + 行情**连接器：单包提供 `tradingCnMarketData` 与
`tradingCnTrade` 两个服务，注册 5 个 `cn_*` 工具（行情 2 + 交易 3）。
实盘动作受两重约束：`@dshtrading/authority` 的人工签署平面（`liveTrading` 只是非权威镜像），
以及下推到服务实现内第一步的三态闸门（工具层另有闸门，双保险）。

## 状态

**未实证（网关面从未有已提交的真实网络验证）**。

- 装配面有已提交的实证入口：[spikes/impl-qmt-alpaca-dataplane-activation/run-loader-activation-probe.mjs](../../spikes/impl-qmt-alpaca-dataplane-activation/run-loader-activation-probe.mjs)
  （2026-10-14，走 loader 真实激活路径判定 `cn/qmt` 行是否 activated 并打印行情/交易两张注册表内容；不触网）。
  根因与修复记录在 [.agents/notes/implemented/bug-fix/2026-10-14-qmt-alpaca-dataplane-config-schema.md](../../.agents/notes/implemented/bug-fix/2026-10-14-qmt-alpaca-dataplane-config-schema.md)。
- [spikes/verify-connectors-suite/EVIDENCE.md](../../spikes/verify-connectors-suite/EVIDENCE.md)（2026-08-31，commit `b80000e`）
  把 qmt 列为「交易面 stub：`placeOrder` 不发网络请求、`getBalance` 硬编码 CNY 500000」——该结论针对旧实现，
  现实现经本地网关真实 HTTP（`src/rest.ts:183-295`），此处仅作历史记录引用，不代表当前行为。
- [spikes/impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md)（2026-09-01）
  在「范围与未验证项」中明确：qmt 等券商网关**未做真实下单验证**，服务缝三态只由离线矩阵
  `test/trade-gate.test.ts` 覆盖。
- 2026-10-14 本出口对 `push2.eastmoney.com` 不可达（`curl: (52) Empty reply from server`），
  故网关离线时的东财回退路径本轮同样无法实证。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器（`src/index.ts:51`） |
| `env` | `'demo'` | `demo` / `live`；作为 `OrderIntentLedger` 的 environment 维度参与幂等判定（`src/index.ts:52`、`src/index.ts:117`） |
| `dryRun` | `true` | 默认模拟下单；为真时服务缝强制本地模拟回执（`src/index.ts:53`、`src/index.ts:137`、`src/index.ts:174`） |
| `liveTrading` | `false` | 是否允许实盘；非权威镜像，实盘授权由 `@dshtrading/authority` 裁定（`src/index.ts:54`、`src/index.ts:130`） |
| `gatewayUrl` | `'http://127.0.0.1:5800'`（`src/index.ts:55`）；env `QMT_GATEWAY_URL` 可覆盖（`src/rest.ts:78`） | MiniQMT 本地网关地址 |
| `accountId` | **无默认值**（`Schema.string()` 未给 default，`src/index.ts:56`）；env `QMT_ACCOUNT_ID` 兜底（`src/rest.ts:79`） | 资金账号；缺失时资金 / 持仓 / 下单 / 撤单均抛 `TRADING_AUTH_FAILED` |

## 接线

- **数据面行**：`packages/cn/cordis.patch.yml:39-42` → 行 id `dsh-trading-cn-dataplane-qmt`
  （name `@dshtrading/connector-qmt/dataplane`，行 config 只写 `enabled: true`）。
  注册 `(cn, qmt)` 进 `tradingMarketDataRegistry`（`src/dataplane.ts:49`），
  若同市场存在 `tradingTradeRegistry` 再注册交易服务（`src/dataplane.ts:55`）。
- **preset 行**：`packages/cn/assets/preset/cn-trader/agent.cordis.yml:69-74` → 行 id
  `dsh-trading-cn-connector-qmt`（`config: {enabled: true, dryRun: true, liveTrading: false}`）。
- **bundle 依赖**：`packages/cn/package.json:34` 的 `"@dshtrading/connector-qmt": "workspace:*"`。
- **provider 词汇**：`packages/router/src/index.ts:78`；与 `src/index.ts:218` 的 `ROUTER_PROVIDER = 'qmt'` 同名。
- **服务键**：`tradingCnMarketData`（`src/index.ts:59`）与 `tradingCnTrade`（`src/index.ts:60`）；
  dataplane 侧各自 `ctx.isolate(服务键)` 后注册（`src/dataplane.ts:47`、`src/dataplane.ts:53`）。
- **必须导出 `Config`**：`src/dataplane.ts:18` 就地重导出主行同一份 schema。loader 只认**被加载模块**导出的
  Config；缺它则行 config 的默认值全丢，`env` 缺失会在 `OrderIntentLedger` 构造时抛 TypeError，
  导致整行 apply 失败、行情与交易两个服务一起不注册（同引上面的 bug-fix Note）。
- **设置页显示名**：`packages/client-ui-settings/src/client/locales.ts:253`（zh `MiniQMT (迅投券商实盘)`）与
  `:399`（en `MiniQMT (broker gateway)`）；凭证字段
  `packages/client-ui-settings/src/client/trading-settings-controller.ts:43`（`markets: ['cn']`、env `QMT_GATEWAY_URL`）。

## 上游端点

| 用途 | 端点 | 源码 |
|---|---|---|
| 报价 | `GET {gatewayUrl}/api/v1/market/ticker?symbol=<code>`（网关需返回 `code: 0` 且带 `data`） | `src/rest.ts:110-118` |
| K 线 | `GET {gatewayUrl}/api/v1/market/klines?symbol=<code>&period=<interval>&limit=<limit>` | `src/rest.ts:155` |
| 资金 | `GET {gatewayUrl}/api/v1/trade/asset?account_id=<acc>` | `src/rest.ts:192` |
| 持仓 | `GET {gatewayUrl}/api/v1/trade/positions?account_id=<acc>` | `src/rest.ts:220` |
| 下单 | `POST {gatewayUrl}/api/v1/trade/order`，体 `account_id` / `stock_code` / `order_type` / `order_side` / `price` / `order_volume` | `src/rest.ts:244-253` |
| 撤单 | `POST {gatewayUrl}/api/v1/trade/cancel`，体 `account_id` / `order_id` | `src/rest.ts:282-287` |
| 行情回退（网关请求抛错时） | `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=<1 或 0>.<code>&fields=f1,f2,f5,f124`（按行 `f1` 取价）与 `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=<secid>&klt=101&fqt=1`（日线） | `src/rest.ts:126`、`src/rest.ts:162` |

该网关契约不在本仓、也不是官方契约（类头注 `src/index.ts:97-104` 明示），请求体字段按
「不猜字段」纪律只写实现已用到的键。

## 周期与契约

- **周期词汇**：`INTERVAL_VOCABULARY = ['1m','5m','15m','30m','1h','1d','1w','1M']`（`src/rest.ts:28`），
  同一数组进 `cn_get_klines` 的 `interval` 枚举（`src/index.ts:255`）。
- **网关路径把 `interval` 原样当 `period` 传**（`src/rest.ts:155`），映射在网关侧；
  **东财回退路径恒 `klt=101`（日线）**（`src/rest.ts:162`），网关不可用时任何周期都只能拿到日线。
- **符号形态**（`toQmtCode`，`src/rest.ts:30-37`）：含 `.` 原样；裸码 `6`/`5`→`.SH`，`0`/`3`→`.SZ`，
  `8`/`4`→`.BJ`，其余→`.SH`。
- **错误映射**：非 2xx → `TRADING_UPSTREAM_ERROR`、不可达或响应非 JSON → `TRADING_NETWORK`
  （`src/rest.ts:83-101`）；网关 `code !== 0` → `TRADING_EXCHANGE_ERROR`
  （资金 `src/rest.ts:195`、持仓 `:223`、下单 `:257`、撤单 `:291`）；
  缺 `accountId` → `TRADING_AUTH_FAILED`（`src/rest.ts:186,208,237,276`）。
- **服务缝三态闸门**（`src/index.ts:126-181`）：
  ① `dryRun=false` 且实盘未授权 → 结构化拒绝 `TRADING_LIVE_TRADING_DISABLED`，且不触网；
  ② `dryRun` 缺省或 `config.dryRun` → 本地模拟回执（`dry-<时间戳>-<随机>`，`dryRun: true`）；
  ③ 放行 → 先写 `OrderIntentLedger`（`provider: 'qmt'`，维度 env + account），
  同 intentId 命中 `replay` 时直接回放已记回执、不二次下单；新意图触网后 `confirm` 落盘（`src/index.ts:152-168`）。
  撤单与真实下单同门槛（`src/index.ts:171-181`），防经撤单接口绕过下单闸门。

## 能力面

| 服务方法 | 本包实现 | 工具暴露 |
|---|---|---|
| `QmtMarketDataService.getTicker`（网关优先，请求抛错回退东财） | 有（`src/index.ts:74`） | `cn_get_ticker`（`src/index.ts:241`） |
| `QmtMarketDataService.getKlines`（同上） | 有（`src/index.ts:78`） | `cn_get_klines`（`src/index.ts:251`） |
| `QmtMarketDataService.subscribeTicker`（轮询，最小 1000 ms、默认 5000 ms） | 有（`src/index.ts:82-90`） | 缺席 |
| `QmtTradeService.placeOrder`（三态闸门 + 意图台账 + 网关 POST） | 有（`src/index.ts:126-169`） | `cn_place_order`（`src/index.ts:266`） |
| `QmtTradeService.cancelOrder`（同门槛） | 有（`src/index.ts:171-181`） | `cn_cancel_order`（`src/index.ts:326`） |
| `QmtTradeService.getBalance` | 有（网关资金；缺 `accountId` 抛错，`src/index.ts:122`） | `cn_get_balance`（`src/index.ts:337`） |
| `QmtTradeService.getPositions` | 有（网关持仓，`src/index.ts:183`） | 缺席 |
| `QmtTradeService.getBalances` | 有（包一层，异常吞成 `[]`，`src/index.ts:187-194`） | 缺席 |
| `QmtTradeService.listOpenOrders` / `listTradeFills` | 恒返回 `[]`（`src/index.ts:196-202`） | 缺席 |
| `QmtTradeService.getOrder` | 返回合成对象（`quantity: 0`、`status: 'new'`、`dryRun: false`），非网关查询（`src/index.ts:204-215`） | 缺席 |
| `listInstruments` / 盘口 / 基本面 | 未实现 | 未实现 |

## 已知边界

- **网关契约未经真实联调**：路径与请求体来自 2026-08-31 的实现记录
  （[.agents/notes/implemented/feature/2026-08-31-real-trading-suite-and-cn-fix.md](../../.agents/notes/implemented/feature/2026-08-31-real-trading-suite-and-cn-fix.md) §1.2），
  本仓无网关真实响应证据；`accountId` 未配则资金 / 持仓 / 下单 / 撤单全部 fail-closed。
- **回退只吃异常，不吃业务码**：网关 HTTP 200 但 `code !== 0` 时 `getTicker` 不回退东财，
  而是返回零价快照（`src/rest.ts:146`）；只有 `requestJson` 抛错才进回退分支（`src/rest.ts:119`）。
- **回退分支的错误不是结构化错误码**：`src/rest.ts:125-143` 不校验 `res.ok`，
  响应解析失败会以原始 `SyntaxError` / 网络错误外抛，不经 `TradingServiceError`。
- **下单请求不带 venue 幂等字段**：类头注（`src/index.ts:97-104`）说明 QMT 官方 `order_stock` 有
  `order_remark`，但本包打的是本地网关、其契约未承诺该键，按「不猜字段」纪律不写入请求体；
  幂等完全由本地 `OrderIntentLedger`（`@dshtrading/authority`）保证。
- **账户读面工具缺失**：`getPositions` / `listOpenOrders` / `listTradeFills` / `getOrder` 服务有实现
  但无工具暴露，其中 `getOrder` 与两个 `list*` 尚无真实数据源。同类缺口登记在
  [.agents/notes/implemented/architecture/2026-09-08-agent-native-plugin-interface-audit.md](../../.agents/notes/implemented/architecture/2026-09-08-agent-native-plugin-interface-audit.md)。
- 无 `listInstruments`、盘口、基本面能力。

## 合规记录

MiniQMT 是券商侧授权软件（需在券商开通迅投 QMT 权限），本地网关跑在用户机器上；
本包不内置凭证、不落日志，资金账号只经 `accountId` 配置或 `QMT_ACCOUNT_ID` 环境变量进入（铁律 #3/#5）。
实盘放行的唯一权威是 `@dshtrading/authority` 的人工签署平面，`liveTrading` 只是非权威镜像；
下单默认 `dryRun: true`，闸门三态在服务缝与工具层双保险，不经统一审批闸门触达不到真实下单。

## 出网验证

本包暂无已提交的独立出网验证脚本（网关面）。可复跑的入口：

```sh
# 装配面：走真实 loader 激活路径，判定 cn/qmt 行是否 activated，并打印行情/交易注册表内容（不触网）
node spikes/impl-qmt-alpaca-dataplane-activation/run-loader-activation-probe.mjs

# 网关面最小复跑（需本机 MiniQMT 网关在 5800；网关请求抛错时会回退东财）
./node_modules/.bin/tsx -e "import('./packages/connector-qmt/src/rest.ts').then(async m => console.log(JSON.stringify(await new m.QmtRestClient({ accountId: process.env.QMT_ACCOUNT_ID }).getTicker('600519.SH'))))"
```

不触网的离线矩阵：服务缝三态 `packages/connector-qmt/test/trade-gate.test.ts`、
意图幂等 `packages/connector-qmt/test/order-intent.test.ts`（假 venue 见 `packages/connector-qmt/test/fake-qmt-venue.ts`）、
数据面装配 `packages/connector-qmt/test/dataplane.test.ts`。
