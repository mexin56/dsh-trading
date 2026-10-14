# Agent Note: 桌面壳内置默认 home（Dock 直点可用）

Status: implemented

## Problem

DSH_HOME 分离（见 [2026-09-08-separate-dsh-home](2026-09-08-separate-dsh-home.md)）后，桌面壳 Dock 直点不带 env，home 解析回落 ~/.dsh：在旧 home 重新播种 trading-web 残株 profile、被 web 宿主 home 级 cordis.patch.yml 的第三方插件引用毒化（ERR_MODULE_NOT_FOUND 启动失败，2026-09-08 10:36 实证），且插件数据分裂。「用户须用 open -a --env 或脚本启动」对普通用户不成立——点图标就必须是对的。

## Decision

desktop/src/runtime.cjs 的 selectDshHome 缺省从 ~/.dsh 改为 ~/.dsh-trading：这是 DSH Trading 专用壳，它管理的 home 就该内置为 trading home。宿主 dsh CLI 自身缺省仍是 ~/.dsh——两处缺省不同是刻意的（通用宿主 vs 专用壳）。scripts/home/dsh-trading-desktop 与 --env 启动方式继续可用，只是不再必需。

显式 DSH_HOME 的沿用判据（2026-10-14）：只有它的路径含 `-trading` 时才沿用（`isTradingHomePath`，与 CLI wrapper `scripts/home/dsh-trading` 的 `case "${DSH_HOME:-}" in *-trading*` 是同一条判据）；其余一律忽略、回落 `<homedir>/.dsh-trading`，并由 main.cjs 打 `[desktop] ignored inherited DSH_HOME=<值> (not a trading home); using <回落 home>`；空白仍视为未设。判据落在展开之前的原文上，`~` 与 `~/x` 的展开语义对**被接受的**值不变（`~/.dsh-trading`、`~/probe-trading`）。代价：冒烟/取证用的独立 home 必须命名成 *-trading。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

- Dock/访达直点桌面壳即可正确启动：播种、数据、profile 全落 ~/.dsh-trading。
- 已装旧版 app 不受此 commit 影响——本机通过重打包或就地修补生效，随下一 release 对全部用户生效。
- 测试：desktop/tests/runtime.test.mjs 覆盖未设/空白/含 `-trading` 沿用（含 `~/x-trading` 展开）/非 trading 忽略并回落五类分支。
- 继承来的 `DSH_HOME` 不再能压过内置缺省：非 trading home 的显式值被忽略并告警，`dsh-host.log` 的 `[desktop] ignored inherited DSH_HOME=…` 行是判据生效的证据；2026-10-14 该坑再次命中后的改判见 [2026-09-11-desktop-shell-local-rebuild-open-env-pitfall](2026-09-11-desktop-shell-local-rebuild-open-env-pitfall.md)。
