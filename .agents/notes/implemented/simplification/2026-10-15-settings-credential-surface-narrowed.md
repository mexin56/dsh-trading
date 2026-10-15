# Agent Note: 设置页凭据面收窄到连接器真实消费面

Status: implemented

## Problem

设置页的凭据卡片（`PROVIDER_CREDENTIAL_SPECS`）给 16 个 provider 挂了字段，值写进
`dshtrading.credentials.<provider>`；但连接器只有一部分真读这个字典（router `getCredential`），
其余只读自己的环境变量或 `Config`。用户在面板填了 key、看到「已配置」，连接器却从不读它——
这是拿 UI 承诺一个不存在的能力。逐条核实（2026-10-15，按 `panel field → 读点` 三条取值路径）：

| provider | 面板字段（收窄前） | 连接器消费点 | 结论 |
|---|---|---|---|
| okx | `apiKey` / `secretKey` / `passphrase` | `resolveCredentials` 读 `router.getCredential('okx')`（`packages/connector-okx/src/index.ts:180-186`），值进 `OK-ACCESS-KEY` 与 HMAC 签名 | 真消费 |
| alpaca | `apiKey` / `secretKey` | `resolveCredentials` 读 `router.getCredential('alpaca')`（`packages/connector-alpaca/src/index.ts:119-122`），值进 `APCA-API-KEY-ID` 等头 | 真消费 |
| fmp | `apiKey` | `createApiKeyProvider` 读 `router.getCredential('fmp')?.apiKey \|\| env[apiKeyRef]`（`packages/connector-fmp/src/index.ts:176-180`），**每次请求**解析（`src/rest.ts:112`），进 `apikey=` 查询串；主入口与数据面行同用这一份（`src/index.ts:187`、`src/dataplane.ts:32`） | 真消费（两条挂载路径） |
| finnhub | `apiKey` | 同上形（`packages/connector-finnhub/src/index.ts:181-185`、`src/index.ts:192`、`src/dataplane.ts:32`、`src/rest.ts:95`），进 `token=` 查询串 | 真消费（两条挂载路径） |
| polygon | `apiKey` | 同上形（`packages/connector-polygon/src/index.ts:172-176`、`src/index.ts:183`、`src/dataplane.ts:32`、`src/rest.ts:116`），进 `apiKey=` 查询串 | 真消费（两条挂载路径） |
| tushare | `token` | `createTokenProvider` 读 `router.getCredential('tushare')?.token \|\| env[tokenRef]`（`packages/connector-tushare/src/index.ts:188`），进请求体 `token` | 真消费 |
| hithink | `apiKey` | `router.getCredential('hithink')?.apiKey \|\| env[apiKeyRef]`（`packages/connector-hithink/src/dataplane.ts:36`），进 `X-api-key` 头 | 真消费 |
| jin10 | `token` | `createTokenProvider` 读 `router.getCredential('jin10')?.token \|\| env[tokenRef]`（`packages/connector-jin10/src/plugin.ts:47`），进 `Authorization: Bearer` | 真消费 |
| longbridge | `appKey` / `appSecret` / `accessToken` | 收窄前只有 `process.env[<ref>]`（数据面 `packages/connector-longbridge/src/dataplane.ts:29-31`，插件行 `:213-215`）；值本会进 `x-api-key` 头与 HMAC-SHA256 签名（`src/rest.ts:84-105`） | 补读点 |
| tiger | `privateKey` | 收窄前只有 `process.env[config.privateKeyRef]`（`packages/connector-tiger/src/index.ts:220`），值本会进 RSA2 签名（`src/rest.ts:39-46、86-90`） | 补读点 |
| binance | `apiKey` / `apiSecret` | 全包没有任何凭证取值点：无 `getCredential`、无 ref 字段、无 `process.env` 读取；签名下单是未实现的后续卡（`packages/connector-binance/src/index.ts:447` 抛 `TRADING_NOT_IMPLEMENTED`） | 纯承诺 |
| ccxt | `apiKey` / `apiSecret` | 无 `getCredential`、无 ref、无 `process.env`；`CcxtRestOptions.apiKey/secret` 只在构造函数里赋值，请求只带 `Accept` 头（`packages/connector-ccxt/src/rest.ts:86-99`） | 纯承诺 |
| bybit | `apiKey` / `apiSecret` | 只读 `process.env[apiKeyRef/secretRef]`（`packages/connector-bybit/src/index.ts:281-282`、`src/dataplane.ts:40-41`），值只存进客户端字段；`placeOrder` 收 `_creds` 却忽略、无任何签名实现（`src/rest.ts:546`） | 面板键无读点 |
| qmt | `gatewayUrl` | 面板键无人读；本包只读 `Config.gatewayUrl`（`packages/connector-qmt/src/index.ts:55`、`src/dataplane.ts:44-54`）；`QMT_GATEWAY_URL` 回落被 schema 默认值遮蔽（`src/rest.ts:78`） | 家错位 |
| ibkr | `gatewayUrl` | 面板键无人读；本包只读 `Config.gatewayUrl`（`packages/connector-ibkr/src/index.ts:55`、`src/dataplane.ts:31-35`）；`IBKR_GATEWAY_URL` 同上被遮蔽（`src/rest.ts:59`） | 家错位 |
| futu | `host` / `port` | 面板键无人读；本包只读 `Config.gatewayUrl`（`packages/connector-futu/src/index.ts:57`，数据面 `src/dataplane.ts:68`、插件行 `:465`）；全包唯一的 `process.env` 读取是 `unlockPwdRef`（`:233`） | 家错位 |
| tiger | `tigerId` | 面板键无人读；本包只读 `Config.tigerId`（`packages/connector-tiger/src/index.ts:56`，rest 层另有 `TIGER_ID` 回落 `src/rest.ts:65`） | 家错位 |

另两条同批修掉的错面：

- `docs/guides/connectors-guide.md` 把 futu 的认证方式写成 `FUTU_HOST` / `FUTU_PORT`（默认 11111）——
  全仓没有任何代码读这两个名字（futu README「已知边界」早已记为历史名）。
- `PROVIDER_LABELS.env` 是「环境变量名或配置项名」的混合槽位：futu 填的是 Config 字段名
  `gatewayUrl`，ibkr/qmt/xysz 填的是在插件路径下被 schema 默认值遮蔽的环境变量名，
  binance/ccxt 填的名字无人读。提示前缀 `provider.envPrefix` 用「环境变量/配置项：」兜着两种语义。

## Decision

一条规则：**凭据卡片只收「密文字段 × 真出站消费点」**。同一纪律的两个既有先例：
[2026-10-15-akshare-dead-config-and-interval-honesty.md](../bug-fix/2026-10-15-akshare-dead-config-and-interval-honesty.md)
（`PROVIDER_CREDENTIAL_SPECS.akshare` 整项删除）与
[2026-10-15-connector-dead-env-config-removal.md](2026-10-15-connector-dead-env-config-removal.md)
（无读取方的配置面一律删，而不是标注「未接线」）。

- 密文字段：值的家是 `dshtrading.credentials.<provider>`（router `getCredential`）。设置页写的就是
  这个字典，卡片自带脱敏显示与「已配置/未配置」状态，只适合密钥类值。
- 真出站消费点：连接器代码真读这个键，且值能进到请求里（签名 / 认证头 / 查询串）。

两条同时成立才留在面板；任一条不成立即撤字段：

- **撤字段（7 个 provider 的 11 个字段）**：binance / ccxt / bybit 的 key/secret（无出站消费点，
  密文却到不了请求）、qmt / ibkr 的 `gatewayUrl`、futu 的 `host` + `port`、tiger 的 `tigerId`
  （非密端点/账户标识，家在连接器自己的 `Config`，设置页写的是另一处无人读的命名空间）。
- **补读点（4 个字段）**：longbridge 三件凭证与 tiger 的 `privateKey`——出站消费点本已存在
  （HMAC-SHA256 / RSA2 签名），缺的只是设置字典这条取值路径，按 fmp/finnhub/polygon 既有体例
  补上「settings 优先、env 兜底」，并且**数据面行与 preset 行都读**（否则 GUI 行情面拿不到面板填的 key）。
- **槽位拆分**：`ProviderMeta.env` 只表示「连接器真回落的环境变量名」，新增 `ProviderMeta.configField`
  表示「连接器 Config 的字段名」，两个词典前缀 `provider.envPrefix` / `provider.configFieldPrefix`
  分开承载。既有条目按真读点重排：binance/ccxt 去掉无人读的提示；ibkr/qmt/xysz/futu 的地址提示
  从 env 槽移到 configField 槽。
- **面板提示不再指向「没有读点的名字」**：binance/ccxt 的 `BINANCE_API_KEY` / `CCXT_API_KEY` 提示撤下；
  bybit 的 `BYBIT_API_KEY` 保留（连接器真的从它取值）。

## Alternatives considered

- **给所有面板字段补读点（一律「接上消费」）**：对 longbridge/tiger 成立（签名路径已在），
  对 binance/ccxt 不成立——补一条 `getCredential` 读点只会把「面板值」搬到一个照样不用的客户端字段里，
  面板仍是纯承诺；对 qmt/ibkr/futu 则是给非密地址造第二个家（与「一个事实只有一个家」相抵），
  且会把已实测有据的 `Config.gatewayUrl`（含 futu「必须指向桥的 11112」这一边界）挤成兜底。
- **一律撤字段（含 longbridge/tiger 的密文）**：longbridge 与 tiger 是唯一两条已实现的券商签名路径，
  撤掉等于把用户唯一的图形化密钥入口关掉，且要另立「私钥只能走 env」的新规矩；补读点只要几行。
- **保留 bybit 的凭据卡片并把 settings 读点接上**：连接器没有签名实现（同日另一份记录
  [../simplification/2026-10-10-fabricated-trade-surface-fail-closed.md](2026-10-10-fabricated-trade-surface-fail-closed.md)
  已把其账户读面改为失败关闭），接上的值同样不进任何请求——把承诺从「无人读」洗成「读了但没用」，落选。
- **让面板写连接器 Config（而不是撤字段）**：跨命名空间写行 config 要动 loader 与 `configForms`
  寻址面，远超本卡范围；连接器 Config 已经由官方行配置表单可达，撤字段不损失配置能力。

## Consequences

- 设置页凭据卡片从 16 个 provider 收窄到 10 个（okx / alpaca / fmp / finnhub / polygon / tushare /
  longbridge / tiger / jin10 / hithink），字段总数 26 → 16；撤下的 provider 卡片位只留官网指引与
  （真读得到的）环境变量/Config 字段提示。
- `packages/client-ui-settings/test/credential-consumption.test.ts`：新一致性守卫，用真连接器模块 +
  鸭式 ctx +「记录型 credentials 记录」（每次属性读都记账）断言面板字段 ⊆ 连接器读点，
  并断言覆盖表与面板规格表相等（新增挂凭据字段的 provider 必须同时补用例）。
  逐请求惰性解析的连接器用导出的解析函数或真服务方法触发，传输层是手写 `Response` 替身（零 mock 工具）。
  判据按**挂载路径**分别成立：有「bundle 数据面行 + preset 插件行」两条时两条各自挂载、各自出网、
  各自断言（fmp/finnhub/polygon/longbridge/tiger）；两条行共用同一个 resolve 函数的
  okx/alpaca/tushare/jin10 仍只断言一次读出，其行级接线由各包自己的 dataplane loader 用例守。
  另两条断言把提示槽位的语义钉住：`env` 必须是环境变量名形状，`configField` 必须真出现在
  对应连接器 `resolveConfig` 的 Config 键里。
- 负向验证（本次实测）：把 longbridge 数据面行退回只读 env → 该用例红；往 `PROVIDER_CREDENTIAL_SPECS`
  加一个无用例覆盖的 provider → 覆盖用例红。收尾复跑：把 fmp 数据面行退回只读 env → 该包
  dataplane loader 用例 2 例红（settings 优先例与 apply 后补凭证例，env 回落例仍过），
  守卫的 fmp 逐路径用例同时红（`expected [] to deeply equal ['apiKey']`）。
- 撤字段留下的孤儿数据：老 profile 里已存的 `dshtrading.credentials.binance|ccxt|bybit|qmt|ibkr|futu|tiger.*`
  成为无人读的死值（字典开放、不报错）。本卡不动用户 profile 文档，也不主动清理。
- 各连接器 README 的「配置」「接线」「已知边界」段同步；`locales.ts` 中英词典删除随之失效的
  标签与占位键（`field.label.apiSecret`、`field.*.qmtUrl|futuHost|futuPort|ibkrUrl|tigerId|binance*|ccxt*|bybit*`），
  并新增 `provider.configFieldPrefix`。显示名引用改按词典键（`'provider.<id>'`）锚定：
  那些行号在本卡前后已多次漂移，键才是稳定锚。
- 三包数据面行的口径差已闭合（2026-10-15 同日收尾）：fmp / finnhub / polygon 的**数据面行**原先只读
  `process.env[<ref>]`，现与主入口共用同一个惰性 `createApiKeyProvider`（settings 优先、env 兜底、
  每次请求解析）——GUI 行情注册面与 preset 工具面吃同一份凭证，包内不再有第二份凭证解析
  （同 connector-tushare 的 `createTokenProvider`）。三包 README「接线」段、`rest.ts` 的
  `apiKeyProvider` 选项（静态 `apiKey` 保留作直调兜底）与守卫的逐路径判据同步。
- alpaca **不在其列**：它的数据面行把 `resolveCredentials(ctx, …)` 交给行情服务惰性调用
  （`packages/connector-alpaca/src/dataplane.ts:69-72`），router 读点已经在数据面路径上。
