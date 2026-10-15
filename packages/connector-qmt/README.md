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
  现实现经本地网关真实 HTTP（`src/rest.ts:242-354`），此处仅作历史记录引用，不代表当前行为。
- [spikes/impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md)（2026-09-01）
  在「范围与未验证项」中明确：qmt 等券商网关**未做真实下单验证**，服务缝三态只由离线矩阵
  `test/trade-gate.test.ts` 覆盖。
- 2026-10-14 本出口对 `push2.eastmoney.com` 不可达（`curl: (52) Empty reply from server`），
  故网关离线时的东财回退路径本轮同样无法实证——回退取价口径与错误映射目前只有离线用例
  （`test/template.test.ts` 的回退用例组，fixture 是同日真实响应行）。

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
- **设置页显示名与地址提示**：`PROVIDER_LABELS` 的 `qmt` 条目
  （`packages/client-ui-settings/src/client/trading-settings-controller.ts:64`：`markets: ['cn']`、
  `configField: 'gatewayUrl'`）与 `packages/client-ui-settings/src/client/locales.ts` 的
  `'provider.qmt'` 条目（zh `MiniQMT (迅投券商实盘)` / en `MiniQMT (broker gateway)`）。
  **凭据卡片已撤**（2026-10-15）：面板原先收集 `gatewayUrl` 写进 `dshtrading.credentials.qmt`，
  而本包只读 `Config.gatewayUrl`（rest 层的 `QMT_GATEWAY_URL` 回落被 schema 默认值遮蔽），
  提示因此改走 `configField` 槽；见[设置页凭据面收窄](../../.agents/notes/implemented/simplification/2026-10-15-settings-credential-surface-narrowed.md)。

## 上游端点

| 用途 | 端点 | 源码 |
|---|---|---|
| 报价 | `GET {gatewayUrl}/api/v1/market/ticker?symbol=<code>`（网关需返回 `code: 0` 且带 `data`） | `src/rest.ts:114-126` |
| K 线 | `GET {gatewayUrl}/api/v1/market/klines?symbol=<code>&period=<interval>&limit=<limit>` | `src/rest.ts:214` |
| 资金 | `GET {gatewayUrl}/api/v1/trade/asset?account_id=<acc>` | `src/rest.ts:251` |
| 持仓 | `GET {gatewayUrl}/api/v1/trade/positions?account_id=<acc>` | `src/rest.ts:279` |
| 下单 | `POST {gatewayUrl}/api/v1/trade/order`，体 `account_id` / `stock_code` / `order_type` / `order_side` / `price` / `order_volume` | `src/rest.ts:303-312` |
| 撤单 | `POST {gatewayUrl}/api/v1/trade/cancel`，体 `account_id` / `order_id` | `src/rest.ts:341-346` |
| 行情回退（网关不可用时：连不上 / 非 2xx / 非 JSON / 业务码非 0 / 缺 `data`） | `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=<1 或 0>.<code>&fields=f1,f2,f5,f124`（按行 `f1` 取价）与 `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=<secid>&klt=101&fqt=1`（日线） | `src/rest.ts:156`、`src/rest.ts:221` |

该网关契约不在本仓、也不是官方契约（类头注 `src/index.ts:97-104` 明示），请求体字段按
「不猜字段」纪律只写实现已用到的键。

## 周期与契约

- **周期词汇**：`INTERVAL_VOCABULARY = ['1m','5m','15m','30m','1h','1d','1w','1M']`（`src/rest.ts:28`），
  同一数组进 `cn_get_klines` 的 `interval` 枚举（`src/index.ts:255`）。
- **网关路径把 `interval` 原样当 `period` 传**（`src/rest.ts:214`），映射在网关侧；
  **东财回退路径恒 `klt=101`（日线）**（`src/rest.ts:221`），网关不可用时任何周期都只能拿到日线。
- **符号形态**（`toQmtCode`，`src/rest.ts:30-37`）：含 `.` 原样；裸码 `6`/`5`→`.SH`，`0`/`3`→`.SZ`，
  `8`/`4`→`.BJ`，其余→`.SH`。
- **错误映射**：网关非 2xx → `TRADING_UPSTREAM_ERROR`、不可达或响应非 JSON → `TRADING_NETWORK`
  （`src/rest.ts:83-101`）；网关 `code !== 0` 或缺 `data` 时**交易面**（资金 / 持仓 / 下单 / 撤单）
  → `TRADING_EXCHANGE_ERROR`（资金 `src/rest.ts:254`、持仓 `:282`、下单 `:316`、撤单 `:350`），
  **报价面不抛该错**——同一形态交给回退（见下）；缺 `accountId` → `TRADING_AUTH_FAILED`
  （`src/rest.ts:245,267,296,335`）。
- **东财回退的映射**（`quoteViaEastmoneyFallback`，`src/rest.ts:151-206`）：非 2xx →
  `TRADING_UPSTREAM_ERROR`、连不上 → `TRADING_NETWORK`、非 JSON 或行里没有可用价格 →
  `TRADING_EXCHANGE_ERROR`；抛出的错 `cause` 一律是触发本次降级的网关失败。
- **服务缝三态闸门**（`src/index.ts:126-181`）：
  ① `dryRun=false` 且实盘未授权 → 结构化拒绝 `TRADING_LIVE_TRADING_DISABLED`，且不触网；
  ② `dryRun` 缺省或 `config.dryRun` → 本地模拟回执（`dry-<时间戳>-<随机>`，`dryRun: true`）；
  ③ 放行 → 先写 `OrderIntentLedger`（`provider: 'qmt'`，维度 env + account），
  同 intentId 命中 `replay` 时直接回放已记回执、不二次下单；新意图触网后 `confirm` 落盘（`src/index.ts:152-168`）。
  撤单与真实下单同门槛（`src/index.ts:171-181`），防经撤单接口绕过下单闸门。

## 能力面

| 服务方法 | 本包实现 | 工具暴露 |
|---|---|---|
| `QmtMarketDataService.getTicker`（网关优先，网关不可用即回退东财） | 有（`src/index.ts:74`） | `cn_get_ticker`（`src/index.ts:241`） |
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
- **报价降级只有一条路径**：`getTicker`（`src/rest.ts:110-136`）把网关传输层失败（连不上 / 非 2xx /
  非 JSON）与网关明确回「业务码非 0 或缺 `data`」交给同一条东财回退（`src/rest.ts:151-206`）——上游
  业务错误码与 HTTP 4xx/5xx 在本仓同属一类上游失败，不为业务码另立第三种语义。
- **回退不再交零价快照**：拿不到可用报价行（未收录 secid 的 `data:null`、停牌占位 `f2` 缺失或为 0）
  即抛结构化错误（映射见上「错误映射」）。`price: 0` 在消费方读起来是「这只标的不值钱」，不是
  「本次没取到价」；不借用词汇表外的 `TRADING_SYMBOL_NOT_FOUND`——走进回退的唯一原因是主取价路径
  不可用，从 push2 的沉默推不出「该标的不存在」（secid 由 `toQmtCode` 启发式派生）。
- **回退是限流敏感路径**：每次 `getTicker` 最多一个 push2 请求，不重试、不批量。push2 域对突发并发
  极敏感（2026-10-14 实测在飞 4 即被断连、失效面持续 ≥12 分钟，见
  [connector-eastmoney README 的「已知边界」](../connector-eastmoney/README.md)）。
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

# 网关面最小复跑（需本机 MiniQMT 网关在 5800；网关不可用时回退东财）
./node_modules/.bin/tsx -e "import('./packages/connector-qmt/src/rest.ts').then(async m => console.log(JSON.stringify(await new m.QmtRestClient({ accountId: process.env.QMT_ACCOUNT_ID }).getTicker('600519.SH'))))"
```

不触网的离线矩阵：服务缝三态 `packages/connector-qmt/test/trade-gate.test.ts`、
意图幂等 `packages/connector-qmt/test/order-intent.test.ts`（假 venue 见 `packages/connector-qmt/test/fake-qmt-venue.ts`）、
数据面装配 `packages/connector-qmt/test/dataplane.test.ts`。
