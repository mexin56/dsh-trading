# Agent Note: 声明面收窄到实现面（设置页登记项与 CCXT 所名面）

Status: implemented

## Problem

- 设置页 `PROVIDER_LABELS` 的 `markets` 是候选下拉的过滤判据（`MarketProviderPanel`：
  `p.markets.includes(market)`），却与连接器 dataplane 的真实注册面不一致：ibkr 声明
  `['us','hk']` 而 `connector-ibkr/src/dataplane.ts` 只 `MARKET = 'us'`；akshare 声明
  `['cn','hk']` 而只注册 `cn`；tiger 声明 `['hk','us','cn']` 而只注册 `hk`。用户在这些市场
  的下拉里看得见候选，选中后路由到一个没有注册的 provider（`routeAllows()` 不成立 → 无连接器
  激活），面板与运行时都不报错。
- 同一张表另有两处指向不存在的东西：futu 的 `env: 'FUTU_HOST'` 全仓只此一处（连接器不读这个
  环境变量，其 Config 真字段是 `gatewayUrl`）；bybit 的 Secret 占位写 `BYBIT_API_SECRET`，
  而 `secretRef` 的 schema 默认名是 `BYBIT_SECRET_KEY`。
- `connector-ccxt` 的 `SUPPORTED_EXCHANGES` 登记 9 个所名、工具描述与设置页显示名自称
  「100+ 交易所」，实现只有 binance/okx/bybit 三条分支（`getKlines` 连 `exchange` 形参都不用）：
  选 `kraken` 拿到 Binance 报价且无任何提示——与 `docs/current-state.md` 不变量 #6
  「跨源永不混显」相反，与 [bybit-ccxt 现货保持 note](../feature/2026-10-08-crypto-perp-data-plane-bybit-ccxt.md)
  对 `-SWAP` 的裁决同类。

## Decision

- 设置页登记项按「dataplane 注册面 / Config 字段」改值：ibkr `['us']`、akshare `['cn']`、
  tiger `['hk']`（futu 行情面 hk+us 与实现一致，保持不动）。futu 的 `env` 指向 Config 字段
  `gatewayUrl`；`provider.envPrefix` 改中性措辞（「环境变量/配置项：」/「Env var / config
  field: 」），让既有槽位能如实承载「配置项」这一类指向。bybit Secret 占位改
  `BYBIT_SECRET_KEY`。
- 新增 `packages/client-ui-settings/test/provider-registration.test.ts`：按 loader 语义
  （`resolveConfig` 补行 config）驱动**真**连接器 dataplane 模块，用鸭式注册表收集
  `register(market, provider, service)`，断言四个 provider 的登记项等于实际注册面、futu 的
  `env` 是其 Config 的键、每条 `markets` 非空。守卫是行为级（改宽 markets 即红），不是字面量快照。
- CCXT 所名面按 fail-closed 收窄（不补齐六所分支）：`SUPPORTED_EXCHANGES` =
  `['binance','okx','bybit']`（ticker 面），新增 `KLINE_EXCHANGES = ['binance']`；
  `getTicker` / `getKlines` 在 `normalizeSymbol` 之后、任何 fetch 之前对未实现所名抛
  `TRADING_NOT_IMPLEMENTED`（文案点名所名、列出实现面、明说零网络请求）；两个工具的
  `exchange` 枚举改挂这两份登记，`description` 去掉「100+」。
- 新增 `packages/connector-ccxt/test/exchange-registry-fail-closed.test.ts`：拒绝路径零请求、
  binance/okx/bybit 各打自己主机（补上此前无单测的 okx 分支）、工具枚举与登记面逐字相等。

## Alternatives considered

- **只改文案**（改成「三所直连 + 其余所名落 Binance 兜底」）：落选——它把「选 kraken 得
  Binance 报价」写成一条特性，误标数据源仍在，且工具枚举继续提供做不到的选项。
- **补齐六条直连分支**（gateio/kucoin/kraken/coinbase/bitfinex/htx）：落选（本卡边界）——
  各所端点、符号与周期映射需要自己的真实证据，另开卡；本次先把能发的面收窄到已实现部分。
- **把 `Config.defaultExchange` 改成封闭 enum**：落选——它推翻
  [provider 词汇开放化 note](../architecture/2026-08-30-provider-vocabulary-open.md) 的既有决策
  （schema 接受任意 slug、未知 slug 打 warn + fail-soft）；本次拒绝发生在调用点并给出结构化
  错误码，不把配置校验升级成加载失败。
- **给 `ProviderMeta` 加独立 `configField` 字段另起一行渲染**：落选（本卡边界）——那是面板
  新功能；本次先用中性前缀让既有 `env` 槽位如实承载两类指向。

## Consequences

- 设置页下拉不再出现该市场没有注册的 provider；把 `markets` 改宽会被一致性测试拦下
  （反证：tiger 改回 `['hk','us','cn']` → 1 例红，恢复后文件哈希与原文件一致）。
- `crypto_get_ticker` 传 `kraken`/`gateio`/… 得到 `TRADING_NOT_IMPLEMENTED` 且零出网，不再
  返回 Binance 报价；`crypto_get_klines` 传 binance 以外的所名同样结构化拒绝（此前静默忽略
  `exchange` 恒打 Binance）。
- 未实现（各属另开的卡）：六所直连分支与 K 线按所切换；futu 设置页凭据表单仍是 `host`/`port`
  而 Config 只有 `gatewayUrl`；ccxt 设置页存着 `CCXT_API_KEY`/`CCXT_API_SECRET` 占位而连接器
  不读任何凭证。`ProviderMeta.env` 的语义仍是「环境变量名或配置项名」，未做类型区分。
- 证据：`pnpm --filter @dshtrading/client-ui-settings test`（14 例通过）、
  `pnpm --filter @dshtrading/connector-ccxt test`（31 例通过）。
