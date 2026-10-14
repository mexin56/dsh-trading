# @dshtrading/connector-ccxt

加密现货连接器（crypto 市场），沿用 CCXT 的交易所词汇做**多所免密行情**：
实现 `@dshtrading/api` 的 `MarketDataService`，并提供按所切换的行情快照与 K 线。
本包**不依赖也不打包 `ccxt` 库**，也没有合约（永续/交割）面——`-SWAP` 入参显式拒绝。
交易面保留服务缝三态闸门，但账户读面与真实下单均未实现。

## 状态

**部分实证（仅 2026-08-31 一轮，且只覆盖现货链路的两个点）**。

- **2026-08-31 评审随测**（对象 commit `b80000e`）：ccxt binance ticker `BTCUSDT`
  77767.66（第 8 项）、ccxt 切 bybit 所的 klines `ETHUSDT` 5m 8 根 close 2420.08（第 9 项）——
  两项均为真实网络调用、无 stub。证据
  [verify-connectors-suite/EVIDENCE.md](../../spikes/verify-connectors-suite/EVIDENCE.md)。
  注意第 9 项走的是 **Binance 端点**：`getKlines` 不使用 `exchange` 参数（见「已知边界」第 2 条）。
- **该 spike 目录只提交了 EVIDENCE.md**，随测脚本未入仓（`git ls-files spikes/verify-connectors-suite`
  只有一份 EVIDENCE.md），因此**没有可直接复跑的出网脚本**。
- **本包在 2026-10-08 的可达出口窗口内未复验**：同一窗口的记录显示本机默认出口对
  `api.binance.com` 返回 HTTP 451、对 `api.bybit.com` 返回 HTTP 403，换 SG/JP/HK/TW/DE/KR/GB
  出口后可达（[EVIDENCE-reverify-2026-10-08.md](../../spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md)
  第 1/2 节、[EVIDENCE-P3-bybit-ccxt.md](../../spikes/impl-crypto-perp-tradfi/EVIDENCE-P3-bybit-ccxt.md) 第 1 节）。
  这些结论是 Bybit/Binance 端点级的，不是在本包上跑出来的——**本包当前的出口可达性未实证**。
- **未实证**：bybit / okx 两个分支的真实网络行为（okx 分支完全没有网络实证记录）。
- **未实现**（不是未实证）：9 个所名词汇中 6 个没有实现分支、K 线的按所切换、
  私有账户读面与真实下单。逐条见「已知边界」。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器；`false` 时 `apply` 立即返回 |
| `env` | `'demo'` | 类型面声明 `demo`/`live`；**当前没有任何代码读它**，无模拟盘域名或请求头切换 |
| `dryRun` | `true` | 强制模拟下单：为 `true` 时即使 `liveTrading=true` 且请求 `dryRun=false`，也只回本地模拟回执 |
| `liveTrading` | `false` | 实盘开关的**非权威镜像**；真正授权由 `@dshtrading/authority` 的人工签署平面裁定 |
| `defaultExchange` | `'binance'` | 首选所名（必须落在 `SUPPORTED_EXCHANGES` 词汇内）；传给 REST 客户端作为默认 `exchange` |

依据：`src/index.ts:43-49`（schema 与默认值）、`src/index.ts:167-168`（只把 `defaultExchange`
传给客户端）。**本包没有凭证字段**——`Config` 里没有 key/secret ref，
`apply` 也不读任何环境变量；所有请求都是免密公共端点。
设置页另存着 `CCXT_API_KEY` / `CCXT_API_SECRET` 占位（
`packages/client-ui-settings/src/client/locales.ts:283-284`、
`trading-settings-controller.ts:29`），但本连接器从不读取它们（见「已知边界」第 6 条）。

## 接线

- **数据面行**：`packages/crypto/cordis.patch.yml:36-38` → 行 id `dsh-trading-crypto-dataplane-ccxt`，
  模块 `@dshtrading/connector-ccxt/dataplane`。该入口只把 `(crypto, ccxt)` 注册进
  `tradingMarketDataRegistry`（`src/dataplane.ts:49`），**既不注册交易面也不注册工具**。
- **preset 行**：`packages/crypto/assets/preset/crypto-trader/agent.cordis.yml:79-90` → isolate 组
  id `dsh-trading-crypto-connector-ccxt-group`（isolate `tradingCryptoMarketData` 与
  `tradingCryptoTrade`），内层行 id `dsh-trading-crypto-connector-ccxt`（第 86-87 行），
  行内只写 `enabled: true` / `dryRun: true` / `liveTrading: false`。
  交易服务只在 preset 主入口构造（`src/index.ts:168`），**不经 `tradingTradeRegistry`**。
- **服务键**：`tradingCryptoMarketData`（`src/index.ts:51`）、`tradingCryptoTrade`（`src/index.ts:52`）。
- **provider 词汇**：`packages/router/src/index.ts:66` 登记 `ccxt`。
- **设置页显示名**：`packages/client-ui-settings/src/client/locales.ts:241`（中文
  `CCXT (跨所聚合 100+)`）与 `:387`（英文）；交易所条目 `trading-settings-controller.ts:29`。
- **profile overrides**：`node scripts/sync-profile-overrides.mjs --all --dsh-home ~/.dsh-trading`
  （注意 `--dsh-home`；宿主会话继承的 `DSH_HOME` 指向别处会找错 profile 集）。

用户切换：设置 → 数据源 → crypto → CCXT。

## 上游端点

| 用途 | 端点 | 源码行 |
|---|---|---|
| 快照（`exchange=bybit`） | `GET https://api.bybit.com/v5/market/tickers?category=spot&symbol=` | `src/rest.ts:105` |
| 快照（`exchange=okx`） | `GET https://www.okx.com/api/v5/market/ticker?instId=` | `src/rest.ts:118` |
| 快照（其余所有所名） | `GET https://api.binance.com/api/v3/ticker/24hr?symbol=` | `src/rest.ts:130` |
| K 线（任何所名） | `GET https://api.binance.com/api/v3/klines?symbol=&interval=&limit=` | `src/rest.ts:142` |

只有这三个主机；所有请求只带 `Accept: application/json`（`src/rest.ts:85-87`），无签名头。
`SUPPORTED_EXCHANGES`（`src/rest.ts:31-41`）登记 `binance / okx / bybit / gateio / kucoin /
kraken / coinbase / bitfinex / htx` 共 9 个所名，但**只有 binance、okx、bybit 三条分支**：
其余 6 个落进 Binance 兜底分支（见「已知边界」第 1 条）。

## 周期与契约

- **周期词汇**：`1m / 5m / 15m / 30m / 1h / 4h / 1d / 1w / 1M`（`src/rest.ts:29`）。
  没有映射表——词汇原文直接作为 Binance `interval` 参数发出（`src/rest.ts:142`），
  即 `1M` 就是 Binance 的月线。词汇表外的值在类型层即不可表达。
- **现货限定**：`normalizeSymbol`（`src/rest.ts:50-61`）先转大写；形态由 `@dshtrading/api` 的
  `instrumentFormOf` 裁决，命中永续形态即抛 `TRADING_UNSUPPORTED_SYMBOL`，**不剥后缀、不发任何请求**；
  随后删 `-`/`_` 分隔符、去掉 `/`。返回值是该所侧的裸符号（如 `BTCUSDT`），
  也就是响应里的 `symbol` 字段。
- **错误映射**（`src/rest.ts:83-100`）：非 2xx → `TRADING_UPSTREAM_ERROR`；fetch 抛错 →
  `TRADING_NETWORK`。bybit / okx 分支命中空列表 → `TRADING_SYMBOL_NOT_FOUND`
  （`src/rest.ts:108`、`:121`）；binance 兜底分支没有行级判空，非法符号由上游 HTTP 400
  映射成 `TRADING_UPSTREAM_ERROR`——两条路径的错误码不对称。
- **K 线解析**：按 Binance 数组行解析 `[openTime, open, high, low, close, volume, closeTime]`
  （`src/rest.ts:145-153`），非数组响应返回空数组（`src/rest.ts:144`）。
- **快照字段**：只回 `symbol / price / volume / timestamp`（`src/rest.ts:109-114`、`:122-127`、
  `:132-137`）；bybit 与 binance 分支的 `timestamp` 取本地 `Date.now()`（bybit）
  或上游 `closeTime`（binance），okx 取上游 `ts`——三条路径的时间戳来源不同。

## 能力面

服务方法（`CcxtMarketDataService` / `CcxtTradeService`）：

| 方法 | 有/缺席 | 说明 |
|---|---|---|
| `getTicker` | 有 | 第二参数 `exchange` 生效：bybit / okx / 其余兜底 Binance（`src/index.ts:66`） |
| `getKlines` | 有 | **`exchange` 参数被忽略**，恒打 Binance（`src/index.ts:70`） |
| `subscribeTicker` | 有 | 快照轮询，最小 1000 ms、缺省 5000 ms（`src/index.ts:74-82`） |
| `listInstruments` | 缺席 | 未实现，调用方按可选方法缺席处理 |
| `getOrderbook` / `getRecentTrades` | 缺席 | 未实现 |
| `getDerivatives` / `getDerivativesHistory` | 缺席 | 未实现 |
| `placeOrder` | 有（模拟） | 三态闸门；模拟回执由服务层本地合成（`src/index.ts:104-131`） |
| `cancelOrder` | 有（受限） | 未获实盘授权或 `dryRun=true` 时结构化拒绝（`src/index.ts:133-143`） |
| `getBalance` | 有（**非契约、编造值**） | 恒回 `{currency:'USDT', available:100000, total:100000}`（`src/index.ts:100-102` → `src/rest.ts:156-158`） |
| `getPositions` | 有（**恒空**） | 契约必需方法，恒回 `[]`（`src/index.ts:145-147`） |
| `getOrders` | 有（**非契约、恒空**） | 不在 `TradeService` 词汇内，恒回 `[]`（`src/index.ts:149-151`） |
| `getOrder` | 缺席 | `TradeService` 的必需方法，类体内没有该成员（`src/index.ts:85-152`） |
| `getBalances` / `listOpenOrders` / `listTradeFills` / `setLeverage` | 缺席 | 可选方法未定义 |

工具（`apply` 内注册，duplicate-safe，`src/index.ts:176-203`）：

| 工具 | 参数 | 说明 |
|---|---|---|
| `crypto_get_ticker` | `symbol`（必填）/ `exchange`（枚举 = 9 个所名，缺省 `binance`） | 注册描述自称覆盖 100+ 所，实现只有 3 条分支 |
| `crypto_get_klines` | `symbol` / `interval`（枚举 = 周期词汇，缺省 `1d`）/ `limit`（缺省 100）/ `exchange` | `exchange` 在实现中被忽略，恒打 Binance |

**本包只注册这 2 个工具**，且都是行情工具；交易面没有注册任何工具。

## 已知边界

1. **9 个所名只有 3 条实现分支**：`getTicker` 里只有 `bybit`、`okx` 两个具名分支，
   其余（含 `binance`、`gateio`、`kucoin`、`kraken`、`coinbase`、`bitfinex`、`htx`）
   一律落到 Binance 兜底 URL（`src/rest.ts:104-137`）。选 `kraken` 会拿到 Binance 的报价，
   **没有任何提示**。工具描述「across 100+ exchanges」（`src/index.ts:178`）与设置页显示名
   `CCXT (跨所聚合 100+)`（`locales.ts:241`）都比实现宽。
2. **`getKlines` 忽略 `exchange`**：`exchange` 是形参但未参与 URL 构造
   （`src/rest.ts:140-143`），任何所名的 K 线都来自 `api.binance.com`。
3. **不是通用 CCXT 大包**：`package.json` 的 dependencies 只有 `@dshtrading/authority` 与
   `@dshtrading/api`，**没有 `ccxt` 依赖**；本包是自写的 3 条直连分支，只沿用 CCXT 的所名词汇。
4. **现货限定**：`-SWAP` 入参抛 `TRADING_UNSUPPORTED_SYMBOL` 且零网络请求
   （`src/rest.ts:50-61`，回归见 `test/spot-only-form.test.ts`）；本包没有合约面，
   需要永续报价应换 bybit / okx 连接器。
5. **账户读面是编造值**：`getBalance` 恒回 100000 USDT、`getPositions` 恒回空数组、
   `getOrders` 恒回空数组（`src/index.ts:100-102`、`:145-151`）。与 Bybit 包已做的
   「失败关闭」不同，本包这三处尚未清理；可选方法 `getBalances` / `listOpenOrders` /
   `listTradeFills` 缺席，必需方法 `getOrder` 缺失。
6. **凭证字段缺失**：设置页为 ccxt 存 `CCXT_API_KEY` / `CCXT_API_SECRET` 占位，
   但连接器既不声明凭证字段也不读环境变量（`src/index.ts:43-49`、`:167-168`）——
   填了不生效。
7. **live 下单路径是本地 sim stub**：闸门③放行后 `CcxtRestClient.placeOrder`
   返回 `sim-ccxt-*` 回执（`src/rest.ts:160-173`），不触网。
8. **`env` 未接线**：无模拟盘域名与请求头，`env=demo` 不改变任何请求目标。
9. **地域限制由上游实施**：默认出口对 `api.binance.com` 451、`api.bybit.com` 403
   （2026-10-08 记录），本包的 binance 兜底路径首当其冲；换出口属用户侧环境选择。
10. **类型存量债**：本包 `tsconfig.json` 有 10 条 tsc 错误记在
    `scripts/typecheck-baseline.json:36`（棘轮基线内的旧债，本 README 不改动）。

## 合规记录

- 三个主机（`api.binance.com` / `api.bybit.com` / `www.okx.com`）的公共行情端点：
  公开、免密；本包不内置密钥，不读凭证环境变量，不把任何值写进日志或回执。
- 本包不依赖也不打包 `ccxt`：名字里的 CCXT 指沿用的交易所词汇，不代表引入该库或该库的运行时。
- 本仓不缓存、不再分发行情数据。
- 各所的地域限制（Binance 451 / Bybit 403 记录）是上游按出口国家实施的政策，
  不是本包可控项；换出口属用户侧环境选择，不是仓库配置的一部分。
- 许可：`PolyForm-Noncommercial-1.0.0`（`package.json`）。
- 本包是数据与执行通道的技术实现，不构成投资建议。

## 出网验证

```sh
pnpm --filter @dshtrading/connector-ccxt test   # 离线：现货限定/三态闸门/dataplane loader
```

- 本包**没有已提交的可复跑出网脚本**：唯一出网证据是 2026-08-31 的评审随测，
  其脚本未随证据入仓（`spikes/verify-connectors-suite/` 目录内只有 EVIDENCE.md）。
  要复跑需自备探针，并注意出口——默认出口对 `api.binance.com` 返回 451、
  对 `api.bybit.com` 返回 403（2026-10-08 记录）。
- 离线证据：`test/spot-only-form.test.ts`（永续入参拒绝 + 零请求断言 + 现货零回归）、
  `test/trade-gate.test.ts`（服务缝三态矩阵）、`test/dataplane-loader.test.ts`（数据面行解析）。
- 真实网络下的服务缝闸门验证只覆盖 okx 连接器（
  [impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md)），
  与本包无关；本包未做真实下单验证。

## 参见

- Owning Note：[crypto-perp-data-plane-bybit-ccxt.md](../../.agents/notes/implemented/feature/2026-10-08-crypto-perp-data-plane-bybit-ccxt.md)
- 全仓当前状态与硬停：[docs/current-state.md](../../docs/current-state.md)
- 连接器横向对照：[connectors-guide.md](../../docs/guides/connectors-guide.md)
