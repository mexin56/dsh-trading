# Agent Note: 六个连接器移除无读取方的 env 三态配置

Status: implemented

## Problem

`env: 'demo' | 'live'`（connector-template 的三态环境字段）在六个连接器的 `Config` 里声明并默认
`'demo'`，但包内没有任何代码读它：

- `connector-finnhub` / `connector-fmp` / `connector-polygon`：单一上游 host（`rest.ts` 的
  `baseUrl` 各只有一个缺省值），商业行情源无模拟环境，连接器也没有切换实现；
- `connector-tushare`：同样单 host（`http://api.tushare.pro`），Token 制数据面；
- `connector-ccxt`：`Config` 没有凭证字段、请求全走免密公共端点，无模拟盘域名或请求头；
- `connector-bybit`：上游确有模拟盘域名（`https://api-demo.bybit.com`，Bybit v5 官方 Go SDK
  `consts.go` 与文档 "Demo Trading Service"），但本包没有签名实现、live 下单路径落在本地
  sim stub（`packages/connector-bybit/src/rest.ts` 的 `placeOrder` 返回 `sim-bybit-*` 回执）。

配置面由此声明了一个不存在于实现里的环境开关：`env=live` 不改变任何请求目标，`env=demo`
也不进任何模拟盘。这六个包都是从 connector-template 生成的——模板的 `env` 驱动 demo/live
两套凭证 ref 组，生成时凭证槽被裁掉，`env` 成了没有下半截的残留。

## Decision

六个包删除 `env`：`src/index.ts` 的接口与 schema、测试夹具与断言、README 的配置行与「已知
边界」条目；`docs/guides/connector-playbook.md` 的 bybit 示例行去掉 `env: demo`，§2 第 4 项
由「无模拟环境锁 `env='live'`」改为「上游没有模拟环境就删掉 `env` 字段与 demo\*Ref 槽」。
其余字段与闸门语义不变（`dryRun` / `liveTrading` 的三态闸门照旧，本次不碰）。

`env` 在本仓的两种合法形态都保留：

- **真接线**：`connector-okx`（`x-simulated-trading` 头 + demo/live 两套凭证）、
  `connector-alpaca`（`credentialRefsFor` + 数据面凭证组）、`connector-template`（脚手架的示范面）；
- **被读但不是环境切换**：`connector-ibkr` / `connector-tiger` / `connector-longbridge` /
  `connector-qmt` 把它传给 `OrderIntentLedger({ environment })` 作幂等作用域（卡
  `d5fe64f2` 与 [dataplane Config schema 记录](../bug-fix/2026-10-14-qmt-alpaca-dataplane-config-schema.md)
  的既有裁决），删它会削弱「同 id 跨环境必须冲突」的判据。

## Alternatives considered

- **给 bybit 接上模拟盘端点**：否决。上游有 demo 域名，但本包的 live 下单路径是本地 sim
  stub（无签名、不带凭证），接上端点后仍然没有消费者——那只是把死配置换成死代码。
  `2026-10-10-fabricated-trade-surface-fail-closed.md`
  已把「补 Bybit v5 真实签名实现」记为本记录范围外，届时连同 `env` 一并加回。
- **保留字段、在 README 标注「未接线」**：否决。配置面是用户可见契约，声明一个不生效的
  环境开关本身就是错的；标注只是把这个错写成有意的。
- **无模拟环境锁 `env='live'`（原手册口径）**：否决。字段仍无读取方，锁一个恒不被读的值
  不解决问题，且会让 `live` 看起来像是被校验过的实盘开关。

## Consequences

- **行 config 的未知键被 schema 放行而非拒绝**：实测 finnhub 数据面入口
  `resolveConfig(plugin, { enabled: true, env: 'demo' })` 得
  `{ enabled: true, dryRun: true, liveTrading: false, apiKeyRef: 'FINNHUB_API_KEY', env: 'demo' }`
  ——用户 home 里既有的 `env: demo` 行照常加载，残留键不生效，无需迁移。
- 已核 `packages/<market>/cordis.patch.yml` 与 `assets/preset/*/agent.cordis.yml`：现存三处
  `env: demo` 分属 okx（crypto 两处）与 alpaca（us 一处），这六个包在预设层没有 env 赋值，
  因此本次没有预设层要清的行。
- 六包测试 121 例通过（finnhub 15 / fmp 15 / polygon 14 / bybit 40 / ccxt 19 / tushare 18）；
  两处数据面 loader 用例改为断言 `'env' in resolved === false`，把「行 config 不再含 env」
  钉在 loader 解析路径上，而不是只钉在类型面。
- 全仓仍有 7 个包声明 `env`（okx / alpaca / template / ibkr / tiger / longbridge / qmt），
  逐个核实均有读取方，不在本次范围。
