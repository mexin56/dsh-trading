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
- **当时推后、同日补齐的第三条路（即最终采用的形态）**：全仓「每个 dataplane 入口必须导出
  Config」的结构门禁先被推后（现存 17 个入口都不导出，门禁会立刻红、须先引入棘轮基线），
  同日把 17 个入口一并收敛后由 `scripts/connector-dataplane-config-gate.mjs` 落地（见下）。

## 收敛（同日续做，看板卡 456cf455）

存量同类债已清零，且不再依赖人记得补：

- 全部 23 个数据面入口（`packages/connector-*/src/*dataplane.ts`，含 `connector-hithink` 的
  `dataplane.ts` + `futures-dataplane.ts` 与脚手架 `connector-template`）统一三行：
  `import { Config, … }`（值导入，同一名字兼作配置类型）、`export { Config }`、
  `const withDefaults = (value: unknown): Config => (Config as unknown as (v: unknown) => Config)(value)`，
  `apply` 签名取 `config: Config = withDefaults(undefined)`。默认值仍只有一个家——主行 schema。
- schema 里的 `required` 字段保持必填：tencent 的 `market`（单包双市场 cn/hk）在两条行里各自写明，
  手工 ctx 不传 config 时按 schema 报错，不猜一个缺省。
- `pnpm connector-dataplane:check`（`scripts/connector-dataplane-config-gate.mjs`，进 CI 静态门禁与
  `gates:all`，登记在 `scripts/ci-wiring-check.mjs` 的必须接线清单）静态判两条：R1 每个入口重导出
  Config；R2 patch 层引用的每个数据面子路径模块源码入口存在且满足 R1。`connector-template` 骨架合规，
  故 `scripts/new-connector.mjs` 生成的新入口天然带这三行。
- 每包 `test/dataplane-loader.test.ts` 走**加载路径**断言（`resolveConfig(子入口模块, 真实行 config)`
  补出 schema 默认值 + `apply` 后 `(market, provider)` 进对应注册表），行 config 取自 bundle 的
  `cordis.patch.yml` 实值（含 okx 的 `env: demo`、futu/hk 的 `gatewayUrl`、tencent 的 `market`）。

## Consequences

- qmt/alpaca 两个数据面行的加载失败消失：行情与交易服务双双注册，GUI 与只读账户工具在
  路由选中这两家时能解析到服务（剩下的 `TRADING_AUTH_FAILED: accountId is required` 与
  「Alpaca credentials missing」是用户侧配置缺口，不再是「未激活」）。
- 刷新 profile 副本后，宿主 `--dump-config-schema` 对这两行从 `status: absent` /
  `unknownConfig` 变为 `status: schema` + 真实 configRef（2026-10-14 授权刷新
  `~/.dsh-trading/profiles/trading-web` 后实测）。注意该命令解析的是 **profile 副本**里的模块，
  且 profile 归属 `DSH_HOME`：本会话继承宿主 `DSH_HOME=~/.dsh`，而 `~/.dsh/profiles/trading-web`
  下另有一份**未刷新**的旧副本，照继承环境跑 dump 会继续看到 `absent`（第一次实测即踩此坑）；
  本项目一切 profile 命令都必须显式 `DSH_HOME=~/.dsh-trading`。
- 已按授权停实例 → `scripts/refresh-profile.sh --dsh-home ~/.dsh-trading trading-web` → 以桌面壳
  同款命令行（app 内 host bin + host-symbol-normalizer，`DSH_HOME=~/.dsh-trading`）重启宿主：
  启动输出只有 `dsh web: …token…` 一行，**无** `entries did not activate`。桌面壳 GUI 本轮未能从
  命令行拉起（`open -a "DSH Trading"` 返回 0 但无进程），需人工打开；验证用的宿主进程已停，未留残留。
- 同类债已清零：其余 17 个数据面入口（20 条 patch 行）补齐同款导出后，宿主 `--dump-config-schema`
  里 24 条数据面行全部 `status: schema`（此前 20 条 `absent` / `unknownConfig`）。行内 restate
  （okx 的 `env: demo`、futu 的 `gatewayUrl`）此后是可选的冗余，不再是行可用的前提。
- 运行中的桌面实例原先加载修复前的副本（`…/node_modules/@dshtrading/connector-{qmt,alpaca}/lib/dataplane.js`
  只有 `export { apply, inject }`）；2026-10-14 经用户授权已刷新副本并重启宿主一次取证，
  桌面壳 GUI 需人工打开。

## Verification

- **宿主启动告警的真实取证（修复前）**：`~/Library/Logs/dsh-trading-desktop/dsh-host.log`
  起自第 168 行共 17 处 `dsh: warning: 2 entries did not activate`，两条分别是
  `dsh-trading-us-dataplane-alpaca (@dshtrading/connector-alpaca/dataplane)` 与
  `dsh-trading-cn-dataplane-qmt (@dshtrading/connector-qmt/dataplane)`，堆栈落在
  `requireNonEmpty → new OrderIntentLedger → new <X>TradeService → new apply`（与本次定位一致）。
- **loader 激活路径前后对照**：`node spikes/impl-qmt-alpaca-dataplane-activation/run-loader-activation-probe.mjs`
  （真实 router 插件 + 真实行 config `{enabled:true}`，走 `ctx.registry.plugin` 即 loader 的激活路径）：
  修复后 `cn/qmt: activated | 模块导出 Config=true | market=[qmt] trade=[qmt]`、
  `us/alpaca: activated | … trade=[alpaca]`；同一脚本对桌面实例当时加载的 profile 副本
  （修复前构建）仍是 `did not activate | Config=false | market=[] trade=[] | TypeError: … reading 'trim'`。
- **刷新后实例级启动日志**：修复前 `dsh-host.log` 每次启动 2 条告警；刷新副本后按桌面壳同款
  命令行启动，输出仅 `dsh web: http://127.0.0.1:54734/?token=…` 一行，无 `did not activate`；
  同批 `DSH_HOME=~/.dsh-trading dsh --profile trading-web --dump-config-schema` 两行均
  `status: schema`（`config109` / `config111`）。
- 复现与修复后对照（真服务构造）：修复后 loader 解析出
  `{enabled:true, env:'demo', dryRun:true, liveTrading:false, gatewayUrl:'http://127.0.0.1:5800'}`，
  注册表双双得到 `cn/qmt`、`us/alpaca`；只读调用余下的
  `TRADING_AUTH_FAILED: accountId is required`、「Alpaca credentials missing」属用户配置缺口。
- **全仓 24 条数据面行的 `--dump-config-schema` 前后对照（2026-10-14 收敛验证）**：为不动运行中的
  实例，用 `mktemp -d` 造临时 home，`cp -c -R ~/.dsh-trading/profiles/trading-web <tmp>/profiles/trading-web`
  取到未改动的旧副本，跑 `DSH_HOME=<tmp> dsh --profile trading-web --dump-config-schema` →
  `x-cordis.entries` 里 24 条数据面行 **20 条 `absent` / 4 条 `schema`**（schema 的四条正是此前已修的
  alpaca/qmt/xysz/jin10）；把仓库新构建的 `packages/connector-*` 覆盖进副本的
  `node_modules/@dshtrading/connector-*` 后重跑 → **24 条全 `schema`、`absent` 归零**（tencent 的
  cn/hk 两行共享 `config120`、eastmoney 两行共享 `config121`、hithink 的 cn/futures 两行共享 `config125`，
  与「同一份 schema」一致）。两次 dump 都带 3~4 条与本变更无关的既有告警
  （`/179`~`/182` 的 `unrecognized Loader tree carrier` 与 `/112`、`/149` 的 config 校验提示，
  profile 层本来如此），故两次退出码都是 1、`x-cordis.complete` 都是 false——数据面行的 status 不受其影响。
- **结构门禁红/绿两次证据**：`node scripts/connector-dataplane-config-gate.mjs` 全绿
  （23 个入口 / 24 条引用行）；临时删掉 `packages/connector-binance/src/dataplane.ts` 的
  `export { Config }` 再跑 → exit 1，报
  `✗ packages/connector-binance/src/dataplane.ts: 未重导出主行的 Config schema（缺 \`export { Config }\`）`；
  还原后 sha256 与删除前一致（`17c58979…`）、门禁复绿。门禁自测
  `scripts/connector-dataplane-config-gate.test.mjs` 8 例覆盖「漏导出判红」「引用死行判红」
  「非数据面子路径不认领」「本仓现状全绿」等夹具。
- 回归证明（qmt/alpaca 那次）：把两个 `dataplane.ts` 还原到修复前（`git show HEAD~1:` 临时还原后再复原），
  两包新测试各 4 例全红；修复后 `pnpm --filter @dshtrading/connector-qmt --filter @dshtrading/connector-alpaca test`
  22 + 27 例全绿（含「未给 env → demo」与「显式 env:live 不被打回 demo」）。
- `pnpm gates:all`（2026-10-14，HEAD b6a623e4）：16 条门禁 15 通过 / 1 失败，失败项 `test:scripts`
  与环境相关且与本变更无关——`scripts/futu-openapi-bridge.py:110` 在模块顶层 `OpenQuoteContext`
  要求 OpenD，本机 OpenD 未运行（`nc -z 127.0.0.1 11111` → CLOSED）致 hook 超时；本变更未触碰
  `scripts/`（`git diff --stat HEAD~1 HEAD -- scripts/` 为空），已开看板卡 `7a9bb413`
  （该测试同时存在超时泄漏子进程问题，本次清理了 3 个残留桥进程）。
- `pnpm -r test`（同批）无 FAIL；`node scripts/test-audit.mjs --check` 无新增测试债；
  `node scripts/typecheck-gate.mjs` 未超基线；`node scripts/docs-link-check.mjs` 无新增断链。
