# @dshtrading/connector-tiger

老虎证券（Tiger Trade）连接器：**港股（hk）行情 + 交易双面**。上游是老虎**券商 OpenAPI 网关**
（`openapi.itiger.com/gateway`，RSA 签名鉴权），实现 `@dshtrading/api` 的
`MarketDataService` / `TradeService` 两个契约，注册服务键 `tradingHkMarketData` /
`tradingHkTrade`，注册 5 个 `hk_*` 工具。被 hk bundle 以 `workspace:*` 依赖
（`packages/hk/package.json:35`）。

**港股行情另有腾讯公开行情回落**：tiger 行情两法在失败时改打 `qt.gtimg.cn` /
`web.ifzq.gtimg.cn`（`src/rest.ts:130-142`、`166-184`）。这条回落必须与「老虎数据」区分，
详见「上游端点」与「合规记录」。

## 状态

**未实证**：本包没有已提交的真实券商请求记录（无原始响应、无真机错误码分布）。上游路径、
签名规范与字段映射全部取自源码（下文逐条给出行号），**未经真机核对**。已提交的相关材料只有两类：

- `spikes/impl-service-seam-gate/NET-VERIFY.md`（2026-09-01，第 36 行）：明确记录**未**
  对各家券商网关做真实下单验证，该轮唯一真实网络对象是 OKX；本包的服务缝三态由离线
  `test/trade-gate.test.ts` 覆盖，不是出网证据。
- `spikes/verify-connectors-suite/EVIDENCE.md`（2026-08-31，第 37-39 行）：当时的静态评审把
  tiger 交易面判为「本地 stub：`placeOrder` 不发网络请求、静默返回假 `status:'new'`」。
  该结论对应 commit `b80000e`；当前源码（`src/rest.ts:230-279`）确实 POST 网关、且在回执缺
  真实订单 id 时抛 `TRADING_EXCHANGE_ERROR`（第 253-266 行），与那时已不一致——但**现状同样
  没有实证**，本 README 不据此声明可用。

本仓 `spikes/` 下没有 `impl-tiger*` 目录，也没有任何针对老虎端点的探针脚本。

## 配置

字段名与默认值见 `src/index.ts:51-59`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`src/index.ts:52`） |
| `env` | `'demo'` | 运行环境标签（`src/index.ts:53`）。它**只进订单意图台账的作用域**（`src/index.ts:118-122` 的 `environment: options.config.env`），**不改变请求地址**——见「已知边界」 |
| `dryRun` | `true` | 强制模拟：为 true 时即使请求 `dryRun:false` 也只回本地模拟回执（`src/index.ts:140`） |
| `liveTrading` | `false` | 实盘请求的**非权威镜像**；真实放行需 `@dshtrading/authority` 平面的人工签署授权（`liveTradingEnabled()`，`src/index.ts:133`、`177`） |
| `tigerId` | 无默认（可选） | Tiger ID（`src/index.ts:56`）。**缺省时 rest 层用字面量 `'demo'` 占位**（`src/rest.ts:72`），不报错；也可由环境变量 `TIGER_ID` 回落（`src/rest.ts:65`） |
| `privateKeyRef` | `'TIGER_PRIVATE_KEY'` | RSA 私钥（PEM）的**环境变量名**（BYOK，`src/index.ts:57`），用于 RSA2 签名 |
| `accountId` | 无默认（可选） | Tiger 账户 ID（`src/index.ts:58`）。缺省时不发 `account` 业务字段（`src/rest.ts:193-198`、`219`、`240`、`286`）；也可由环境变量 `TIGER_ACCOUNT_ID` 回落（`src/rest.ts:67`） |

交易安全三件套在本包的落点：

- **dry-run 缺省**：工具参数 `dryRun` 默认 `true`（`src/index.ts:271`），工具执行里
  `args.dryRun !== false` 即走模拟分支（`src/index.ts:280`）；服务内 `order.dryRun ?? true`
  （`src/index.ts:132`）。
- **liveTrading 必须显式开启且非权威**：工具层再查一次（`src/index.ts:302-308`），服务缝
  内第一步也查（`src/index.ts:133-139`）；撤单与下单同门槛（`src/index.ts:177-182`）。
- **base 审批闸门**：`hk_place_order` / `hk_cancel_order` 命中
  `LIVE_ACTION_GATE_PATTERN`（`packages/base/src/index.ts:63`），无人在场时 ask 降级为 deny
  （`packages/base/src/index.ts:20-24`）。
- **凭证只进 ref**：`privateKeyRef` 在 `apply` 里经 `process.env[...]` 解析（`src/index.ts:220`），
  值只交给 rest 客户端，不落日志、不进台账身份（`src/index.ts:121`）。

## 接线

- **数据面行**：`packages/hk/cordis.patch.yml:42-45` → 行 id `dsh-trading-hk-dataplane-tiger`，
  `name: '@dshtrading/connector-tiger/dataplane'`，行 config 只写 `enabled: true`。
  `src/dataplane.ts` 重导出 `Config`（第 10 行）让 loader 补全 schema 默认值，在
  `tradingHkMarketData` isolate realm 内构造行情服务（第 34-35 行）并 `register('hk', 'tiger', …)`
  进 `tradingMarketDataRegistry`（第 36 行）；无注册表的老部署回退直接构造（第 30-33 行）。
  **该文件不解析也不注册 `tradingTradeRegistry`**（全文件无此键）——交易服务只在 preset 面可用。
- **preset 行**：`packages/hk/assets/preset/hk-trader/agent.cordis.yml:93-105` → 组 id
  `dsh-trading-hk-connector-tiger-group`，`isolate: {tradingHkMarketData, tradingHkTrade}`
  （第 96-98 行），行 id `dsh-trading-hk-connector-tiger`，`name: '@dshtrading/connector-tiger'`，
  行 config `enabled: true` / `dryRun: true` / `liveTrading: false`（第 102-105 行）。
  该行的 `apply` 直接构造行情与交易两个服务（`src/index.ts:228-229`），不经注册表。
- **provider 词汇**：`packages/router/src/index.ts:81`（`PROVIDER_VOCABULARY` 的 `'tiger'`）。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:46`
  （`PROVIDER_LABELS`：`type: 'commercial'`、`env: 'TIGER_ID'`、`markets: ['hk','us','cn']`）
  与 `packages/client-ui-settings/src/client/locales.ts:256`（中文 `Tiger Trade (老虎证券)`）/
  第 402 行（英文 `Tiger Trade`）。凭据表单字段为 `tigerId` / `privateKey`
  （`trading-settings-controller.ts:147-150`）。**`markets` 的 `us`/`cn` 是设置页登记面，
  不是本包实现面**——见「已知边界」。
- **bundle 依赖**：`packages/hk/package.json:35` 的 `@dshtrading/connector-tiger: workspace:*`。
- **激活条件**：`routeAllows()` 要求 `enabled` 且
  `tradingMarketRouter.activeProvider('hk') === 'tiger'`（`src/index.ts:209-214`）。

## 上游端点

- 主基地址：`process.env.TIGER_API_URL || 'https://openapi.itiger.com/gateway'`（`src/rest.ts:64`），
  也可由 `TigerRestOptions.baseUrl` 覆盖。全部业务调用都是**同一个 POST 端点**，靠 `method`
  字段区分（`src/rest.ts:76-99`，参数字段 `tiger_id` / `method` / `charset` / `sign_type: 'RSA2'` /
  `timestamp` / `version` / `biz_content` / `sign`）。
- 回落基地址（**公开端点，非老虎**）：`https://qt.gtimg.cn`（`src/rest.ts:133`）与
  `https://web.ifzq.gtimg.cn`（`src/rest.ts:169`）。

| 用途 | method / 端点 | 源码 |
|---|---|---|
| 实时报价 | `POST 网关` `method=quote_real_time`（`biz_content.symbols=[sym]`） | `src/rest.ts:120` |
| K 线 | `POST 网关` `method=kline_quote`（`symbols` / `period` / `limit`） | `src/rest.ts:153` |
| 账户资产 | `POST 网关` `method=user_asset`（`account`） | `src/rest.ts:198` |
| 持仓 | `POST 网关` `method=positions`（`account`） | `src/rest.ts:219` |
| 下单 | `POST 网关` `method=trade_order`（`account` / `symbol` / `action`(BUY\|SELL) / `orderType`(MKT\|LMT) / `totalQuantity` / `limitPrice`） | `src/rest.ts:246` |
| 撤单 | `POST 网关` `method=cancel_order`（`account` / `orderId`） | `src/rest.ts:288` |
| **港股报价回落** | `GET https://qt.gtimg.cn/q=hk00700`（`~` 分隔文本，取第 4 段为价） | `src/rest.ts:133-136` |
| **港股 K 线回落** | `GET https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hk00700,day,,,{limit},qfq` | `src/rest.ts:169-171` |

## 周期与契约

- **周期词汇 8 个**：`1m/5m/15m/30m/1h/1d/1w/1M`（`src/rest.ts:24`），但**没有到上游的映射表**：
  `period: interval` 原样透传（`src/rest.ts:153`）——本包不产生 `TRADING_UNSUPPORTED_INTERVAL`，
  非法周期由上游拒绝。工具 enum 与词汇同集合（`src/index.ts:252`）。
- **回落恒为日线**：腾讯 K 线回落的分支写死 `param=...,day,,,{limit},qfq`
  （`src/rest.ts:169`），**`interval` 与请求参数无关**；`closeTime` 也恒按一天
  （`openTime + 86400000 - 1`，第 163、181 行），非日线周期下与周期无关。
- **符号形态**：`toTigerSymbol`（`src/rest.ts:26-37`）——含 `.` 的取点前段为 venue symbol；
  裸 5 位数字补成 `<code>.HK`；**4 位 `0700.HK` 不补零**（与 futu 的 `normalizeHkSymbol`、
  longbridge 的 `toLongbridgeSymbol` 不同）；空串 → `TRADING_INVALID_ARGUMENT`（第 28 行）。
- **签名规范**：`generateTigerSignature`（`src/rest.ts:39-46`）——参与字段按 key 字典序拼
  `k=v&…`，剔除空值与 `sign` 自身（第 40 行），RSA-SHA256 + base64。
- **不发 venue client key**：本连接器**不发**官方 `user_mark`（类头注 `src/index.ts:99-107`：
  本包发的是 camelCase 键，与官方 snake_case 业务参数尚未逐字对齐，按「不猜字段」纪律不新增）；
  实盘幂等完全由本地意图台账保证。
- **错误映射**：签名失败 → `TRADING_AUTH_FAILED`（`src/rest.ts:90`）；HTTP 非 2xx →
  `TRADING_UPSTREAM_ERROR`（第 101 行）；请求抛错 → `TRADING_NETWORK`（第 106-110 行）；
  缺 privateKey（资产与交易面）→ `TRADING_AUTH_FAILED`（第 191、213、232、283 行）；
  下单无 `data` 或无真实订单 id → `TRADING_EXCHANGE_ERROR`（第 255、262 行，**不编 id**）；
  单笔订单查询 → `TRADING_NOT_IMPLEMENTED`（`src/index.ts:192-196`，显式拒绝而非返回编造订单）。
- **行情两法静默回落**：`getTicker` / `getKlines` 的 `catch` 包住**整个**上游调用
  （`src/rest.ts:116-142`、`149-184`），所以鉴权失败、HTTP 非 2xx、业务码非 0 都会触发腾讯回落，
  回落结果按本连接器的输出返回，**回执里没有任何「这是腾讯数据」的标记**。
- **无本地超时**：`requestJson` 不设 `AbortController`/超时（`src/rest.ts:71-112`），
  上游无响应时请求没有连接器侧上限（与 futu 的 10 s 不同）。
- **服务类字段用 TS 编译期 `private`**（禁 ECMAScript `#`，cordis realm 代理会炸）。

## 能力面

行情面服务方法（`src/index.ts:64-93`）：

| 服务方法 | 状态 |
|---|---|
| `getTicker` | 有（`src/index.ts:76-78`；失败时静默回落腾讯，`src/rest.ts:116-142`） |
| `getKlines` | 有（`src/index.ts:80-82`；失败时静默回落腾讯日线，`src/rest.ts:149-184`） |
| `subscribeTicker` | 有（快照轮询，缺省 5000 ms、下限 1000 ms，`src/index.ts:84-92`） |
| `listInstruments` / `getTickers` / `getOrderbook` / `getFundamentals` / `getDerivatives` / `getRecentTrades` | 缺席 |

交易面服务方法（`src/index.ts:95-205`）：

| 服务方法 | 状态 | 有对应工具 |
|---|---|---|
| `placeOrder` | 有（三态闸门 + 意图台账，`src/index.ts:129-172`） | `hk_place_order` |
| `cancelOrder` | 有（与下单同门槛，`src/index.ts:174-184`） | `hk_cancel_order` |
| `getBalance` | 有（`src/index.ts:125-127`） | `hk_get_balance` |
| `getPositions` | 有（POST `method=positions`，`src/index.ts:198-200`） | **无工具** |
| `getOrders` | 恒返回 `[]`（`src/index.ts:202-204`） | 无 |
| `getOrder` | **显式抛 `TRADING_NOT_IMPLEMENTED`**（`src/index.ts:191-196`：本切片没有已核对的订单状态契约，不返回编造订单） | 无 |
| `getBalances` / `listOpenOrders` / `listTradeFills` / `setLeverage` | 缺席 | 无 |

注册的工具 5 个（`src/index.ts:231-343`，同名已存在则跳过，第 233-235 行）：

| 工具 | 注册位置 | 说明 |
|---|---|---|
| `hk_get_ticker` | `src/index.ts:237-245` | 最新价与成交量；回落后可能是腾讯数据 |
| `hk_get_klines` | `src/index.ts:247-260` | interval 用 8 词汇枚举，缺省 `1d`；limit 缺省 100 |
| `hk_place_order` | `src/index.ts:262-320` | `dryRun !== false` 时回本地模拟回执（`sim-tiger-` 前缀）；否则要求 `liveTrading` |
| `hk_cancel_order` | `src/index.ts:322-331` | 参数名 `ordId`；实盘动作，同样需 `liveTrading` 且 `dryRun=false` |
| `hk_get_balance` | `src/index.ts:333-342` | 账户余额（返回形状与 `AccountBalance` 契约不一致，见「已知边界」） |

注意本包**没有任何工具名带 `crypto` 前缀**：模板残留（旧 README 的 Token 段）写的是
`crypto`/`Crypto`，实际工具前缀是 `hk`、服务键 infix 是 `Hk`（`src/index.ts:61-62`、`238`）。

## 已知边界

- **未实证项**：全部端点、签名是否被上游接受、真机错误码分布，均未经真机核对。
  `spikes/impl-service-seam-gate/NET-VERIFY.md:36` 明确记录未对券商网关做真实下单验证。
- **行情静默回落公共源**：`getTicker` / `getKlines` 在上游抛任何错（含未签名、非 2xx、业务码非 0）
  时改打腾讯（`src/rest.ts:130-142`、`166-184`），并把结果按本连接器的输出返回——
  凭证失效或网关故障时，用户看到的可能**不是老虎数据**，而回执里没有来源标记。
- **回落只对港股形态有意义**：回落用 `hk${sym.padStart(5,'0')}` 拼代码（`src/rest.ts:132,168`），
  传美股符号会拼出无意义请求（如 `AAPL` → `hk0AAPL`）——**该后果未实证**。
- **回落 K 线恒日线**：`interval` 在回落分支被忽略（`src/rest.ts:169`），
  请求 `1m` 也可能拿到日线 bar。
- **`env` 不改变地址**：`env: 'demo'` 只进意图台账作用域（`src/index.ts:118-122`），
  基地址恒为 `openapi.itiger.com/gateway`（`src/rest.ts:64`）。即实盘放行后，
  `env` 仍为 `demo` 的部署也会把订单发往**生产**网关。
- **`tigerId` 缺省静默占位**：缺 `tigerId` 时 `requestJson` 用字面量 `'demo'`
  当 `tiger_id`（`src/rest.ts:72`），不报错也不提示——配置缺口会以「上游拒绝」的形态出现。
- **凭证缺失不发 sign**：`privateKey` 缺失时 `requestJson` 只是不加 `sign` 参数
  （`src/rest.ts:86-92`），请求照发；只有资产与交易面方法做前置检查并抛
  `TRADING_AUTH_FAILED`（`src/rest.ts:190-192`、`212-214`、`231-233`、`282-284`）。
- **`getBalance` / `getPositions` 返回形状与契约不符**：`getBalance` 返回
  `{currency, available, total}`（`src/rest.ts:204-208`），而 `AccountBalance` 是
  `{asset, free, locked}`（`packages/api/src/index.ts:578-582`）；`getPositions` 每行返回
  `{symbol, quantity, entryPrice, unrealizedPnl}`（`src/rest.ts:222-227`），而 `Position` 要求
  `{symbol, side, size, entryPrice, timestamp}`（`packages/api/src/index.ts:499-520`）。
  消费方按契约字段读会读到 `undefined`（**运行期表现未实证**）。
- **`getOrder` 显式拒绝**：`src/index.ts:191-196` 抛 `TRADING_NOT_IMPLEMENTED`，
  不返回编造订单（与 futu 同位置返回常量占位对象的做法相反）。
- **无本地超时**（`src/rest.ts:71-112`）。
- **`getOrders` 恒空**（`src/index.ts:202-204`）：空数组在消费方读作「无挂单」，而不是「本包不支持」。
- **持仓面有服务、无工具**：`getPositions` 只经 `tradingHkTrade` 服务可达（`src/index.ts:198-200`），
  工具面没有对应的 `hk_get_positions`。
- **交易面不进交易注册表**：`src/dataplane.ts` 全文件没有 `tradingTradeRegistry`，注册表里没有
  `(hk, tiger)` 交易条目；读该注册表的消费方看不到本包的交易服务。
- **设置页登记的市场多于实现面**：`PROVIDER_LABELS` 里 tiger 的 `markets` 是 `['hk','us','cn']`
  （`trading-settings-controller.ts:46`），但本包 `MARKET = 'hk'`（`src/dataplane.ts:24-25`）、
  `routeAllows(ctx, config, 'hk')`（`src/index.ts:218`）——`us`/`cn` 选择没有对应的数据面实例。
- **4 位 `.HK` 不补零**：`toTigerSymbol` 对含 `.` 的输入只取点前段（`src/rest.ts:29-32`），
  `0700.HK` 与 `00700.HK` 归一结果不同（前者保持 4 位）。

## 合规记录

**老虎 OpenAPI 是券商官方接口，走 BYOK**：`tigerId` 与 RSA 私钥由用户自备，私钥只进
`privateKeyRef` 环境变量名（`src/index.ts:57`、`220`），仓库永不内置、不落日志（铁律 #3/#5）；
本仓不缓存、不再分发任何行情或账户数据。使用边界以老虎开放平台的服务条款与用户自身的
行情/交易权限为准。

**行情回落是腾讯公开端点，不是老虎数据**：网关不可达或鉴权失败时，`getTicker`/`getKlines`
会改打 `qt.gtimg.cn` / `web.ifzq.gtimg.cn`（`src/rest.ts:133,169`）。该端点非官方、无 key、
无 SLA，其边界与合规口径见 [connector-tencent 的合规记录](../connector-tencent/README.md)；
用户需知悉回落发生时的数据并非来自老虎。

**不发 venue client key**：官方 `user_mark` 的键名尚未与官方 biz-content 逐字对齐，按
「不猜字段」纪律不加（`src/index.ts:99-107`）；`remark` 类字段不构成 venue 幂等，
「同 ID 只下一单」由本地意图台账保证（`src/index.ts:162-163`）。

**实盘需人工签署授权**：`liveTrading` 只是非权威镜像，权威是 `@dshtrading/authority` 平面；
未签署时下单与撤单都在服务缝结构化拒绝（`src/index.ts:133-139`、`177-182`）。

`package.json` 的 license 是 `PolyForm-Noncommercial-1.0.0`（非商业免费，商用需书面授权）。

## 出网验证

本包暂无已提交的独立出网验证脚本：`spikes/` 下没有 `impl-tiger*` 目录，
`spikes/impl-service-seam-gate/net-verify.mjs` 只覆盖 OKX，`spikes/verify-connectors-suite/`
只提交了 `EVIDENCE.md`（无脚本）。可复跑的最小入口（不触网）：

```sh
pnpm --filter @dshtrading/connector-tiger test    # 离线契约测试（契约化假网关，无真实网络）
```

真机复跑需要用户自备老虎凭证（`TIGER_ID` / `TIGER_PRIVATE_KEY` / `TIGER_ACCOUNT_ID`），
自写探针直调 `TigerRestClient`；本仓未提交任何老虎网关的请求或响应记录。若要单独核对
行情回落链路的边界，可走 [connector-tencent](../connector-tencent/README.md) 的口径，
但本包 README 不为该链路声明任何可用性结论。
