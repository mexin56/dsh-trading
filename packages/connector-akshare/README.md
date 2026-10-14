# @dshtrading/connector-akshare

A 股宏观/另类数据连接器：包名取 AkShare，**实现面是东方财富公开 REST 直连**
（`push2` / `push2his` 两域）。只提供 `tradingCnMarketData` 一个服务与 3 个 `cn_*` 工具，
无交易通道（`src/index.ts` 无 TradeService、无 `tradingCnTrade`）。
配置项 `apiUrl` 当前没有任何请求消费者，详见「已知边界」。

## 状态

**未实证（本出口当前不可用）**。

2026-10-14 本次会话实测，上游 push2 域不可达：

    curl -m 15 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.600519&fields=f1,f2,f14'
    # curl: (52) Empty reply from server

同刻连接器经 `RestClient.getSectorFundFlow()` 表现为 `TradingServiceError`，code `TRADING_NETWORK`
（`fetch failed`）。该现象与 `packages/connector-eastmoney/README.md`「已知边界」记录的 push2 整域空回一致。

本仓唯一一份 akshare 真实网络记录是 [spikes/verify-connectors-suite/EVIDENCE.md](../../spikes/verify-connectors-suite/EVIDENCE.md)
（2026-08-31，针对 commit `b80000e`，import `lib/index.js` 直调各包 Rest 客户端）：
板块资金流返回 10 条，但当时 `changePercent` 少除 100（现 `src/rest.ts:171` 已除 100）；
北向资金接口当时恒返回 0 条（该工具与该能力现已从源码移除，当前 `src/` 无 `getNorthboundFlow`）。
报价与日 K 走同一组东财端点，该组端点的 2026-10-14 实测记录在
[spikes/impl-eastmoney-quote-endpoint/](../../spikes/impl-eastmoney-quote-endpoint/)（由 `src/rest.ts:111-113` 引用）。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器（`src/index.ts:33`） |
| `apiUrl` | `'http://127.0.0.1:8080'`（`src/index.ts:34`）；env `AKSHARE_API_URL` 可覆盖（`src/rest.ts:86`） | AkShare 本地 RPC/HTTP 服务地址；**当前无请求消费者**，见「已知边界」 |

## 接线

- **数据面行**：`packages/cn/cordis.patch.yml:35-38` → 行 id `dsh-trading-cn-dataplane-akshare`
  （name `@dshtrading/connector-akshare/dataplane`，行 config 只写 `enabled: true`）。
  注册 `(cn, akshare)` 进 `tradingMarketDataRegistry`（`src/dataplane.ts:36`），不占根市场键。
- **preset 行**：`packages/cn/assets/preset/cn-trader/agent.cordis.yml:62-67` → 行 id
  `dsh-trading-cn-connector-akshare`（`config: {enabled: true, dryRun: true, liveTrading: false}`）。
- **bundle 依赖**：`packages/cn/package.json:31` 的 `"@dshtrading/connector-akshare": "workspace:*"`。
- **provider 词汇**：`packages/router/src/index.ts:77`（`PROVIDER_VOCABULARY` 成员）与
  `src/index.ts:74` 的 `ROUTER_PROVIDER = 'akshare'` 同名。
- **服务键**：`tradingCnMarketData`（`src/index.ts:37`；dataplane 侧 isolate 同名，`src/dataplane.ts:34`）。
- **激活判定**：`routeAllows`（`src/index.ts:76-81`）——`enabled` 为真、且 router 的 `cn` 路由选中
  `akshare` 才 provide；router 缺席时视为允许。
- **设置页显示名**：`packages/client-ui-settings/src/client/locales.ts:252`（zh `AkShare (宏观/另类量化)`）与
  `:398`（en `AkShare (macro / alt-data)`）；凭证字段声明在
  `packages/client-ui-settings/src/client/trading-settings-controller.ts:42`，其 `markets` 标的是
  `['cn', 'hk']`，而本连接器只在 `cn` 注册（`src/dataplane.ts:25`）——标签宽于实现。

## 上游端点

| 用途 | 端点 | 源码 |
|---|---|---|
| 报价（单只与批量同端点） | `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=<secid>&fields=f1,f2,f3,f5,f12,f13,f14,f18,f124` | `src/rest.ts:45,114` |
| K 线 | `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=<secid>&klt=<klt>&fqt=1&lmt=<limit>&fields2=f51,f52,f53,f54,f55,f56` | `src/rest.ts:146` |
| 板块资金流（东财行业板块 `fs=m:90+t:2`，固定取前 10） | `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fields=f12,f14,f3,f62&fs=m:90+t:2` | `src/rest.ts:166` |

## 周期与契约

- **周期词汇**：`INTERVAL_VOCABULARY = ['1m','5m','15m','30m','1h','1d','1w','1M']`（`src/rest.ts:24`），
  同一数组进 `cn_get_klines` 的 `interval` 枚举（`src/index.ts:110`）。
- **`klt` 映射只覆盖 4 个周期**（`src/rest.ts:145`）：`5m→5`、`15m→15`、`30m→30`、`1h→60`，
  **其余含 `1m`/`1d`/`1w`/`1M` 一律落 `klt=101`（日线）且不报错**——`1m`/`1w`/`1M` 会被静默按日线返回，
  不抛 `TRADING_UNSUPPORTED_INTERVAL`。
- **符号形态**（`toEastmoneySecid`，`src/rest.ts:26-39`）：含 `.` 时 `.<市场>` 原样取（`600519.SH`）；
  裸 6 位不以 `0`/`3` 开头视为 `SH`、以 `0`/`3` 开头视为 `SZ`；输出规范形 `<code>.<MARKET>`，
  东财 `secid` = `<SH→1，其余→0>.<code>`。不接受 `sh600519` 前缀形（会拼成 `1.SH600519`），
  也不做市场白名单或显式拒绝。
- **取价按行**：`price = f2 / 10^f1`；`f1` 缺失或不在 `0..6` 时回落市场级 `×100`（`src/rest.ts:63-74,123-125`）。
- **错误映射**（`src/rest.ts:90-107,119-121`）：非 2xx → `TRADING_UPSTREAM_ERROR`；
  不可达与响应非 JSON 均 → `TRADING_NETWORK`；报价端点少返回行（`data.diff` 空或 `data` 为 `null`）
  → `TRADING_SYMBOL_NOT_FOUND`；`getSectorFundFlow` 对空结果返回 `[]`，不报错。

## 能力面

| 服务方法 | 本包实现 | 工具暴露 |
|---|---|---|
| `getTicker` | 有（`src/index.ts:51`） | `cn_get_ticker`（`src/index.ts:96`） |
| `getKlines` | 有（`src/index.ts:55`） | `cn_get_klines`（`src/index.ts:106`） |
| `getSectorFundFlow` | 有（`src/index.ts:59`） | `cn_get_sector_fund_flow`（`src/index.ts:121`） |
| `subscribeTicker`（快照轮询，最小 1000 ms、默认 5000 ms） | 有（`src/index.ts:63-71`） | 缺席 |
| `listInstruments` / 盘口 / 基本面 | 未实现 | 未实现 |
| TradeService（下单 / 撤单 / 持仓 / 资金） | 未实现（本包无 `tradingCnTrade`） | 未实现 |

## 已知边界

- **`apiUrl` 是死配置**：`src/rest.ts:82,86` 只保存该值，三个请求方法全部硬编码东财 URL
  （`src/rest.ts:114,146,166`）——包名里的 AkShare / Python 本地服务当前完全不参与取数。
- **分钟 K 的 `closeTime` 按日线口径算**：`openTime + 86400000 - 1`（`src/rest.ts:160`），
  5m/15m/30m/1h 也一样加满一天。
- **`openTime` 按本地时区解析**：`new Date(parts[0].replace(/-/g, '/'))`（`src/rest.ts:152`）。
- 板块资金流固定 `pz=10`（只回前 10 个板块，`src/rest.ts:166`）；`changePercent` 由 `f3/100` 得到
  （`src/rest.ts:171`），`mainNetInflow` 直接取 `f62`，单位未换算（`src/rest.ts:172`）。
- 无 `listInstruments`、盘口、基本面、主动买盘能力（同市场的 eastmoney、xysz 各有对照实现）。
- 2026-10-14 本出口对 `push2.eastmoney.com` 不可达（`curl: (52) Empty reply from server`），
  故「状态」段按未实证处理。

## 合规记录

**东方财富公开端点**：无 key、无官方授权，个人使用边界自负，以东方财富服务条款为准。
本次会话实测该端点不可达；`apiUrl` 指向的 AkShare 本地服务当前未被调用，若将来启用，
其上游 AkShare / Python 库的条款另行适用。本仓不缓存、不再分发行情数据。

## 出网验证

本包暂无已提交的独立出网验证脚本（`spikes/` 下无 akshare 专属探针；上文引的两份是跨连接器随测与东财端点实测）。
最小复跑方式（与仓内探针纪律一致：`tsx` 直跑 `src/*.ts`，不依赖 `lib/` 构建产物）：

```sh
# 板块资金流（单次请求；上游空结果返回 []，不报错）
./node_modules/.bin/tsx -e "import('./packages/connector-akshare/src/rest.ts').then(async m => console.log(JSON.stringify(await new m.AkshareRestClient().getSectorFundFlow())))"

# 报价（走 push2 ulist.np/get，单只）
./node_modules/.bin/tsx -e "import('./packages/connector-akshare/src/rest.ts').then(async m => console.log(JSON.stringify(await new m.AkshareRestClient().getTicker('600519.SH'))))"
```

2026-10-14 本次会话下，上述第一条落在 `TRADING_NETWORK: fetch failed`。
