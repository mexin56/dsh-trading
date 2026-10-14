# Agent Note: 腾讯连接器缺路由闸门 —— cn/hk 路由切到别家后整个 agent preset 判 invalid

Status: implemented

## Problem

用户把设置里的 cn/hk 路由切到 eastmoney 后，**新建会话直接失败**：

```
新建会话失败：agent-preset/invalid: dsh-trading-cn-connector-eastmoney
(@dshtrading/connector-eastmoney): service "tradingCnMarketData" has been registered at
<dsh-trading-tencent>
```

preset 平面装载失败 → 会话建不起来；宿主其余功能正常（行情桥走注册表，不受影响）。

## Root Cause

preset 平面的同市场连接器行全部挂在**同一个** `cordis:group + isolate` realm 里：
`isolate: { tradingCnMarketData: true }` 的 label=true 让 loader 给该组一个
`LocalRealm`、组内子行共用（`cordis-plugin-loader` 的 `isolate()`：
`entry.realm ??= new LocalRealm(entry)`，子行 isolate map 从父行继承）。于是组内任意时刻
只能有一个 provider 真正 provide 市场服务键——**互斥靠每个 provider 自己的
`routeAllows` 闸门**（eastmoney/xysz/qmt/tushare/akshare 都有）。

`@dshtrading/connector-tencent` 的 `apply` 自 99d5e887 起无条件 `new TencentMarketDataService(...)`
（既不查 `enabled`——它的 Config 没有这个字段——也不 consult 路由）。默认 cn/hk 路由是
tencent，此时别家自己让位，所以缺陷长期不可见；**路由一旦切到别家**，两行在同一个 realm
里同时 provide → 后来者抛 "has been registered at <dsh-trading-tencent>" → 整个 preset
判 invalid（2026-10-14 实测复现，错误串与用户报的一字不差）。

## Decision

1. `connector-tencent` 的 `apply` 前置路由闸门 `routeAllows(ctx, market)`（cn/hk 两实例
   共用，slug `tencent`）：路由未选中本家 → **零注册**（既不 provide 服务、也不注册工具），
   把该市场让给选中的那家；无 `tradingMarketRouter` 的老部署/手搓 ctx → 放行，保持旧的
   单 provider 行为。语义与 eastmoney/xysz/qmt/tushare/akshare 的同名函数一致。
2. 单测守卫三态 + hk 实例（`test/route-gate.test.ts`，假 ctx 只搭路由/服务/工具三个形状面）。
3. 复现与对照脚本入档：`spikes/impl-cn-preset-route-mutex/run-cn-group-route-mutex-probe.mjs`
   （用 `ctx.isolate(key)` 把两张同市场行挂进同一 realm，等价复现 loader 的组内 realm）。

## Alternatives considered

- **把 cn 的 eastmoney 行挪出组、独立成组（hk 先例）**：能绕开冲突，但依赖 preset 分组的
  具体形状，任何新增 provider 都要重做一遍；且组内工具名重复注册的问题依旧（两行都注册
  `cn_get_ticker` 等）。治标不治本（否）。
- **给 tencent 加 `enabled` 开关并由 preset 行关掉**：这不是路由问题而是「谁是当前 provider」
  的问题——把设置里的路由切换变成需要手工改 preset，语义错位（否）。
- **去掉 preset 的 isolate / 放宽 realm**：会破坏 preset 装载硬规则（不包组被
  agent-presets 以 process-global service 拒绝，acceptance「修复 1」），（否）。
- **只修 preset 模板不动连接器**：用户已装的 preset（`~/.dsh-trading-presets/{master,trader}`）
  不在仓库内，改模板不修现场；且模板重装依赖安装器代际戳（否）。

## Consequences

- cn/hk 路由切到别家（现为 eastmoney）时：腾讯实例零注册，选中那家独占该市场的服务键与
  `cn_*`/`hk_*` 工具，preset 恢复有效；路由切回 tencent 时行为与从前完全一致。
- `routeAllows` 只在 apply 时裁决一次（与其它连接器一致）：改路由后要新建 preset/会话生效。
- 观察项：`connector-hithink` 同样没有路由闸门，但它当前独占 futures，cn 组内没有它的行，
  暂无同 realm 兄弟；后续若把它加进共享组，必须同时补闸门。
- 用户现场需要「刷新 profile 副本 + 重启宿主」才生效（本次已按授权刷新，见 Verification）。

## Verification

- 复现（修复前，桌面实例实际加载的 profile 副本）：
  `node spikes/impl-cn-preset-route-mutex/run-cn-group-route-mutex-probe.mjs`
  → cn 路由选中 eastmoney 时 `eastmoney 行: THROW Error: service "tradingCnMarketData" has
  been registered at <dsh-trading-tencent>`，realm 里是 `TencentMarketDataService`。
- 修复后同脚本：eastmoney 路由 → `eastmoney 行 ok`、`tradingCnMarketData =
  EastmoneyMarketDataService`（4 个工具）；tencent 路由 → `TencentMarketDataService`（5 个工具）；
  两个方向都无异常。
- `pnpm --filter @dshtrading/connector-tencent test`：4 文件 51 例全绿（新增 6 例覆盖
  cn/hk 两个实例的「选中/未选中/无 router」三态）。
- `pnpm -r test` 全仓无 FAIL；`node scripts/test-audit.mjs --check` 无新增测试债；
  `node scripts/typecheck-gate.mjs` 未超基线（415/423）。
