# @dshtrading/connector-ccxt

加密现货连接器（crypto 市场），沿用 CCXT 的交易所词汇做**三所免密行情**
（binance / okx / bybit 三条直连分支）：
实现 `@dshtrading/api` 的 `MarketDataService`，行情快照按所切换，K 线只有 Binance 一条分支。
所名登记面 = 实现面：未实现所名（gateio / kucoin / kraken / coinbase / bitfinex / htx）
在任何请求之前结构化拒绝，不静默落 Binance 兜底。
本包**不依赖也不打包 `ccxt` 库**，也没有合约（永续/交割）面——`-SWAP` 入参显式拒绝。
交易面保留服务缝三态闸门与私有账户读面的失败关闭语义，**私有账户面与真实下单均未实现**。

## 状态

**部分实证（仅 2026-08-31 一轮，且只覆盖现货链路的两个点）**。

- **2026-08-31 评审随测**（对象 commit `b80000e`）：ccxt binance ticker `BTCUSDT`
  77767.66（第 8 项）、ccxt 切 bybit 所的 klines `ETHUSDT` 5m 8 根 close 2420.08（第 9 项）——
  两项均为真实网络调用、无 stub。证据
  [verify-connectors-suite/EVIDENCE.md](../../spikes/verify-connectors-suite/EVIDENCE.md)。
  注意第 9 项（bybit 切所那次）走的是 **Binance 端点**：当时 `getKlines` 忽略 `exchange` 形参
  （旧行为，现已改为 fail-closed，见「已知边界」第 2 条）。
- **该 spike 目录只提交了 EVIDENCE.md**，随测脚本未入仓（`git ls-files spikes/verify-connectors-suite`
  只有一份 EVIDENCE.md），因此**没有可直接复跑的出网脚本**。
- **本包在 2026-10-08 的可达出口窗口内未复验**：同一窗口的记录显示本机默认出口对
  `api.binance.com` 返回 HTTP 451、对 `api.bybit.com` 返回 HTTP 403，换 SG/JP/HK/TW/DE/KR/GB
  出口后可达（[EVIDENCE-reverify-2026-10-08.md](../../spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md)
  第 1/2 节、[EVIDENCE-P3-bybit-ccxt.md](../../spikes/impl-crypto-perp-tradfi/EVIDENCE-P3-bybit-ccxt.md) 第 1 节）。
  这些结论是 Bybit/Binance 端点级的，不是在本包上跑出来的——**本包当前的出口可达性未实证**。
- **未实证**：bybit / okx 两个分支的真实网络行为（okx 分支完全没有网络实证记录）。
- **未实现**（不是未实证）：其它所名的直连分支（本包只登记真有分支的三所）、
  私有账户读面的实际读实现（读方法失败关闭，见「已知边界」第 5 条）与真实下单。
  逐条见「已知边界」。
- **所名登记面已收窄到实现事实**（2026-10-15）：`SUPPORTED_EXCHANGES` 只登记 ticker 的三条
  直连分支（binance / okx / bybit），`KLINE_EXCHANGES` 只登记 K 线的唯一分支（binance）；
  未实现所名在**任何 fetch 之前**抛 `TRADING_NOT_IMPLEMENTED`（点名所名、列出实现面、
  零网络请求，并指向 okx / bybit 专包），回归 `test/exchange-registry-fail-closed.test.ts`。
  要加所是另一张卡的事（补实现分支），不是放宽登记。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器；`false` 时 `apply` 立即返回 |
| `dryRun` | `true` | 强制模拟下单：为 `true` 时即使 `liveTrading=true` 且请求 `dryRun=false`，也只回本地模拟回执 |
| `liveTrading` | `false` | 实盘开关的**非权威镜像**；真正授权由 `@dshtrading/authority` 的人工签署平面裁定 |
| `defaultExchange` | `'binance'` | 首选所名（schema 是开放 `string`：任何 slug 都能填，解析期不收窄）；传给 REST 客户端作为默认 `exchange`。只有 binance / okx / bybit 有 ticker 直连分支、只有 binance 有 K 线分支，其余所名在请求前结构化拒绝 |

依据：`src/index.ts:42-49`（schema 与默认值）、`src/index.ts:177-178`（只把 `defaultExchange`
传给客户端）。**本包没有凭证字段**——`Config` 里没有 key/secret ref，
`apply` 也不读任何环境变量；所有请求都是免密公共端点。
设置页也不再挂 `CCXT_API_KEY` / `CCXT_API_SECRET` 占位（2026-10-15 撤：面板写进
`dshtrading.credentials.ccxt` 的键无人读，见「已知边界」第 6 条）。

## 接线

- **数据面行**：`packages/crypto/cordis.patch.yml:36-38` → 行 id `dsh-trading-crypto-dataplane-ccxt`，
  模块 `@dshtrading/connector-ccxt/dataplane`。该入口只把 `(crypto, ccxt)` 注册进
  `tradingMarketDataRegistry`（`src/dataplane.ts:36`），**既不注册交易面也不注册工具**。
- **preset 行**：`packages/crypto/assets/preset/crypto-trader/agent.cordis.yml:79-90` → isolate 组
  id `dsh-trading-crypto-connector-ccxt-group`（isolate `tradingCryptoMarketData` 与
  `tradingCryptoTrade`），内层行 id `dsh-trading-crypto-connector-ccxt`（第 86-87 行），
  行内只写 `enabled: true` / `dryRun: true` / `liveTrading: false`。
  交易服务只在 preset 主入口构造（`src/index.ts:178`），**不经 `tradingTradeRegistry`**。
- **服务键**：`tradingCryptoMarketData`（`src/index.ts:51`）、`tradingCryptoTrade`（`src/index.ts:52`）。
- **provider 词汇**：`packages/router/src/index.ts:66` 登记 `ccxt`。
- **设置页显示名**：`packages/client-ui-settings/src/client/trading-settings-controller.ts:46`
  （`PROVIDER_LABELS` 的 `ccxt` 条目：`type: 'public'`、无 `env`、无凭据字段）与
  `packages/client-ui-settings/src/client/locales.ts` 的 `'provider.ccxt'` 条目
  （zh `CCXT (Binance/OKX/Bybit 直连)` / en `CCXT (Binance / OKX / Bybit only)`），
  与本包登记的实现面一致。
- **profile overrides**：`node scripts/sync-profile-overrides.mjs --all --dsh-home ~/.dsh-trading`
  （注意 `--dsh-home`；宿主会话继承的 `DSH_HOME` 指向别处会找错 profile 集）。

用户切换：设置 → 数据源 → crypto → CCXT。

## 上游端点

| 用途 | 端点 | 源码行 |
|---|---|---|
| 快照（`exchange=bybit`） | `GET https://api.bybit.com/v5/market/tickers?category=spot&symbol=` | `src/rest.ts:128` |
| 快照（`exchange=okx`） | `GET https://www.okx.com/api/v5/market/ticker?instId=` | `src/rest.ts:141` |
| 快照（`exchange=binance`） | `GET https://api.binance.com/api/v3/ticker/24hr?symbol=` | `src/rest.ts:155` |
| K 线（`exchange=binance`） | `GET https://api.binance.com/api/v3/klines?symbol=&interval=&limit=` | `src/rest.ts:170` |

只有这三个主机；所有请求只带 `Accept: application/json`（`src/rest.ts:104-121`），无签名头。
`SUPPORTED_EXCHANGES`（`src/rest.ts:37`）只登记 `binance / okx / bybit`，`KLINE_EXCHANGES`
（`src/rest.ts:40`）只登记 `binance`——登记面 = 实现面，表里没有第四行。其余所名
（gateio / kucoin / kraken / coinbase / bitfinex / htx 或任何其它 slug）在入口守卫
（`src/rest.ts:126`、`:169`）即抛 `TRADING_NOT_IMPLEMENTED`，**不发任何请求**
（见「已知边界」第 1、2 条）。

## 周期与契约

- **周期词汇**：`1m / 5m / 15m / 30m / 1h / 4h / 1d / 1w / 1M`（`src/rest.ts:28`）。
  没有映射表——词汇原文直接作为 Binance `interval` 参数发出（`src/rest.ts:170`），
  即 `1M` 就是 Binance 的月线。词汇表外的值在类型层即不可表达。
- **所名守卫**：`getTicker` / `getKlines` 在 `normalizeSymbol` 之后、任何 fetch 之前按登记面裁决
  （`src/rest.ts:126`、`:169`）：未登记所名 → `TRADING_NOT_IMPLEMENTED`（点名所名、列出
  实现面、零请求）。两处文案由同一个 `notImplementedError` helper 构造（`src/rest.ts:56`）。
- **现货限定**：`normalizeSymbol`（`src/rest.ts:71-81`）先转大写；形态由 `@dshtrading/api` 的
  `instrumentFormOf` 裁决，命中永续形态即抛 `TRADING_UNSUPPORTED_SYMBOL`，**不剥后缀、不发任何请求**；
  随后删 `-`/`_` 分隔符、去掉 `/`。返回值是该所侧的裸符号（如 `BTCUSDT`），
  也就是响应里的 `symbol` 字段。
- **错误映射**（`src/rest.ts:104-121`）：非 2xx → `TRADING_UPSTREAM_ERROR`；fetch 抛错 →
  `TRADING_NETWORK`。bybit / okx 分支命中空列表 → `TRADING_SYMBOL_NOT_FOUND`
  （`src/rest.ts:131`、`:144`）；binance 分支没有行级判空（入口守卫保证能到那里的只有 binance），
  非法符号由上游 HTTP 400 映射成 `TRADING_UPSTREAM_ERROR`——两条路径的错误码不对称。
- **K 线解析**：按 Binance 数组行解析 `[openTime, open, high, low, close, volume, closeTime]`
  （`src/rest.ts:173-181`），非数组响应返回空数组（`src/rest.ts:172`）。
- **快照字段**：只回 `symbol / price / volume / timestamp`（`src/rest.ts:132-137`、`:145-150`、
  `:157-162`）；bybit 与 binance 分支的 `timestamp` 取本地 `Date.now()`（bybit）
  或上游 `closeTime`（binance），okx 取上游 `ts`——三条路径的时间戳来源不同。

## 能力面

服务方法（`CcxtMarketDataService` / `CcxtTradeService`）：

| 方法 | 有/缺席 | 说明 |
|---|---|---|
| `getTicker` | 有 | 第二参数 `exchange` 生效：bybit / okx / binance 三条直连分支；其余所名结构化拒绝（`TRADING_NOT_IMPLEMENTED`，零请求）（`src/index.ts:66`） |
| `getKlines` | 有 | 只有 binance 一条分支：其余所名结构化拒绝（零请求）（`src/index.ts:70`） |
| `subscribeTicker` | 有 | 快照轮询，最小 1000 ms、缺省 5000 ms（`src/index.ts:74-82`） |
| `listInstruments` | 缺席 | 未实现，调用方按可选方法缺席处理 |
| `getOrderbook` / `getRecentTrades` | 缺席 | 未实现 |
| `getDerivatives` / `getDerivativesHistory` | 缺席 | 未实现 |
| `placeOrder` | 有（模拟） | 三态闸门；模拟回执由服务层本地合成（`src/index.ts:100-127`） |
| `cancelOrder` | 有（受限） | 未获实盘授权或 `dryRun=true` 时结构化拒绝（`src/index.ts:129-139`） |
| `getOrder` | 有（失败关闭） | 契约必需方法，恒抛 `TRADING_NOT_IMPLEMENTED`（语义是「不可用」，不是「订单不存在」）（`src/index.ts:147-153`） |
| `getPositions` | 有（失败关闭） | 契约必需方法，恒抛 `TRADING_NOT_IMPLEMENTED`（语义是「不可用」，不是「没有持仓」）（`src/index.ts:155-161`） |
| `getBalance` / `getOrders` | 缺席 | 非契约方法，已删除：不再回常量 USDT 余额，也不再用恒空数组冒充「没有挂单」 |
| `getBalances` / `listOpenOrders` / `listTradeFills` / `setLeverage` | 缺席 | 可选方法未定义 |

工具（`apply` 内注册，duplicate-safe，`src/index.ts:180-214`）：

| 工具 | 参数 | 说明 |
|---|---|---|
| `crypto_get_ticker` | `symbol`（必填）/ `exchange`（枚举 = `SUPPORTED_EXCHANGES`，即 binance / okx / bybit，缺省 `binance`） | 三条直连分支；枚举外的所名在请求前结构化拒绝（`TRADING_NOT_IMPLEMENTED`，零请求） |
| `crypto_get_klines` | `symbol` / `interval`（枚举 = 周期词汇，缺省 `1d`）/ `limit`（缺省 100）/ `exchange`（枚举 = `KLINE_EXCHANGES`，即 binance，缺省 `binance`） | 只有 Binance 一条分支；非 binance 所名在请求前结构化拒绝（零请求） |

**本包只注册这 2 个工具**，且都是行情工具；交易面没有注册任何工具。

## 已知边界

1. **登记面 = 实现面（ticker 三所）**：`SUPPORTED_EXCHANGES`（`src/rest.ts:37`）只登记
   `binance / okx / bybit`，`getTicker` 在入口守卫（`src/rest.ts:126`）就拦下其它所名
   （gateio / kucoin / kraken / coinbase / bitfinex / htx 或任何其它 slug），抛
   `TRADING_NOT_IMPLEMENTED` 且**不发任何请求**——此前「选 kraken 会拿到 Binance 的报价、
   没有任何提示」的静默兜底已不存在。要支持更多所是补实现分支（另一张卡），不是放宽登记。
   工具描述与设置页显示名同步收窄（`src/index.ts:188`、`locales.ts:226`）。
2. **K 线只有 Binance 一条分支**：`KLINE_EXCHANGES`（`src/rest.ts:40`）只登记 `binance`，
   `getKlines` 对非 binance 所名在 fetch 之前抛 `TRADING_NOT_IMPLEMENTED`
   （`src/rest.ts:169`，零请求），不再「形态上接收 `exchange`、实现上忽略它恒打 Binance」。
3. **不是通用 CCXT 大包**：`package.json` 的 dependencies 只有 `@dshtrading/authority` 与
   `@dshtrading/api`，**没有 `ccxt` 依赖**；本包是自写的 3 条直连分支，只沿用 CCXT 的所名词汇。
4. **现货限定**：`-SWAP` 入参抛 `TRADING_UNSUPPORTED_SYMBOL` 且零网络请求
   （`src/rest.ts:71-81`，回归见 `test/spot-only-form.test.ts`）；本包没有合约面，
   需要永续报价应换 bybit / okx 连接器。
5. **私有账户读面失败关闭**：本包没有签名私有账户读路径，两类必需读方法都显式拒绝——
   `getOrder` 抛 `TRADING_NOT_IMPLEMENTED`（`src/index.ts:147-153`）、`getPositions` 抛
   `TRADING_NOT_IMPLEMENTED`（`src/index.ts:155-161`），文案写明语义是「不可用」，不是
   「订单不存在」或「没有持仓」；可选方法 `getBalances` / `listOpenOrders` /
   `listTradeFills` 直接缺席，消费方按「可选方法缺席」处理。此前硬编码的 100000 USDT
   余额、恒空数组的 `getPositions` 与非契约的 `getOrders` 已删除；回归
   `test/account-read-surface.test.ts`。
6. **凭证字段已撤（2026-10-15）**：设置页不再为 ccxt 挂 `apiKey` / `apiSecret`——本连接器既不声明
   凭证字段、也不读设置字典（`src/index.ts:42-49`、`:177-178`；`CcxtRestOptions` 的 `apiKey`/`secret`
   只被赋值，从不进请求），面板字段是纯承诺，故撤下；日后接签名面时随消费点一起回来。
   撤字段的理由、逐条对照与一致性用例见[设置页凭据面收窄](../../.agents/notes/implemented/simplification/2026-10-15-settings-credential-surface-narrowed.md)。
7. **live 下单路径是本地 sim stub**：闸门③放行后 `CcxtRestClient.placeOrder`
   返回 `sim-ccxt-*` 回执（`src/rest.ts:184-197`），不触网。
8. **地域限制由上游实施**：默认出口对 `api.binance.com` 451、`api.bybit.com` 403
   （2026-10-08 记录），本包的 binance 分支首当其冲；换出口属用户侧环境选择。
9. **类型存量债**：本包 `tsconfig.json` 有 10 条 tsc 错误记在
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
pnpm --filter @dshtrading/connector-ccxt test   # 离线：现货限定/所名登记面/账户读面/三态闸门/dataplane
```

- 本包**没有已提交的可复跑出网脚本**：唯一出网证据是 2026-08-31 的评审随测，
  其脚本未随证据入仓（`spikes/verify-connectors-suite/` 目录内只有 EVIDENCE.md）。
  要复跑需自备探针，并注意出口——默认出口对 `api.binance.com` 返回 451、
  对 `api.bybit.com` 返回 403（2026-10-08 记录）。
- 离线证据：`test/spot-only-form.test.ts`（永续入参拒绝 + 零请求断言 + 现货零回归）、
  `test/exchange-registry-fail-closed.test.ts`（未实现所名 fail-closed + 三所各自主机 +
  工具枚举与登记面一致）、`test/account-read-surface.test.ts`（账户读面失败关闭：必需读方法
  拒绝 + 可选读方法缺席 + 撤单闸门回归）、`test/trade-gate.test.ts`（服务缝三态矩阵）、
  `test/dataplane-loader.test.ts`（数据面行解析）。
- 真实网络下的服务缝闸门验证只覆盖 okx 连接器（
  [impl-service-seam-gate/NET-VERIFY.md](../../spikes/impl-service-seam-gate/NET-VERIFY.md)），
  与本包无关；本包未做真实下单验证。

## 参见

- Owning Note：[crypto-perp-data-plane-bybit-ccxt.md](../../.agents/notes/implemented/feature/2026-10-08-crypto-perp-data-plane-bybit-ccxt.md)
- 全仓当前状态与硬停：[docs/current-state.md](../../docs/current-state.md)
- 连接器横向对照：[connectors-guide.md](../../docs/guides/connectors-guide.md)
