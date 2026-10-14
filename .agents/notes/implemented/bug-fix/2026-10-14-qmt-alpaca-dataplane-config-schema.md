# Agent Note: qmt/alpaca 数据面行未导出 Config schema —— 两个下单面从未激活

Status: implemented

## Problem

cn/qmt 与 us/alpaca 是 A 股与美股**唯一带交易面**的两个连接器，但它们的宿主面数据行
（`packages/cn/cordis.patch.yml` → `dsh-trading-cn-dataplane-qmt`、
`packages/us/cordis.patch.yml` → `dsh-trading-us-dataplane-alpaca`）从未把服务注册进
`tradingMarketDataRegistry` / `tradingTradeRegistry`：GUI 行情桥与 `<market>_get_positions`
等只读账户工具在选到这两家时永远解析不到服务，即用户看到的「下单面从未激活」。

## Root Cause

两个 `dataplane.ts` 只 `import type { Config }`：cordis loader 的 `resolveConfig` 在
**被加载的那个模块**没有导出 `Config` 时原样返回行 config，于是 patch 行写的
`{ enabled: true }` 直接进 `apply`，schema 默认值（`env: 'demo'`、`dryRun`、
`liveTrading`、`gatewayUrl`、凭证 ref）全部丢失。

`env` 缺失是致命的：`new QmtTradeService` / `new AlpacaTradeService` 构造
`OrderIntentLedger({ environment: options.config.env })`，`requireNonEmpty` 对 undefined
调 `.trim()` 抛 TypeError → **整个 `apply` 抛出** → loader 判该行加载失败，已登记的
行情注册（`ctx.effect`）一并回滚：行情与交易两个服务都没了。

只有这两家（外加同样缺 schema 的 okx）会踩到，因为其余连接器的服务在字段缺失时都有
兜底（URL 常量、`?? 'default'`）；okx 侥幸逃生只是因为它的 patch 行额外 restate 了
`env: demo`。2026-10-14 用真实模块 + 真实行 config 复现：loader 传给 qmt/alpaca 的
config 是 `{"enabled":true}`，apply 抛 `TypeError: Cannot read properties of undefined
(reading 'trim')`。

## Decision

1. 两个数据面入口**就地重导出主行同一份 schema**（`export { Config }`，与
   [jin10](../feature/2026-09-13-jin10-mcp-flash-news-connector.md)/xysz 同款），loader
   自此对行 config 做校验并补默认值——默认值只有一个家，不会在两处漂移。
2. `apply` 的 config 参数默认取 schema 解析结果（`withDefaults(undefined)` 即
   `Config(undefined)`）：单测/第三方宿主手搓 ctx 不传 config 时按 schema 默认值处理，
   不再读 `config.enabled` 即崩（`docs/guides/connector-playbook.md` §4.2 的接线契约）。
3. 包内单测守卫**加载路径**而不是包内直调：`resolveConfig(模块, {enabled:true})` 必须给出
   schema 默认值，且 `apply` 后行情与交易两张注册表都要拿到 `(market, provider)`
   （`test/dataplane.test.ts`，两包各 4 例；假 ctx 只提供注册表形状，不经通用 mock）。

## Alternatives considered

- **在 patch 行 restate `env: demo`（okx 现行做法）**：能止血，但 `gatewayUrl`、凭证 ref、
  `dryRun`/`liveTrading` 的默认值仍进不来，且行内 restate 越多越容易与 schema 漂移；治标不治本。
- **在 dataplane 里另写一份本地默认值对象**：默认值出现第二个家，schema 改动即静默失配（否）。
- **`apply(ctx, config: Partial<Config>)` 逐字段 `??` 兜底**：同样是把默认值复制成第二份家，
  且 jin10 先例已证明「共用同一份 schema」更省心（否）。
- **本轮就加「每个 dataplane 入口必须导出 Config」的全仓门禁**：现存 17 个数据面入口都不导出，
  门禁会立刻红、须先引入棘轮基线，属于独立变更；已作为看板卡登记，不在本次修复内扩大范围。

## Consequences

- qmt/alpaca 两个数据面行的加载失败消失：行情与交易服务双双注册，GUI 与只读账户工具在
  路由选中这两家时能解析到服务（剩下的 `TRADING_AUTH_FAILED: accountId is required` 与
  「Alpaca credentials missing」是用户侧配置缺口，不再是「未激活」）。
- 宿主 `--dump-config-schema` 对这两行从 `status: absent` / `unknownConfig` 变为真实
  configRef（设置面可投影其配置字段）。
- 仍存量的同类债：其他 17 个数据面入口依旧不导出 `Config`，只是当前不崩（服务兜底或行内
  restate）。看板已登记系统性收敛卡。
- 运行中的实例要见到修复需刷新 profile 副本（`scripts/refresh-profile.sh trading-web`）并重启宿主。

## Verification

- 复现与修复后对照（真实模块 + 真实行 config，真服务构造）：修复前 qmt/alpaca `apply` 抛
  `requireNonEmpty` TypeError、两张注册表皆空；修复后 loader 解析出
  `{enabled:true, env:'demo', dryRun:true, liveTrading:false, gatewayUrl:'http://127.0.0.1:5800'}`，
  注册表双双得到 `cn/qmt`、`us/alpaca`。
- 回归证明：把两个 `dataplane.ts` 还原到修复前，两包新测试各 4 例全红（`git show HEAD:` 临时还原后
  再复原）；修复后 `pnpm --filter @dshtrading/connector-qmt --filter @dshtrading/connector-alpaca test`
  21 + 26 例全绿。
- `pnpm -r test` 全仓无 FAIL；`node scripts/test-audit.mjs --check` 无新增测试债；
  `node scripts/typecheck-gate.mjs` 未超基线。
