# Agent Note: connector-tushare 数据面行读不到设置中心 Token

Status: implemented

## Problem

桌面壳「设置 → 交易」把 Tushare Token 写进 `dshtrading.credentials.tushare.token`（settings.yaml），
主入口 `apply` 经 router `getCredential('tushare')` 能读到；但宿主面挂的是**数据面行**
（`@dshtrading/connector-tushare/dataplane`），其 `apply` 只读 `process.env[config.tokenRef]`，
且读一次就在挂载期定死——设置页写入的 Token 到不了宿主数据行，运行中改 env 也不重读。

这与 hithink 的 cn/futures 两个数据面在 2026-09-12 修掉的是同一根因
（[期货市场分组](../feature/2026-09-12-futures-market-group.md)），当时 tushare 数据面未纳入；
kit-cn 的工具面是同一根因的第三个消费点
（[kit-cn hithink 工具惰性凭证](2026-09-14-kit-cn-hithink-tools-lazy-credential.md)）。

## Decision

1. `packages/connector-tushare/src/index.ts` 新增并导出 `createTokenProvider(ctx, tokenRef)`：
   router `getCredential('tushare').token`（设置中心）优先、`process.env[tokenRef]` 兜底，返回惰性 thunk。
   `tokenRef` 语义不变——仍是指向**环境变量名**的 BYOK 引用；凭证值只经 ref 与设置中心流动，
   不进日志/回执。
2. 主入口 `apply` 与数据面行 `apply` **共用这一份** provider（dataplane 从 `./index.js` 导入），
   包内不再有第二份凭证解析；两处都不再做 apply 期凭证快照。
3. `TushareRestOptions` 增加可选 `tokenProvider?: () => string | undefined`（`src/rest.ts`），
   `requestApi` 在**每次请求**处解析（provider 优先、静态 `token` 仅作直调兼容兜底），
   `TRADING_CREDENTIALS_MISSING` 的 fail-closed 判定改用解析结果。

## Verification

- `packages/connector-tushare/test/dataplane-loader.test.ts` 新增 3 例，走**加载路径**（`resolveConfig`
  解析行 config → `dataplane.apply` → 从注册表取真服务取数），用记录请求体的契约化传输替身，
  不引入任何通用 mock 工具：设置页 Token 生效且优先于 env；无设置中心凭证时回落 `tokenRef`
  指向的自定义环境变量；apply 之后补上设置中心 Token，下一次请求即生效（首请求 fail-closed 且不出网）。
- 反向验证（mutation）：把 dataplane 的 provider 换回 `() => process.env[config.tokenRef]`，第 1、3 例
  即失败（`expected [ 'tok-from-env' ] to deeply equal [ 'tok-from-settings' ]`），env 回落例仍过——
  用例确实钉住本次修复，而非跟着实现走。
- `pnpm --filter @dshtrading/connector-tushare build` 通过；`node scripts/connector-dataplane-config-gate.mjs`
  仍绿（数据面入口照旧导出 `Config` schema）；`node scripts/test-audit.mjs` 无新增测试债
  （新增用例标题带角色前缀、正文含 Given/When/Then）。

## Alternatives considered

- **在 dataplane 里再手抄一份 thunk（hithink/jin10 现状）**：同一解析逻辑出现两个家，主入口与数据面
  还会再漂移——改为共享 `createTokenProvider`。
- **把 `token` 直接改成 `() => string | undefined`**：破坏 `new TushareRestClient({ token })` 的直调用法
  （README 的出网复跑命令、离线用例都在用）——改为新增可选 `tokenProvider`，静态 `token` 保留。
- **靠 env 注入 / `launchctl setenv`**（kit-cn 同款备选）：只对新进程生效、与设置中心形成双写真相——放弃。
- **在 dataplane `apply` 期先把凭证读出来传给服务**：settings 用户层加载晚于插件 apply，快照会落空——放弃。

## Consequences

- 设置页写入的 Tushare Token 在宿主面数据行与工具面都生效，改 Key 下次请求即生效；`env[tokenRef]`
  继续作为兜底，缺凭证时 fail-closed 而非静默回落。
- 桌面实例生效需重建本包并刷新 profile 副本后重启（本次未执行部署/刷新）。
- 未加 changeset（发布与版本 bump 需显式请求）。
