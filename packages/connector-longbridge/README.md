# @dshtrading/connector-longbridge

长桥（Longbridge / LongPort）连接器：**港股（hk）行情 + 交易双面**。上游是长桥**券商 OpenAPI**
（官方 HTTP 端点，签名鉴权），实现 `@dshtrading/api` 的 `MarketDataService` / `TradeService`
两个契约，注册服务键 `tradingHkMarketData` / `tradingHkTrade`，注册 5 个 `hk_*` 工具。
被 hk bundle 以 `workspace:*` 依赖（`packages/hk/package.json:33`）。

## 状态

**未实证**：本包没有已提交的真实券商请求记录（无原始响应、无真机错误码分布）。上游路径、
签名规范与字段映射全部取自源码（下文逐条给出行号），**未经真机核对**。已提交的相关材料只有两类：

- `spikes/impl-service-seam-gate/NET-VERIFY.md`（2026-09-01，第 36 行）：明确记录**未**
  对各家券商网关做真实下单验证，该轮唯一真实网络对象是 OKX；本包的服务缝三态由离线
  `test/trade-gate.test.ts` 覆盖，不是出网证据。
- `spikes/verify-connectors-suite/EVIDENCE.md`（2026-08-31，第 37-39 行）：当时的静态评审把
  「longbridge 未注册下单工具但 Note 声称有交易通道」列为发现项。该结论对应 commit `b80000e`；
  当前源码注册了 `hk_place_order` / `hk_cancel_order`（`src/index.ts:250-288`、`310-319`），
  与那时已不一致——但**现状同样没有实证**，本 README 不据此声明可用。

本仓 `spikes/` 下没有 `impl-longbridge*` 目录，也没有任何针对长桥端点的探针脚本。

## 配置

字段名与默认值见 `src/index.ts:51-59`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`src/index.ts:52`） |
| `env` | `'demo'` | 运行环境标签（`src/index.ts:53`）。它**只进订单意图台账的作用域**（`src/index.ts:122-126` 的 `environment: options.config.env`），**不改变请求地址**——见「已知边界」 |
| `dryRun` | `true` | 强制模拟：为 true 时即使请求 `dryRun:false` 也只回本地模拟回执（`src/index.ts:144`） |
| `liveTrading` | `false` | 实盘请求的**非权威镜像**；真实放行需 `@dshtrading/authority` 平面的人工签署授权（`liveTradingEnabled()`，`src/index.ts:137`、`182`） |
| `appKeyRef` | `'LONGBRIDGE_APP_KEY'` | App Key 的**环境变量名**（BYOK，`src/index.ts:56`） |
| `appSecretRef` | `'LONGBRIDGE_APP_SECRET'` | App Secret 的环境变量名，用于 HMAC-SHA256 签名（`src/index.ts:57`、`src/rest.ts:130-140`） |
| `accessTokenRef` | `'LONGBRIDGE_ACCESS_TOKEN'` | Access Token 的环境变量名，进 `authorization` 头（`src/index.ts:58`、`src/rest.ts:123-125`） |

交易安全三件套在本包的落点：

- **dry-run 缺省**：工具参数 `dryRun` 默认 `true`（`src/index.ts:259`），工具执行里
  `args.dryRun !== false` 即走模拟分支（`src/index.ts:268`）；服务内 `order.dryRun ?? true`
  （`src/index.ts:136`）。
- **liveTrading 必须显式开启且非权威**：工具层再查一次（`src/index.ts:290-296`），服务缝
  内第一步也查（`src/index.ts:137-143`）；撤单与下单同门槛（`src/index.ts:182-187`）。
- **base 审批闸门**：`hk_place_order` / `hk_cancel_order` 命中
  `LIVE_ACTION_GATE_PATTERN`（`packages/base/src/index.ts:63`），无人在场时 ask 降级为 deny
  （`packages/base/src/index.ts:20-24`）。
- **凭证只进 ref**：三条 ref 在 `apply` 里经 `process.env[...]` 解析（`src/index.ts:213-215`），
  值只交给 rest 客户端，不落日志、不进台账身份（`src/index.ts:120-121`）。

## 接线

- **数据面行**：`packages/hk/cordis.patch.yml:38-41` → 行 id `dsh-trading-hk-dataplane-longbridge`，
  `name: '@dshtrading/connector-longbridge/dataplane'`，行 config 只写 `enabled: true`。
  `src/dataplane.ts` 重导出 `Config`（第 10 行）让 loader 补全 schema 默认值，在
  `tradingHkMarketData` isolate realm 内构造行情服务（第 37-38 行）并 `register('hk', 'longbridge', …)`
  进 `tradingMarketDataRegistry`（第 39 行）；无注册表的老部署回退直接构造（第 33-36 行）。
  **该文件不解析也不注册 `tradingTradeRegistry`**（全文件无此键）——交易服务只在 preset 面可用。
- **preset 行**：`packages/hk/assets/preset/hk-trader/agent.cordis.yml:65-77` → 组 id
  `dsh-trading-hk-connector-longbridge-group`，`isolate: {tradingHkMarketData, tradingHkTrade}`
  （第 68-70 行），行 id `dsh-trading-hk-connector-longbridge`，
  `name: '@dshtrading/connector-longbridge'`，行 config `enabled: true` / `dryRun: true` /
  `liveTrading: false`（第 74-77 行）。该行的 `apply` 直接构造行情与交易两个服务
  （`src/index.ts:216-217`），不经注册表。
- **provider 词汇**：`packages/router/src/index.ts:80`（`PROVIDER_VOCABULARY` 的 `'longbridge'`）。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:45`
  （`PROVIDER_LABELS`：`type: 'commercial'`、`env: 'LONGBRIDGE_APP_KEY'`、`markets: ['hk','us']`）
  与 `packages/client-ui-settings/src/client/locales.ts:255`（中文 `Longbridge (长桥)`）/
  第 401 行（英文 `Longbridge`）。凭据表单字段为 `appKey` / `appSecret` / `accessToken`
  （`trading-settings-controller.ts:142-146`，后两者 `secret: true`）。
- **bundle 依赖**：`packages/hk/package.json:33` 的 `@dshtrading/connector-longbridge: workspace:*`。
- **激活条件**：`routeAllows()` 要求 `enabled` 且
  `tradingMarketRouter.activeProvider('hk') === 'longbridge'`（`src/index.ts:202-207`）。

## 上游端点

基地址 `process.env.LONGBRIDGE_API_URL || 'https://openapi.longportapp.com'`（`src/rest.ts:104`），
也可由 `LongbridgeRestOptions.baseUrl` 直接覆盖。以下是源码里的全部路径（本包没有公开互联网
以外的第三方回落源）：

| 用途 | 端点 | 源码 |
|---|---|---|
| 实时报价 | `GET /v1/quote/realtime?symbol=00700.HK` | `src/rest.ts:165` |
| K 线 | `GET /v1/quote/candlesticks?symbol=&period=&count=` | `src/rest.ts:201` |
| 账户资产 | `GET /v1/asset/account` | `src/rest.ts:235` |
| 持仓 | `GET /v1/trade/stock/position` | `src/rest.ts:269` |
| 下单 | `POST /v1/trade/order`（`symbol` / `order_type`(MO\|LO) / `side`(Buy\|Sell) / `submitted_quantity` / `submitted_price` / `time_in_force: 'Day'` / `remark?`） | `src/rest.ts:297-309` |
| 撤单 | `DELETE /v1/trade/order?order_id=` | `src/rest.ts:332-334` |

请求头（`src/rest.ts:117-142`）：`Accept` / `Content-Type` 恒发；`authorization: Bearer <token>`
在有 access token 时发；`x-api-key` + `x-timestamp`（`Date.now()`）在有 app key 时发；
`x-api-signature` **只在 appKey、accessToken 与 appSecret 三者齐备**时发（第 129-141 行）。

## 周期与契约

- **周期词汇 8 个**：`1m/5m/15m/30m/1h/1d/1w/1M`（`src/rest.ts:24`），到上游的映射是
  `1m/5m/15m/30m/**60m**/day/week/month`（`src/rest.ts:26-37`）。
- **映射覆盖不完整且无兜底**：`@dshtrading/api` 的 `Interval` 还含 `3m/2h/4h/6h/8h/12h/3d`
  （`packages/api/src/index.ts:25-40`），`toLongbridgePeriod`（`src/rest.ts:26-37`）与
  `parseIntervalMs`（`src/rest.ts:39-50`）的 `switch` **既没有这些 case 也没有 `default`**，
  会返回 `undefined`。工具面的 enum 已收窄到 8 词汇（`src/index.ts:240`），所以经工具不可达；
  服务直调可达，后果是请求里出现 `period=undefined`、`closeTime` 为 `NaN`（**该后果未实证**，
  无测试与网络覆盖）。
- **符号形态**：`toLongbridgeSymbol`（`src/rest.ts:52-63`）——`00700.HK` 与裸 1–5 位数字都补零
  到 5 位并加 `.HK`；其余只 trim + 大写、**无形态白名单**（美股代码原样透传，与 futu 的
  `normalizeUsSymbol` 不同）。
- **签名规范**：`generateLongbridgeSignature` 拼 `METHOD\nPATH\ncanonicalHeaders\nsignedHeaders\nbodyHash`
  后 HMAC-SHA256（`src/rest.ts:65-86`），`signedHeaders` 恒为
  `authorization;x-api-key;x-timestamp`（第 78 行），body 的 SHA-256 进规范串（第 80 行）。
- **错误映射**：HTTP 非 2xx → `TRADING_UPSTREAM_ERROR`（`src/rest.ts:147`）；请求抛错 →
  `TRADING_NETWORK`（第 152-156 行）；行情 `code !== 0` 或空数组 → `TRADING_SYMBOL_NOT_FOUND`
  （第 168 行）；K 线 `code !== 0` 或没有 `candlesticks` → **返回空数组（静默降级，第 203-205 行）**；
  资产/持仓/下单/撤单 `code !== 0` → `TRADING_EXCHANGE_ERROR`（第 238、312、337 行）；
  缺 appKey 或 accessToken（资产与交易面）→ `TRADING_AUTH_FAILED`（第 223、254、290、330 行）。
- **无本地超时**：`requestJson` 不设 `AbortController`/超时（`src/rest.ts:111-158`），
  上游无响应时请求没有连接器侧上限（与 futu 的 10 s 不同）。
- **服务类字段用 TS 编译期 `private`**（禁 ECMAScript `#`，cordis realm 代理会炸）。

## 能力面

行情面服务方法（`src/index.ts:73-102`）：

| 服务方法 | 状态 |
|---|---|
| `getTicker` | 有（`src/index.ts:85-87`） |
| `getKlines` | 有（`src/index.ts:89-91`） |
| `subscribeTicker` | 有（快照轮询，缺省 5000 ms、下限 1000 ms，`src/index.ts:93-101`） |
| `listInstruments` / `getTickers` / `getOrderbook` / `getFundamentals` / `getDerivatives` / `getRecentTrades` | 缺席 |

交易面服务方法（`src/index.ts:104-198`）：

| 服务方法 | 状态 | 有对应工具 |
|---|---|---|
| `placeOrder` | 有（三态闸门 + 意图台账，`src/index.ts:133-177`） | `hk_place_order` |
| `cancelOrder` | 有（与下单同门槛，`src/index.ts:179-189`） | `hk_cancel_order` |
| `getBalance` | 有（`src/index.ts:129-131`） | `hk_get_balance` |
| `getPositions` | 有（`src/index.ts:191-193`） | **无工具** |
| `getOrders` | 恒返回 `[]`（`src/index.ts:195-197`） | 无 |
| `getOrder` | **未实现**：类里没有这个方法，而它是 `TradeService` 的**必选**成员（`packages/api/src/index.ts:839`） | 无 |
| `getBalances` / `listOpenOrders` / `listTradeFills` / `setLeverage` | 缺席 | 无 |

注册的工具 5 个（`src/index.ts:219-331`，同名已存在则跳过，第 221-223 行）：

| 工具 | 注册位置 | 说明 |
|---|---|---|
| `hk_get_ticker` | `src/index.ts:225-233` | 最新价与成交量 |
| `hk_get_klines` | `src/index.ts:235-248` | interval 用 8 词汇枚举，缺省 `1d`；limit 缺省 100 |
| `hk_place_order` | `src/index.ts:250-308` | `dryRun !== false` 时回本地模拟回执（带参照价，`sim-lb-` 前缀）；否则要求 `liveTrading` |
| `hk_cancel_order` | `src/index.ts:310-319` | 参数名 `ordId`；实盘动作，同样需 `liveTrading` 且 `dryRun=false` |
| `hk_get_balance` | `src/index.ts:321-330` | 账户余额（返回形状与 `AccountBalance` 契约不一致，见「已知边界」） |

## 已知边界

- **未实证项**：全部端点、签名是否被上游接受、真机错误码分布、`code` 字段的实际取值约定，
  均未经真机核对。`spikes/impl-service-seam-gate/NET-VERIFY.md:36` 明确记录未对券商网关做真实下单验证。
- **`env` 不改变地址**：`env: 'demo'` 只进意图台账作用域（`src/index.ts:122-126`），
  基地址恒为 `openapi.longportapp.com`（`src/rest.ts:104`）。即实盘放行后，
  `env` 仍为 `demo` 的部署也会把订单发往**生产**端点。
- **`getOrder` 未实现**：`TradeService` 要求它（`packages/api/src/index.ts:839`），
  `LongbridgeTradeService` 没有该方法（`src/index.ts:104-198` 全文无 `getOrder`）。消费方
  按契约调用会得到 `undefined is not a function` 形态的失败——**该运行期后果未实证**。
- **`getBalance` / `getPositions` 返回形状与契约不符**：`getBalance` 返回
  `{currency, available, total}`（`src/rest.ts:245-249`），而 `AccountBalance` 是
  `{asset, free, locked}`（`packages/api/src/index.ts:578-582`）；`getPositions` 每行返回
  `{symbol, quantity, entryPrice, unrealizedPnl}`（`src/rest.ts:276-281`），而 `Position` 要求
  `{symbol, side, size, entryPrice, timestamp}`（`packages/api/src/index.ts:499-520`）。
  消费方按契约字段读会读到 `undefined`（**运行期表现未实证**）。
- **行情面无凭证也发请求**：`getTicker` / `getKlines` 不做凭证前置检查（`src/rest.ts:160-219`），
  三凭证缺失时请求照发（只是不带 `authorization` / `x-api-key` / `x-api-signature` 头）。
  只有资产与交易面在缺凭证时抛 `TRADING_AUTH_FAILED`（`src/rest.ts:222-224`、`253-255`、`289-291`、`329-331`）。
- **K 线失败静默转空数组**：`code !== 0` 与「确实无数据」在 `getKlines` 里不可区分（`src/rest.ts:203-205`）。
- **无本地超时**（`src/rest.ts:111-158`）。
- **未登记周期无显式拒绝**：服务直调传 `4h` 等未映射周期不会抛 `TRADING_UNSUPPORTED_INTERVAL`，
  而是带 `undefined` 出站（`src/rest.ts:26-37`；工具面已由 enum 收窄，见「周期与契约」）。
- **`getOrders` 恒空**（`src/index.ts:195-197`）：空数组在消费方读作「无挂单」，而不是「本包不支持」。
- **持仓面有服务、无工具**：`getPositions` 只经 `tradingHkTrade` 服务可达（`src/index.ts:191-193`），
  工具面没有对应的 `hk_get_positions`。
- **交易面不进交易注册表**：`src/dataplane.ts` 全文件没有 `tradingTradeRegistry`，注册表里没有
  `(hk, longbridge)` 交易条目；读该注册表的消费方看不到本包的交易服务。
- **`baseUrl` 环境变量在插件路径下被绕过**：`LONGBRIDGE_API_URL`（`src/rest.ts:104`）只在
  直连 `LongbridgeRestClient` 且不传 `baseUrl` 时命中；`apply` 传的是
  `{appKey, appSecret, accessToken}`（`src/index.ts:216-217`），不含 `baseUrl`，所以环境变量
  在本路径下确实生效——但 `Config` 里**没有**可配置的基地址字段，改地址只能改环境变量。

## 合规记录

**长桥 OpenAPI 是券商官方接口，走 BYOK**：三条凭证（App Key / App Secret / Access Token）
由用户自备、只进 `*Ref` 环境变量名（`src/index.ts:56-58`、`213-215`），仓库永不内置、不落日志
（铁律 #3/#5）；本仓不缓存、不再分发任何行情或账户数据。使用边界以长桥开放平台的服务条款与
用户自身的行情/交易权限为准；行情与交易权限由长桥账户等级决定，连接器不做权限降级或绕行。

**下单备注只作对账锚，不是幂等键**：`remark` 由本地意图 id 确定性派生
（`LONGBRIDGE_REMARK_RULE`，`src/index.ts:71`），官方**没有**承诺按 remark 去重，
所以「同 ID 只下一单」完全由本地意图台账保证（`src/index.ts:166-175`）。

**实盘需人工签署授权**：`liveTrading` 只是非权威镜像，权威是 `@dshtrading/authority` 平面；
未签署时下单与撤单都在服务缝结构化拒绝（`src/index.ts:137-143`、`182-187`）。

`package.json` 的 license 是 `PolyForm-Noncommercial-1.0.0`（非商业免费，商用需书面授权）。

## 出网验证

本包暂无已提交的独立出网验证脚本：`spikes/` 下没有 `impl-longbridge*` 目录，
`spikes/impl-service-seam-gate/net-verify.mjs` 只覆盖 OKX，`spikes/verify-connectors-suite/`
只提交了 `EVIDENCE.md`（无脚本）。可复跑的最小入口（不触网）：

```sh
pnpm --filter @dshtrading/connector-longbridge test    # 离线契约测试（契约化假网关，无真实网络）
```

真机复跑需要用户自备长桥凭证（`LONGBRIDGE_APP_KEY` / `LONGBRIDGE_APP_SECRET` /
`LONGBRIDGE_ACCESS_TOKEN`），自写探针直调 `LongbridgeRestClient`；本仓未提交任何长桥端点的
请求或响应记录，本 README 不为该链路声明任何可用性结论。
