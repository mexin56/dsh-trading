# @dshtrading/connector-bybit

Bybit v5 加密货币连接器（crypto 市场）：实现 `@dshtrading/api` 的 `MarketDataService`
（现货 ∪ 线性永续公共行情），并把一个 TradeService 占位实现注册进路由交易面——
三态闸门与私有账户读面的失败关闭语义保留，**私有账户面与真实下单均未实现**。
凭证走 BYOK：配置里只出现环境变量名，不出现值。

## 状态

**部分实证（上游可达性受出口地区限制）**。

- **2026-10-08 可达出口复验**（commit `25d18c7bbbc7191951b82fbc263b9deafe4d64e0`，
  出口 SG `188.253.121.148`）：20 条判据全过、探针退出码 0，含线性合约真值
  （`TSLAUSDT-SWAP` 374.34/374.21、`BTCUSDT-SWAP` 82339.7）与 `crypto_get_ticker`
  底层服务路径的真价。证据 [EVIDENCE-reverify-2026-10-08.md](../../spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md)。
- **同一 commit 记录的地域封锁**：本机默认出口（美国节点 `216.195.208.136`）对
  `api.bybit.com` 全量 **HTTP 403**（`api.bytick.com` / `api-demo.bybit.com` /
  `api.bybit.nl` 同样；经 `-x http://127.0.0.1:7890` 仍是同一出口 IP、仍 403），
  响应体自证 `The Amazon CloudFront distribution is configured to block access from your country`；
  换 SG/JP/HK/TW/DE/KR/GB 出口后同一端点全部 200。证据
  [EVIDENCE-P3-bybit-ccxt.md](../../spikes/impl-crypto-perp-tradfi/EVIDENCE-P3-bybit-ccxt.md) 第 1 节，
  原始响应 `bybit-egress-blocked-*.json` / `.headers` 同目录。
- **更早、当时本出口可达的实证**：2026-08-31 评审随测 bybit ticker `BTCUSDT` 77773、
  5m K 线 8 根（[verify-connectors-suite/EVIDENCE.md](../../spikes/verify-connectors-suite/EVIDENCE.md)
  第 6/7 项）；2026-09-02 盘口与逐笔
  （[impl-orderbook-ticks/EVIDENCE.md](../../spikes/impl-orderbook-ticks/EVIDENCE.md)，
  原始响应 `bybit-orderbook-raw.json`）；2026-09-02 衍生品子查询
  （[impl-crypto-derivatives/EVIDENCE.md](../../spikes/impl-crypto-derivatives/EVIDENCE.md)）。
- **未实证**：签名私有账户读面、真实下单与撤单——源码内没有对应实现（见「已知边界」）。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器；`false` 时 `apply` 立即返回 |
| `dryRun` | `true` | 强制模拟下单：为 `true` 时即使 `liveTrading=true` 且请求 `dryRun=false`，也只回本地模拟回执 |
| `liveTrading` | `false` | 实盘开关的**非权威镜像**；真正授权由 `@dshtrading/authority` 的人工签署平面裁定 |
| `apiKeyRef` | `'BYBIT_API_KEY'` | API Key 的**环境变量名**（BYOK）；`apply` 时 `process.env[apiKeyRef]` 取值 |
| `secretRef` | `'BYBIT_SECRET_KEY'` | Secret 的环境变量名；值只存进客户端字段，**不参与任何签名**（当前无签名路径）。设置页自 2026-10-15 起也不再挂凭据卡片——填了到不了请求，见「已知边界」第 3 条 |

依据：`src/index.ts:47-53`（schema 与默认值）、`src/index.ts:281-282`（环境变量读取）、
`src/rest.ts:205-210`（baseUrl 与凭证字段）、`src/rest.ts:215-217`（请求头只有 `Accept`）。

## 接线

- **数据面行**：`packages/crypto/cordis.patch.yml:32-34` → 行 id `dsh-trading-crypto-dataplane-bybit`，
  模块 `@dshtrading/connector-bybit/dataplane`。该入口把 `(crypto, bybit)` 注册进
  `tradingMarketDataRegistry`（`src/dataplane.ts:49`）与 `tradingTradeRegistry`（`src/dataplane.ts:55`），
  **不注册任何工具**。
- **preset 行**：`packages/crypto/assets/preset/crypto-trader/agent.cordis.yml:65-77` → isolate 组
  id `dsh-trading-crypto-connector-bybit-group`（isolate `tradingCryptoMarketData` 与
  `tradingCryptoTrade`），内层行 id `dsh-trading-crypto-connector-bybit`（第 72-73 行），
  行内只写 `enabled: true` / `dryRun: true` / `liveTrading: false`（schema 默认值由本模块导出的
  `Config` 补全，见 `src/dataplane.ts:16`）。
- **服务键**：`tradingCryptoMarketData`（`src/index.ts:55`）、`tradingCryptoTrade`（`src/index.ts:56`）。
- **provider 词汇**：`packages/router/src/index.ts:65` 登记 `bybit`。
- **设置页显示名与提示**：`PROVIDER_LABELS` 的 `bybit` 条目
  （`packages/client-ui-settings/src/client/trading-settings-controller.ts:45`：`type: 'public'`、
  `env: 'BYBIT_API_KEY'`、`markets: ['crypto']`）与 `packages/client-ui-settings/src/client/locales.ts`
  的 `'provider.bybit'` 条目（zh / en 都是 `Bybit`）。`env` 与「配置」表里 `apiKeyRef` 的 schema
  默认名同名（`src/index.ts:52`）——设置页文案与连接器读取的环境变量名同源。**凭据卡片已撤**
  （2026-10-15）：本包只从 env 取值且没有任何签名出站路径，面板填的 key 到不了请求，
  撤字段的理由与对照见[设置页凭据面收窄](../../.agents/notes/implemented/simplification/2026-10-15-settings-credential-surface-narrowed.md)。
- **profile overrides**：`node scripts/sync-profile-overrides.mjs --all --dsh-home ~/.dsh-trading`
  （注意 `--dsh-home`；宿主会话继承的 `DSH_HOME` 指向别处会找错 profile 集）。

用户切换：设置 → 数据源 → crypto → Bybit。

## 上游端点

全部打在同一个 baseUrl（`src/rest.ts:206`，`https://api.bybit.com`）上；无模拟盘域名；
所有请求只带 `Accept: application/json`（`src/rest.ts:215-217`），不带签名头。

| 用途 | 端点 | 源码行 |
|---|---|---|
| 行情快照 | `GET /v5/market/tickers?category={spot 或 linear}&symbol=` | `src/rest.ts:251` |
| K 线 | `GET /v5/market/kline?category={spot 或 linear}&symbol=&interval=&limit=` | `src/rest.ts:287` |
| 标的名册 | `GET /v5/market/instruments-info?category={spot 或 linear}&limit=1000&cursor=`（游标翻页） | `src/rest.ts:312` |
| 线性合约快照（fundingRate / openInterest / openInterestValue / markPrice / indexPrice / nextFundingTime） | `GET /v5/market/tickers?category=linear&symbol=` | `src/rest.ts:387` |
| 多空账户人数比 | `GET /v5/market/account-ratio?category=linear&symbol=&period=1h&limit=1` | `src/rest.ts:417` |
| 资金费率历史 | `GET /v5/market/funding/history?category=linear&symbol=&limit=`（上限 100） | `src/rest.ts:441` |
| 持仓量历史 | `GET /v5/market/open-interest?category=linear&symbol=&intervalTime=1d&limit=`（上限 50） | `src/rest.ts:466` |
| 盘口（25 档） | `GET /v5/market/orderbook?category={spot 或 linear}&symbol=&limit=25` | `src/rest.ts:501` |
| 最近逐笔成交 | `GET /v5/market/recent-trade?category={spot 或 linear}&symbol=&limit=`（上限 60） | `src/rest.ts:537` |

上表是源码里出现过的全部上游请求；本包没有 `api.bybit.com` 之外的任何主机。

## 周期与契约

- **周期词汇**：`1m / 5m / 15m / 30m / 1h / 4h / 1d / 1w / 1M`（`src/rest.ts:38`），
  映射到 Bybit 的 `1 / 5 / 15 / 30 / 60 / 240 / D / W / M`（`src/rest.ts:40-52`）。
  词汇表外的值在类型层即不可表达，不做静默降级。
- **符号形态**：`parseCryptoSymbol`（`src/rest.ts:83-88`）去空白、转大写、剥掉整段 `-SWAP`、
  删 `- _ /` 分隔符；形态由 `@dshtrading/api` 的 `instrumentFormOf` 裁决（连接器不自写后缀判断）。
  规范输出：现货 `BTCUSDT`，永续 `BTCUSDT-SWAP`。空符号 → `TRADING_INVALID_ARGUMENT`（`src/rest.ts:86`）。
- **形态即 category**：`perp → linear`、`spot → spot`（`src/rest.ts:101-103`）。
  ticker / klines / orderbook / recent-trade 四条路径共用这一处分岔，
  **`-SWAP` 不会被静默打到现货端点**（回归由 `test/perp-market-data.test.ts` 按 URL 断言）。
- **错误映射**（`src/rest.ts:212-230`）：非 2xx → `TRADING_UPSTREAM_ERROR`；fetch 抛错 →
  `TRADING_NETWORK`。业务层：ticker 命中空列表或 `retCode≠0` → `TRADING_UNSUPPORTED_SYMBOL`
  （`src/rest.ts:253-257`；Bybit 对不存在的标的回 `retCode:0` + 空列表）；
  名册 / 盘口 / 逐笔 / 费率历史 / OI 历史的响应形状异常 → `TRADING_EXCHANGE_ERROR`。
- **例外（已知缺口）**：K 线在 `retCode≠0` 或缺 `result.list` 时返回**空数组**而不是结构化错误
  （`src/rest.ts:289-291`）。
- **缺省纪律**：上游空串不当 0（`src/rest.ts:106-112`）；合约元数据字段缺失即缺省
  （`src/rest.ts:119-136`）；`assetClass` 只由交易所 `symbolType` 字面量裁决，
  空串与未登记取值（`forex` / `mstocks`）一律留空，不按符号猜（`src/rest.ts:153-166`）。
- **名册口径**：现货 ∪ 线性永续，只收 `status=Trading`，线性侧还要求
  `contractType=LinearPerpetual`（`src/rest.ts:347-364`）；翻页带重复游标守卫（`src/rest.ts:326-341`）。

## 能力面

服务方法（`BybitMarketDataService` / `BybitTradeService`）：

| 方法 | 有/缺席 | 说明 |
|---|---|---|
| `getTicker` | 有 | 现货与线性永续，输出规范形（`src/index.ts:70`） |
| `getKlines` | 有 | 同上形态分岔（`src/index.ts:74`） |
| `listInstruments` | 有 | 现货 ∪ 线性永续名册，带 `form` 与 `contract`（`src/index.ts:84`） |
| `subscribeTicker` | 有 | 快照轮询，最小 1000 ms、缺省 5000 ms（`src/index.ts:88-96`） |
| `getOrderbook` | 有 | 25 档（`src/index.ts:99`） |
| `getRecentTrades` | 有 | 时间升序，上限 60（`src/index.ts:104`） |
| `getDerivatives` | 有 | 单所聚合快照，子查询失败只降级对应字段（`src/index.ts:114`） |
| `getDerivativesHistory` | 有 | 费率 + OI 双序列，单序列失败即该字段缺省（`src/index.ts:160`） |
| `placeOrder` | 有（模拟） | 三态闸门；模拟回执由服务层本地合成（`src/index.ts:205-232`） |
| `cancelOrder` | 有（受限） | 未获实盘授权或 `dryRun=true` 时结构化拒绝（`src/index.ts:234-242`） |
| `getOrder` | 有（失败关闭） | 恒抛 `TRADING_NOT_IMPLEMENTED`（`src/index.ts:251-257`） |
| `getPositions` | 有（失败关闭） | 恒抛 `TRADING_NOT_IMPLEMENTED`（`src/index.ts:259-265`） |
| `getBalances` / `listOpenOrders` / `listTradeFills` | 缺席 | 可选方法未定义，消费方按「缺席」处理 |
| `setLeverage` | 缺席 | 未定义 |

工具（`apply` 内注册，duplicate-safe，`src/index.ts:294-317`）：

| 工具 | 参数 | 说明 |
|---|---|---|
| `crypto_get_ticker` | `symbol`（必填） | 现货形取现货、`-SWAP` 形取线性永续 |
| `crypto_get_klines` | `symbol` / `interval`（枚举 = 周期词汇，缺省 `1d`）/ `limit`（缺省 100） | 同上形态分岔 |

**本包只注册这 2 个工具**：盘口、逐笔、名册、衍生品快照与历史只在服务面可达，
没有对应工具名；交易面同样没有注册任何工具（唯一可达面是动态包 `inject` 直调服务）。

## 已知边界

1. **live 下单路径仍是本地 sim stub**：闸门③放行后调用 `BybitRestClient.placeOrder`
   （`src/rest.ts:546-559`），它不触网、返回 `sim-bybit-*` 回执且 `dryRun: true`；
   `cancelOrder` 同理返回 `{orderId, status:'canceled'}`（`src/rest.ts:561-563`）。
   当前没有 Bybit 下单工具、GUI 桥强制 `dryRun=true`，可达面只有动态包 `inject` 直调。
   见 [fabricated-trade-surface-fail-closed.md](../../.agents/notes/implemented/simplification/2026-10-10-fabricated-trade-surface-fail-closed.md)。
2. **私有账户读面失败关闭**：`getOrder` / `getPositions` 抛 `TRADING_NOT_IMPLEMENTED`
   （语义是「不可用」，不是「订单不存在」或「没有持仓」）；`getBalances` / `listOpenOrders` /
   `listTradeFills` 直接缺席。此前硬编码的 100000 余额与恒空数组已删除，见同一份 Note。
3. **凭证不参与签名（设置页凭据卡片已撤）**：`apiKeyRef` / `secretRef` 解析出的值只存进客户端字段
   （`src/rest.ts:206-207`），全部请求走免密公共端点；本包没有任何签名实现，`placeOrder` 的
   `_creds` 形参被忽略（`src/rest.ts:546`）。设置页原先挂的 `apiKey` / `apiSecret` 卡片因此与
   ccxt / binance 同批撤下（2026-10-15）——面板写的键不落任何请求；`BYBIT_API_KEY` 环境变量仍是
   连接器自己的取值面。理由与对照见[设置页凭据面收窄](../../.agents/notes/implemented/simplification/2026-10-15-settings-credential-surface-narrowed.md)。
4. **K 线错误静默为空数组**（`src/rest.ts:289-291`），不抛结构化错误。
5. **地域封锁（实测）**：默认出口对 `api.bybit.com` 全量 403，换出口地区才可达，
   见「状态」段的证据与日期。这是上游按出口国家的拦截，不是本包可控项。
6. **类型存量债**：本包 `tsconfig.json` 有 12 条 tsc 错误记在
   `scripts/typecheck-baseline.json:35`（棘轮基线内的旧债，本 README 不改动）。

## 合规记录

- Bybit 公共行情端点：公开、免密；本包不内置密钥，不把凭证值写进日志或回执。
- 凭证只以**环境变量名**（ref）形式出现在配置与仓库里；值在 `apply` 时读入进程内存，
  只传给 REST 客户端字段，不参与签名、不外发（见「配置」与「已知边界」第 3 条）。
- 本仓不缓存、不再分发行情数据。
- 地域拦截由上游按出口国家实施（响应体自证 CloudFront）；换出口属**用户侧环境选择**，
  不是仓库配置的一部分（`EVIDENCE-reverify-2026-10-08.md` 第 2 节原文：出口地区是机器状态）。
- 许可：`PolyForm-Noncommercial-1.0.0`（`package.json`）。
- 本包是数据与执行通道的技术实现，不构成投资建议。

## 出网验证

```sh
node_modules/.bin/tsx spikes/impl-crypto-perp-tradfi/run-reverify-probe.ts   # 20 条判据，需可达出口
node spikes/impl-crypto-derivatives/run-derivatives-probe.mjs               # 衍生品子查询与解析
node spikes/impl-orderbook-ticks/run-orderbook-probe.mjs                     # 盘口与逐笔原始响应
pnpm --filter @dshtrading/connector-bybit test                              # 离线：闸门三态/名册/形态/账户读面
```

- 前置：可达出口（默认出口对 `api.bybit.com` 返回 403）。`run-reverify-probe.ts`
  经本机 mihomo 控制器切地域节点，探针自带还原 trap。
- **三态闸门与账户读面的证据是离线测试**（`test/trade-gate.test.ts` 6 例、
  `test/account-read-surface.test.ts` 5 例），不含真实下单。
- 真实网络下的服务缝闸门验证只覆盖 okx（
  [impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md)）；
  Bybit 的服务缝行为由上述离线矩阵覆盖，未对 Bybit 做真实下单验证。

## 参见

- Owning Note：[crypto-perp-data-plane-bybit-ccxt.md](../../.agents/notes/implemented/feature/2026-10-08-crypto-perp-data-plane-bybit-ccxt.md)
- 设计与卡拆分：[crypto-perp-and-tradfi.md](../../docs/roadmap/crypto-perp-and-tradfi.md)（P3）
- 全仓当前状态与硬停：[docs/current-state.md](../../docs/current-state.md)
- 连接器横向对照：[connectors-guide.md](../../docs/guides/connectors-guide.md)
