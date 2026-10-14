# @dshtrading/connector-futu

富途（Futu）连接器：**行情面 hk + us 双市场，交易面仅 hk**。上游不是公开 Web 端点，
而是用户本机的 **Futu OpenD 网关**——且 OpenD 原生协议是 TCP protobuf（无 HTTP 面），
HTTP 契约的真实载体是本仓的 Python 桥 `scripts/futu-openapi-bridge.py`。
实现 `@dshtrading/api` 的 `MarketDataService` / `TradeService` 两个契约，注册服务键
`tradingHkMarketData` / `tradingHkTrade`，注册 3 个 `hk_*` 工具。被 hk bundle 以
`workspace:*` 依赖（`packages/hk/package.json:32`）。

## 状态

**已在真机上证（本机 OpenD + 本仓桥，SIMULATE 面）**，证据分三批：

- 交易面（2026-10-08/09，真 Futu OpenD）：`spikes/impl-futu-bridge/README-trading-face-2026-10-08.md`。
  港股 SIMULATE 上完成 下单 → 挂单快照读回锚 → 撤单 → 撤后为空，另有 8 条失败路径与美股
  `US.AAPL` 的同序往返；原始响应 `trd-*.json`，探针输出 `probe-read-only-2026-10-08.txt` /
  `probe-full-round-trip-2026-10-08.txt` / `probe-guards-2026-10-09.txt`。账户 id 已脱敏。
- 美股行情面（2026-09-08）：`spikes/impl-futu-us/connector-smoke.out.txt` 记录了
  `US.AAPL` ticker 319.97（bid/ask 320.01/320.07）与 1m 尾巴落在收盘分钟。
- 服务缝三态闸门：`spikes/impl-service-seam-gate/NET-VERIFY.md`（2026-09-01）——该批的**唯一**
  真实网络对象是 OKX，第 36 行明确记录未对券商网关做真实下单验证；本包的服务缝三态由离线
  `test/trade-gate.test.ts` 覆盖，不是出网证据。

**未实证项**：REAL（真实资金）环境面。全批证据都在 `SIMULATE` 账户上，未做 OpenD 侧
`unlock_trade`；实盘放行路径（`liveTrading` 签署后打 REAL）没有真机记录。
历史评审 `spikes/verify-connectors-suite/EVIDENCE.md:37-39` 把本包行情面判为
「HTTP `/api/trd/*` 路径真实性未验证」——该结论对应 commit `b80000e`，与当前源码
（真实桥往返证据见上）已不一致，仅作历史记录。

## 配置

字段名与默认值见 `src/index.ts:56-63`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关（`src/index.ts:57`）。与本组另两个连接器不同，本包**缺省关闭**；接线行与 preset 行都显式 restate `enabled: true` |
| `gatewayUrl` | `'http://127.0.0.1:11111'` | HTTP 网关地址（`src/index.ts:58`，客户端同一默认见 `src/rest.ts:168`）。**11111 是 OpenD 原生 TCP protobuf 端口，不是 HTTP 面**——插件路径下必须由接线行改成桥的地址（现行 `http://127.0.0.1:11112`），见「上游端点」 |
| `dryRun` | `true` | 强制模拟：为 true 时即使请求 `dryRun:false` 也只回本地模拟回执（`src/index.ts:275`） |
| `liveTrading` | `false` | 实盘请求的**非权威镜像**；真实放行需 `@dshtrading/authority` 平面的人工签署授权（`liveTradingEnabled()`，`src/index.ts:268`）。它同时决定 OpenD 的 `trdEnv`：不放行恒 `SIMULATE`（`src/index.ts:238`） |
| `unlockPwdRef` | `'FUTU_UNLOCK_PWD'` | 交易解锁口令的**环境变量名**（BYOK，`src/index.ts:61`）。只进 ref：值从 `process.env` 读入凭证对象（`src/index.ts:234`），不落日志、不进意图台账身份（`src/index.ts:82`） |
| `accId` | `0` | OpenD 账户 id（`src/index.ts:62`）。`0` / 缺省 = 不发这一格，由 OpenD 用默认账户；**撤单例外**：0/缺省在出站前抛 `TRADING_ACCOUNT_REQUIRED`（`src/rest.ts:220-229`） |

交易安全三件套在本包的落点：

- **dry-run 缺省**：工具参数 `dryRun` 默认 `true`（`src/index.ts:401`），服务内 `order.dryRun ?? true`
  （`src/index.ts:267`）。
- **liveTrading 必须显式开启且非权威**：放行判定归 `@dshtrading/authority`，配置项只是镜像
  （`src/index.ts:268-274`、`317-324`）。
- **base 审批闸门**：工具名 `hk_place_order` 命中 `LIVE_ACTION_GATE_PATTERN`
  （`packages/base/src/index.ts:63`），无人在场时 ask 降级为 deny（`packages/base/src/index.ts:20-24`）。
  注意本包**没有** `hk_cancel_order` 工具，撤单只能经服务面，服务缝自带同门槛闸门。
- **凭证只进 ref**：`FUTU_UNLOCK_PWD` 不内置、不进日志（`src/index.ts:61,234`）。

## 接线

- **数据面行**：`packages/hk/cordis.patch.yml:27-32` → 行 id `dsh-trading-hk-dataplane-futu`，
  `name: '@dshtrading/connector-futu/dataplane'`，行 config 为 `enabled: true` +
  `gatewayUrl: 'http://127.0.0.1:11112'`（第 31-32 行注释写明 11111 是 TCP protobuf、HTTP 契约走桥）。
  `src/dataplane.ts` 重导出 `Config`（第 32 行）让 loader 补全 schema 默认值；它在
  `tradingHkMarketData` isolate realm 内构造行情服务并 `register('hk', 'futu', …)`（第 73-75 行），
  再为 `us` 另建**独立实例**并 `register('us', 'futu', …)`（第 79-85 行，isolate 键
  `tradingUsMarketData`）——本包是唯一在数据面**双市场**注册的连接器；交易注册仅 `hk`
  （第 87-98 行）。无注册表的老部署回退直接构造（第 69-72 行）。
- **preset 行**：`packages/hk/assets/preset/hk-trader/agent.cordis.yml:49-63` → 组 id
  `dsh-trading-hk-connector-futu-group`，`isolate: {tradingHkMarketData, tradingHkTrade}`
  （第 52-54 行），行 id `dsh-trading-hk-connector-futu`，`name: '@dshtrading/connector-futu'`，
  行 config `enabled: true` / `gatewayUrl: 'http://127.0.0.1:11112'` / `dryRun: true` /
  `liveTrading: false`（第 58-63 行）。该行的 `apply` 直接构造行情与交易两个服务（`src/index.ts:466-468`），
  不经注册表。
- **provider 词汇**：`packages/router/src/index.ts:79`（`PROVIDER_VOCABULARY` 的 `'futu'`）。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:44`
  （`PROVIDER_LABELS`：`type: 'gateway'`、`env: 'FUTU_HOST'`、`markets: ['hk','us']`，即
  dataplane 的真实注册面）与 `packages/client-ui-settings/src/client/locales.ts:254`（中文
  `Futu (富途 OpenD)`）/ 第 400 行（英文 `Futu (OpenD)`）。凭据表单字段为 `host` + `port`
  （`trading-settings-controller.ts:135-138`），见「已知边界」。
- **bundle 依赖**：`packages/hk/package.json:32` 的 `@dshtrading/connector-futu: workspace:*`。
- **激活条件**：`routeAllows()` 要求 `enabled` 且 `tradingMarketRouter.activeProvider('hk') === 'futu'`
  （`src/index.ts:455-460`）；数据面行的行情注册不占根市场键，激活裁决推迟到消费方按路由当前值惰性解析。

## 上游端点

本包不直连任何公开互联网端点。链路是：

    connector-futu ──HTTP(JSON)──> scripts/futu-openapi-bridge.py ──futu-api SDK──> Futu OpenD (TCP protobuf)

**OpenD 原生 11111 是 FTAPI（TCP protobuf），没有 HTTP 面**：2026-09-08 实证对 11111 发 HTTP
请求会 TCP 连上但永不响应，表现为连接器 10 s 超时 abort（`.agents/notes/implemented/feature/2026-09-08-futu-openapi-http-bridge.md`）。
HTTP 契约的唯一载体是本仓桥，缺省端口 11112（`FUTU_BRIDGE_PORT` 可改，用于旁路验证）。

| 用途 | 端点 | 源码 |
|---|---|---|
| 行情快照 | `GET /api/qot/get-ticker?security=HK.00700` | `src/rest.ts:275` |
| K 线 | `GET /api/qot/get-kl?security=&klType=&reqNum=&rehabType=1` | `src/rest.ts:306-311` |
| 标的名册 | `GET /api/qot/get-plate-security?plate=HK.BK1000` | `src/rest.ts:340` |
| 账户资金 | `GET /api/trd/get-funds` | `src/rest.ts:352` |
| 下单 | `POST /api/trd/place-order`（`security` / `trdSide`(1买2卖) / `orderType`(1限价2市价) / `qty` / `price` / `trdEnv` / `accId?` / `remark?`） | `src/rest.ts:379-389` |
| 撤单 | `POST /api/trd/cancel-order`（`trdEnv` 与**必填** `accId`） | `src/rest.ts:417-421` |
| 挂单快照 | `POST /api/trd/get-orders`（`market`(HK\|US) / `trdEnv` / `accId?`） | `src/rest.ts:433-437` |

信封形状 `{retType, retMsg, data}`，`retType === 0` 才算成功（`src/rest.ts:243-248`）。
三条 `/api/trd/*` **只有 POST + JSON 一种传输**（owner 2026-10-08 裁决，桥同批按 POST 实现）。

## 周期与契约

- **周期词汇 9 个**：`1m/5m/15m/30m/1h/4h/1d/1w/1M` → `klType` `1/2/3/4/5/5/6/7/8`
  （`src/rest.ts:83-93`）。**`4h` 没有原生档，映射到 60m（静默降级，第 89 行）**。
  工具 `hk_get_klines` 的 enum 与词汇同集合（`src/index.ts:491`），但其 description 只列
  `5m/15m/30m/1h/1d/1w/1M`（第 488 行），与该 enum 不一致。
- **`limit` 夹取 1..1000**，缺省 100（`src/rest.ts:302`；工具默认同为 100，`src/index.ts:492`）。
- **符号形态**：`normalizeSymbol` 按形态分派——数字形态走港股、其余走美股（`src/rest.ts:138-144`）。
  港股接受 `00700.HK` / `HK.00700` / 裸 `700`，输出补零 5 位规范形（第 110-119 行）；美股接受
  `AAPL` / `us.aapl` / `US.BRK.B`，输出裸 ticker（第 122-132 行）；出站转 `HK.00700` / `US.AAPL`
  （第 147-154 行）。认不出即抛 `TRADING_UNSUPPORTED_SYMBOL`，不静默改写。
- **交易面符号只走港股归一**（`src/rest.ts:376`）：美股下单在本地即 `TRADING_UNSUPPORTED_SYMBOL`
  （实证输出见 `spikes/impl-futu-us/connector-smoke.out.txt` 的 `US placeOrder gate` 行）。
- **错误映射**：HTTP 非 2xx → `TRADING_EXCHANGE_ERROR`（`src/rest.ts:241`）；信封 `retType !== 0`
  → `TRADING_EXCHANGE_ERROR`（第 244-247 行）；不可达/超时 → `TRADING_NETWORK`（第 252-259 行）；
  下单回执缺 `orderId` → `TRADING_UPSTREAM_ERROR`（第 394-397 行，**不编 id**）；撤单缺 `accId`
  → `TRADING_ACCOUNT_REQUIRED`（第 223 行，**出站前拒绝**）；挂单行缺 `qty` / `createTime` /
  方向 / 类型 → `TRADING_EXCHANGE_ERROR`（`src/index.ts:135-207`，认不出即抛，不折成 0）。
  **本包用 `TRADING_EXCHANGE_ERROR` 表达上游错误，与 longbridge/tiger 用 `TRADING_UPSTREAM_ERROR` 不同。**
- **本地超时 10 s**（`src/rest.ts:170`，`AbortController` 见第 233-234 行）。
- **服务类字段用 TS 编译期 `private`**（禁 ECMAScript `#`，cordis realm 代理会炸）。

## 能力面

行情面服务方法（`src/index.ts:88-122`）：

| 服务方法 | 状态 |
|---|---|
| `getTicker` | 有（`src/index.ts:101-103`） |
| `getKlines` | 有（`src/index.ts:105-107`） |
| `listInstruments` | 有，但**只在 hk 实例**上有内容：取 `HK.BK1000` 盘口（`src/rest.ts:335-349`）；us 实例显式返回 `[]`（fail-closed，第 336 行） |
| `subscribeTicker` | 有（快照轮询，缺省 5000 ms、下限 **500 ms**，`src/index.ts:113-121`；下限比 longbridge/tiger 的 1000 ms 更低） |
| `getTickers` / `getOrderbook` / `getFundamentals` / `getDerivatives` / `getRecentTrades` | 缺席 |

交易面服务方法（`src/index.ts:210-353`）：

| 服务方法 | 状态 | 有对应工具 |
|---|---|---|
| `placeOrder` | 有（三态闸门 + 意图台账，`src/index.ts:264-315`） | `hk_place_order` |
| `cancelOrder` | 有（与下单同门槛，`src/index.ts:317-326`） | **无工具** |
| `getBalance` | 有（`src/index.ts:260-262`） | **无工具** |
| `getBalances` | 有，但**吞掉一切异常返回 `[]`**（`src/index.ts:328-335`） | 无 |
| `listOpenOrders` | 有（桥的挂单快照，`src/index.ts:248-254`） | **无工具** |
| `getOrders` | 有（同源 `listOpenOrders`，`src/index.ts:256-258`） | 无 |
| `getOrder` | **返回编造占位对象**（`src/index.ts:341-352`：`side:'buy'` / `type:'limit'` / `status:'new'` / `quantity:0` / `dryRun:false` 全是常量） | 无 |
| `getPositions` | 恒返回 `[]`（`src/index.ts:243-245`） | 无 |
| `listTradeFills` | 恒返回 `[]`（`src/index.ts:337-339`） | 无 |
| `getCredentials`（非契约） | 有（`src/index.ts:232-241`） | 无 |
| `setLeverage` | 缺席 | 无 |

注册的工具 3 个（`src/index.ts:470-502`，同名已存在则跳过，第 472-474 行）：

| 工具 | 注册位置 | 说明 |
|---|---|---|
| `hk_get_ticker` | `src/index.ts:476-484` | 最新价与买卖一档 |
| `hk_get_klines` | `src/index.ts:486-499` | interval 用 9 词汇枚举（含 `4h`），缺省 `1d`；limit 缺省 100 |
| `hk_place_order` | `src/index.ts:391-451`（注册在第 501 行） | `dryRun !== false` 时回本地模拟回执（带 `referencePrice` 市价参照）；否则过 `evaluateOrderGate` 三态 |

## 已知边界

- **REAL 环境未实证**：全部交易证据是 `SIMULATE`；未做 `unlock_trade`，未打 REAL 账户。
- **`gatewayUrl` 默认值 11111 在本包路径上不可用**：它是 OpenD 原生 TCP protobuf 端口，
  没有 HTTP 面（2026-09-08 实证：TCP 连上、永不响应、10 s abort）。插件路径下 11111 只会带来
  10 s 超时；可用必须靠接线行的 `gatewayUrl: http://127.0.0.1:11112`
  （`packages/hk/cordis.patch.yml:32` 与 preset 第 61 行）。桥进程与已登录的 OpenD 缺一，
  行情面报 `TRADING_NETWORK`。
- **`getOrder` 返回的不是 venue 真值**：`src/index.ts:341-352` 用常量拼一个 `Order` 返回，
  既不含真实状态也不报错。消费方（base 账户工具 / GUI）把返回值当交易所真值消费时会读到假单；
  与 tiger 同位置显式抛 `TRADING_NOT_IMPLEMENTED` 的做法相反。
- **`getPositions` / `listTradeFills` 恒空**：`src/index.ts:243-245`、`337-339`。空数组在消费方
  读作「无持仓 / 无成交」，而不是「本包不支持」。
- **`getBalances` 吞错**：`src/index.ts:328-335` 把任何异常折成 `[]`，上游故障与空账户不可区分。
- **`unlockPwdRef` 读了但不上线**：`FUTU_UNLOCK_PWD` 被读进凭证对象（`src/index.ts:234`），
  而 `src/rest.ts` 里除类型声明（第 54 行）外没有任何使用点——解锁由人本在 OpenD 侧完成，
  本包不发这一格。凭证 ref 存在不代表本包会用它。
- **`4h` 静默降级到 60m**（`src/rest.ts:89`）：请求 `4h` 得到的是 1 小时 bar，回执无任何标记。
- **本包无撤单/余额工具**：`cancelOrder` / `getBalance` 只在服务面（`tradingHkTrade`）可达，
  工具面只有 3 个 `hk_*`。经工具调用撤单在本包不可用。
- **设置页凭据表单字段与 Config 不一致**：面板收集 `host` + `port`
  （`trading-settings-controller.ts:135-138`），而连接器 Config 只认 `gatewayUrl`
  （`src/index.ts:58`）——`FUTU_HOST` 在全仓只出现在设置页的 `env` 提示里
  （`trading-settings-controller.ts:44`），连接器不读它。面板填的 host/port 不会变成网关地址。
- **us 面只注册行情、不注册交易**：`src/dataplane.ts:55-58` 的 `MARKET = 'hk'` 决定交易注册面；
  美股下单在符号层即被拒（`src/rest.ts:376`）。
- **账户 id 不进仓库**：桥与探针证据里的 `accId` 已脱敏为 `<redacted-accId>`。
- **订阅槽上限 100**：桥按 `(security, klType)` 占槽并 LRU 淘汰，满额后新订阅全失败
  （`.agents/notes/implemented/feature/2026-09-08-futu-openapi-http-bridge.md` 的 Addendum）。
  这是桥的边界而非本包的；本包只看到「分钟线全错」这一现象面。

## 合规记录

**OpenD 是富途官方 OpenAPI 客户端，走用户本机**：连接器不直连富途服务器，只与回环地址上的
OpenD/桥通信；桥以官方 `futu-api` SDK 承担登录与订阅。凭证（`FUTU_UNLOCK_PWD`）与账户 id
由用户自备，仓库不内置、不落日志（铁律 #3/#5）；本仓不缓存、不再分发任何行情或账户数据。
使用边界以富途 OpenAPI 的官方条款与用户自身行情权限（LV1/LV2/LV3）为准。

**额度是官方限制，实现按额度语义择路**：桥的 ticker 走 `get_market_snapshot`（不耗额度），
K 线走 `subscribe + get_cur_kline`（占订阅槽、不耗历史 K 线月度额度），刻意回避
`request_history_kline`（月度额度 100 次，60 s 轮询两天烧光）——见
`.agents/notes/implemented/feature/2026-09-08-futu-openapi-http-bridge.md`。

**REAL 下单需人本前置**：`unlock_trade` 不在桥里做、不进仓库脚本；本包的服务缝闸门
（`src/index.ts:268-274`）与 base 审批闸门叠加，缺签署授权一律 fail-closed。

`package.json` 的 license 是 `PolyForm-Noncommercial-1.0.0`（非商业免费，商用需书面授权）。

## 出网验证

已提交的入口（**需前置**：本机 OpenD 已登录 + 桥在跑；本 README 不声明其当前通过状态）：

```sh
pnpm --filter @dshtrading/connector-futu build          # verify-native-hk.mjs 依赖包内 lib/
FUTU_BRIDGE_PORT=11113 python3 scripts/futu-openapi-bridge.py &   # 旁路端口，不动常驻 11112
node spikes/impl-futu-us/verify-native-hk.mjs           # 相对导入仓库 lib，读 11113
```

交易面最小复跑（三条 curl，取自 `spikes/impl-futu-bridge/README-trading-face-2026-10-08.md`
的「复现」段；一律 SIMULATE，需人本提供正 `accId`）：

```sh
curl -s -X POST -H 'content-type: application/json' \
  -d '{"security":"HK.00700","trdSide":1,"orderType":1,"qty":100,"price":406.8,
       "trdEnv":"SIMULATE","accId":<accId>,"remark":"e2e-bridge-anchor-1"}' \
  http://127.0.0.1:11113/api/trd/place-order
curl -s -X POST -H 'content-type: application/json' \
  -d '{"market":"HK","trdEnv":"SIMULATE","accId":<accId>}' http://127.0.0.1:11113/api/trd/get-orders
curl -s -X POST -H 'content-type: application/json' \
  -d '{"orderId":"<orderId>","trdEnv":"SIMULATE","accId":<accId>}' \
  http://127.0.0.1:11113/api/trd/cancel-order
```

不触网的离线入口：`pnpm --filter @dshtrading/connector-futu test`（契约测试用假桥，无真实网络）。

注意 `spikes/impl-futu-us/connector-smoke.mjs` 的 import 指向历史工作树绝对路径
（`/tmp/dsh-trading-futu-us/...`），**不是可复跑入口**，只作原始输出留证；可复跑的那个是
`verify-native-hk.mjs`。
