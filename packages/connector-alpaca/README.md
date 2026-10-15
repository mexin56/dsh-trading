# @dshtrading/connector-alpaca

美股（us）**行情 + 交易双面**连接器：直连 Alpaca Market Data v2（IEX feed）与 Alpaca Trading API v2，
实现 `@dshtrading/api` 的 `MarketDataService` / `TradeService` 两个契约，注册服务键
`tradingUsMarketData` / `tradingUsTrade`，注册 3 个 `us_*` 工具，并同时接入 base 的行情注册表
（`tradingMarketDataRegistry`）与交易注册表（`tradingTradeRegistry`）。被 us bundle 以
`workspace:*` 依赖（`packages/us/package.json`）。

## 状态

**未实证**：本包没有已提交的「真实 API key → 真机请求」原始响应；上游端点、字段映射与错误码全部取自
源码（下文逐条给出行号），**未经真机核对**。已提交的相关证据都在离线面：

- `spikes/impl-qmt-alpaca-dataplane-activation/run-loader-activation-probe.mjs`（2026-10-14）：走真实 loader
  激活路径（`plugin(模块, 行 config)` → `apply`），证明数据面行能同时注册行情与交易服务；**不触网**。
- `spikes/impl-orderbook-ticks/EVIDENCE.md`（2026-09-02，第 32 行）：该轮 us 盘口/逐笔未接，理由是本连接器需凭证。
- `spikes/impl-service-seam-gate/NET-VERIFY.md`（2026-09-01，第 36 行）：明确记录未对券商网关做真实下单验证。
- `.agents/notes/implemented/feature/2026-08-31-alpaca-us-and-futu-hk-connectors.md`：接入当日的离线测试记录。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关；`apply()` 首行判定，false 直接退出（`src/index.ts:451`） |
| `env` | `'demo'` | `demo` = Paper，`live` = 实盘；同时决定走哪一组凭证 ref（`src/index.ts:103`） |
| `dryRun` | `true` | 强制模拟：为 true 时即使请求 `dryRun:false` 也只回本地模拟回执（`src/index.ts:256`） |
| `liveTrading` | `false` | 实盘请求的**非权威镜像**；真实放行需 `@dshtrading/authority` 平面的人工签署授权（`liveTradingEnabled()`，`src/index.ts:249`） |
| `apiKeyRef` | `'ALPACA_API_KEY'` | live 环境 API key 的凭证 ref（只存 ref） |
| `secretRef` | `'ALPACA_SECRET_KEY'` | live 环境 secret 的凭证 ref |
| `demoApiKeyRef` | `'ALPACA_PAPER_API_KEY'` | demo（Paper）环境 API key 的凭证 ref |
| `demoSecretRef` | `'ALPACA_PAPER_SECRET_KEY'` | demo（Paper）环境 secret 的凭证 ref |

字段名与默认值见 `src/index.ts:56-65`。凭证面语义：

- **先按 env 选组，再三级解析**：`demo` 用 `demoApiKeyRef`/`demoSecretRef`，否则用 `apiKeyRef`/`secretRef`
  （`src/index.ts:103-107`）；解析顺序是 `tradingMarketRouter` 的 `alpaca` 凭据 → `credentials` 服务的
  `resolve(ref)` → `process.env[ref]`（`src/index.ts:119-148`）。
- **ref 必须是指标识符**：不匹配 `^[A-Za-z_][A-Za-z0-9_]*$` 直接抛 `TRADING_CREDENTIALS_MISSING`
  （`src/index.ts:92,126-131`）；两者都拿不到时返回 undefined，apply 里的 `requireCreds` 抛
  `TRADING_CREDENTIALS_MISSING`（`src/index.ts:456-465`），不降级到匿名请求。
- **凭证只进 ref、不落日志**：值只在请求头 `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` 内出现
  （`src/rest.ts:102-111`），源码不含任何打印凭证的语句。
- **交易安全三件套**：下单默认 dry-run（工具参数 `dryRun` 默认 `true`，`src/index.ts:389`；服务内
  `order.dryRun ?? true`，`src/index.ts:365`）；`liveTrading` 必须显式开启且只是镜像，权威是签署平面
  （`src/index.ts:364-377` 的 `evaluateOrderGate` 三态：`reject` / `simulate` / `live`）；工具名
  `us_place_order` 命中 base 统一审批闸门 `LIVE_ACTION_GATE_PATTERN`（该正则同时覆盖
  `us_cancel_order`，`packages/base/src/index.ts:63`），无人在场时 ask 降级为 deny
  （`packages/base/src/index.ts:20-24`）。

## 接线

- **数据面行**：`packages/us/cordis.patch.yml:26-29` → 行 id `dsh-trading-us-dataplane-alpaca`，
  `name: '@dshtrading/connector-alpaca/dataplane'`，行 config 只写 `enabled: true`。
  `src/dataplane.ts` 重导出 `Config`（第 34 行）让 loader 补全 schema 默认值，并在
  `tradingUsMarketData` / `tradingUsTrade` 两个 isolate realm 内构造服务（第 68、77 行），
  分别 `register('us', 'alpaca', …)` 进 `tradingMarketDataRegistry`（第 73 行）与
  `tradingTradeRegistry`（第 88 行）。无注册表的老部署回退直接构造行情服务（第 64-67 行），
  无交易注册表时跳过交易面（第 75-76 行）。
- **preset 行**：`packages/us/assets/preset/us-trader/agent.cordis.yml:47-59` → 组 id
  `dsh-trading-us-connector-alpaca-group`，`isolate: {tradingUsMarketData, tradingUsTrade}`，
  行 id `dsh-trading-us-connector-alpaca`，行 config `enabled: true` / `env: demo` / `dryRun: true` /
  `liveTrading: false`。
- **provider 词汇**：`packages/router/src/index.ts:69`（`PROVIDER_VOCABULARY` 的 `'alpaca'`）。
- **设置页显示名**：`PROVIDER_LABELS` 的 `alpaca` 条目
  （`packages/client-ui-settings/src/client/trading-settings-controller.ts:48`：`type: 'commercial'`、
  `env: 'ALPACA_API_KEY'`、`markets: ['us']`）与 `packages/client-ui-settings/src/client/locales.ts`
  的 `'provider.alpaca'` 条目（zh / en 都是 `Alpaca`）。凭据卡片字段 `apiKey` / `secretKey`
  （`trading-settings-controller.ts:147-148`）由本包的 `resolveCredentials` 消费。
- **bundle 依赖**：`packages/us/package.json` 的 `@dshtrading/connector-alpaca: workspace:*`。
- **profile overrides**：`node scripts/sync-profile-overrides.mjs --all --dsh-home ~/.dsh-trading`
  （注意 `--dsh-home`：Web 会话继承的 `DSH_HOME` 指向 ~/.dsh 会找错 profile 集）。
- **激活条件**：`routeAllows()` 要求 `enabled` 且 `tradingMarketRouter.activeProvider('us') === 'alpaca'`
  （`src/index.ts:443-448`）。

## 上游端点

鉴权头 `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`（`src/rest.ts:102-111`）。数据面 host 固定
`https://data.alpaca.markets/v2`（`src/rest.ts:93`）；交易面 host 由 `env` 决定（`src/rest.ts:94-97`）：
`demo` → `https://paper-api.alpaca.markets/v2`，`live` → `https://api.alpaca.markets/v2`。

| 用途 | 端点 | 源码 |
|---|---|---|
| 最新成交 | `GET {data}/stocks/{sym}/trades/latest?feed=iex` | `src/rest.ts:161` |
| 最新报价（买一/卖一） | `GET {data}/stocks/{sym}/quotes/latest?feed=iex` | `src/rest.ts:162,246` |
| K 线 | `GET {data}/stocks/bars?symbols={sym}&timeframe={tf}&limit={n}&feed=iex&adjustment=split` | `src/rest.ts:209` |
| 标的名册 | `GET {trading}/assets?status=active&asset_class=us_equity` | `src/rest.ts:230` |
| 账户余额 | `GET {trading}/account` | `src/rest.ts:265` |
| 持仓 | `GET {trading}/positions` | `src/rest.ts:276` |
| 挂单 | `GET {trading}/orders?status=open[&symbols={sym}]` | `src/rest.ts:294` |
| 成交流水 | `GET {trading}/account/activities/FILL?page_size={n}` | `src/rest.ts:315` |
| 下单 | `POST {trading}/orders`（`time_in_force: gtc`，可带 `client_order_id`） | `src/rest.ts:348-365` |
| 撤单 | `DELETE {trading}/orders/{id}` | `src/rest.ts:392` |
| 单笔订单 | `GET {trading}/orders/{id}` | `src/rest.ts:402` |

## 周期与契约

- **周期词汇 9 个**：`1m/5m/15m/30m/1h/4h/1d/1w/1M` → Alpaca `timeframe` `1Min/5Min/15Min/30Min/1Hour/
  4Hour/1Day/1Week/1Month`（`src/rest.ts:52-62`，词汇表 `src/rest.ts:76`）。未支持的周期抛
  `TRADING_UNSUPPORTED_INTERVAL`（`src/rest.ts:205-207`），不静默降级。
- **K 线参数**：`limit` 夹取到 `[1, 1000]`、缺省 100（`src/rest.ts:208`，工具默认同为 100，
  `src/index.ts:492`）；固定 `feed=iex` 与 `adjustment=split`（`src/rest.ts:209`）；
  `closeTime = openTime + 周期毫秒 − 1`，其中 `1M` 按 30 天近似（`src/rest.ts:64-74,213-224`）。
- **符号形态**：`normalizeUsSymbol` 先 trim + 大写，再要求匹配 `^[A-Z]{1,10}(\.[A-Z]{1,4})?$`，
  否则抛 `TRADING_UNSUPPORTED_SYMBOL`（`src/rest.ts:78-84`）。
- **取价语义**：`getTicker` 并发请求 trades 与 quotes（`Promise.allSettled`），两者都失败才抛错；无成交时
  `price = (bid + ask) / 2` 派生（`src/rest.ts:160-199`）。
- **错误映射**（`src/rest.ts:132-152`）：401/403 → `TRADING_AUTH_FAILED`；429 → `TRADING_RATE_LIMITED`；
  404 → `TRADING_UNSUPPORTED_SYMBOL`；422 且消息含 `insufficient|buying power|balance` →
  `TRADING_INSUFFICIENT_BALANCE`，否则 `TRADING_EXCHANGE_ERROR`；其余非 2xx → `TRADING_EXCHANGE_ERROR`；
  请求本身抛错 → `TRADING_NETWORK`。单次请求超时 10 s（`src/rest.ts:99,121-122`）。
- **回执不许造 id**：下单响应没有真实非空 `id` 即抛 `TRADING_EXCHANGE_ERROR`（`src/rest.ts:369-375`）；
  撤单仅 404 幂等视作成功，401/429/网络/5xx 原样上抛（`src/rest.ts:390-399`）。
- **实盘幂等**：意图台账先落盘再触网（`src/index.ts:277-296`），账户定位固定占位 `'default'`
  （`src/index.ts:86`），`client_order_id` 由 intentId 确定性派生、前缀 `dsht`、上限 48
  （`src/index.ts:78,284`）。
- **服务类字段用 TS 编译期 `private`**（禁 ECMAScript `#`，cordis realm 代理会炸）。

## 能力面

| 面 | 服务方法 | 状态 |
|---|---|---|
| 行情 | `getTicker` | 有（trades + quotes 聚合） |
| 行情 | `getKlines` | 有（9 个周期词汇） |
| 行情 | `subscribeTicker` | 有（快照轮询，缺省 5000 ms、下限 500 ms，`src/index.ts:196-204`） |
| 行情 | `listInstruments` | 有（走交易面 `/assets`，需凭证） |
| 行情 | `getOrderbook` | 有（仅一档：买一/卖一，`src/rest.ts:244-262`） |
| 行情 | `getTickers`（批量） | 缺席 |
| 行情 | `getFundamentals` / 衍生品指标 | 缺席 |
| 交易 | `placeOrder` | 有（三态闸门 + 意图台账） |
| 交易 | `cancelOrder` | 有（与下单同门槛：需 `liveTrading` 且 `dryRun=false`，`src/index.ts:300-305`） |
| 交易 | `getOrder` / `getPositions` / `listOpenOrders` / `listTradeFills` | 有 |
| 交易 | `getBalance` / `getBalances` | 有（`getBalances` 是单元素数组包装，`src/index.ts:241-245`） |
| 交易 | `setLeverage` | 缺席 |

注册的工具（`src/index.ts` 的 `register` 调用，同名已存在则跳过，第 472-474 行）：

| 工具 | 注册位置 | 说明 |
|---|---|---|
| `us_get_ticker` | `src/index.ts:476-484` | 最新价与买卖一档 |
| `us_get_klines` | `src/index.ts:486-499` | interval 用 9 词汇枚举，缺省 `1d`；limit 缺省 100 |
| `us_place_order` | `src/index.ts:379-439`（第 501 行注册） | 先过 `evaluateOrderGate`；模拟回执带行情参照价 `referencePrice` |

## 已知边界

- **未实证项**：全部上游端点、IEX feed 的实际覆盖、真机错误码分布均未在本出口验证过；接入前的
  `spikes/impl-service-seam-gate/NET-VERIFY.md:36` 也记录了未对券商网关做真实下单验证。
- **`feed=iex` 是单所行情**：行情请求固定 `feed=iex`（`src/rest.ts:161-162,209`），非 SIP 全市场
  consolidated feed；覆盖差异未测。
- **工具描述比词汇窄**：`us_get_klines` 的 description 只列 `5m/15m/30m/1h/1d/1w/1M`，而 enum 词汇
  含 `1m` 与 `4h`（`src/index.ts:488-491` vs `src/rest.ts:76`）；两者不一致，实际按 enum 放行。
- **盘口只有一档**：`getOrderbook` 用 `quotes/latest` 的 `bp`/`ap` 各造一行，数量字段缺省填 100
  （`src/rest.ts:248-255`），不是多档深度（`spikes/impl-orderbook-ticks/EVIDENCE.md:32` 记的
  「us 盘口未实现」指该轮桥面未接，与连接器自身的单档实现不冲突）。
- **读面静默吞错**：`getPositions` / `listOpenOrders` / `listTradeFills` 捕获所有异常返回 `[]`
  （`src/index.ts:315-340`）——凭证缺失或网络故障会被读成「无持仓/无挂单/无成交」。
- **撤单没有工具入口**：`AlpacaTradeService.cancelOrder` 存在，但本包不注册 `us_cancel_order`
  （工具只有 3 个）；撤单只能经服务面且需实盘授权。
- **名册未暴露为工具**：`listInstruments` 只在服务面，工具面没有对应入口。
- **老部署回退**：无 `tradingMarketDataRegistry` 时直接构造服务（`src/dataplane.ts:64-67`），
  此时 settings 切换交易所需重启才生效（数据面注释，第 6-10 行）。
- **`1M` 的 closeTime 按 30 天近似**（`src/rest.ts:73`），不是自然月长度。

## 合规记录

**Alpaca 是商业券商官方 API，需用户自备 key（BYOK）**：行情走 Market Data v2 的 IEX feed，交易走
Trading API v2 的 Paper/Live host；凭证只以 ref 形式进配置，值不落日志、不内置默认值。本仓不缓存、
不再分发任何行情或账户数据；使用边界以 Alpaca 服务条款（<https://alpaca.markets>，设置页同址登记）
为准。合规要求见 README 铁律 #5。

## 出网验证

本包暂无已提交的独立出网验证脚本。可复跑的入口（都不触网）：

```sh
pnpm --filter @dshtrading/connector-alpaca test     # 离线契约测试（fake venue，无真实网络）
node spikes/impl-qmt-alpaca-dataplane-activation/run-loader-activation-probe.mjs   # loader 激活路径（需已构建 lib/）
```

真机出网需自备 `ALPACA_API_KEY` / `ALPACA_SECRET_KEY`（或 Paper 组）并自写探针：本仓未提交任何
携带真实凭证的请求记录，也没有已提交的真实原始响应可供引用。
