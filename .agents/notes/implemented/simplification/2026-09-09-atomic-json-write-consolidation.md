# Agent Note: home 数据文件原子写收敛（writeJsonAtomic 上收 @dshtrading/dsh-home）

Status: implemented

## Problem

tmp+rename 原子写块在 7 个包有 9+ 处同体副本（只读审计 F1）：watchlist file-store ×3 调用点、indicators custom-fs/chart-activations-fs、strategies custom-fs/custom-screener-fs/builtin-tombstones-fs、knowledge knowledge-fs、holdings fs-atomic.ts（唯一已抽函数的）。漂移已实证：2026-05-23 dd614b2 曾一次性补 4 份副本的同一缺陷；chart-activations-fs 的 tmp 清理走动态 import 的 unlink（静态导入版漂移）。

## Decision

- 唯一实现落 @dshtrading/dsh-home（writeJsonAtomic）：tmp 唯一名（独占创建）、EPERM/EBUSY 25ms 退避重试 3 次、失败保留旧文件 + 清 tmp + log + throw。
- 耐久性（2026-10-12 补强）：rename 前对 tmp 的**文件描述符** fsync、rename 后对**父目录** fsync，让新内容与「改名已发生」各有落盘点。目录 fsync 只在平台/文件系统明确不支持时（Windows 无法以文件句柄打开目录；部分网络盘返回 ENOTSUP/ENOSYS）记一行告警后跳过，EACCES/ENOENT/IO 等其余同步错误一律上抛——「无法确认耐久」不静默降级；同步失败仍清 tmp 且不吞原始错误。
- 归属判据：dsh-home 是「home 数据文件」包且 7 个消费包全部已依赖它——零新依赖边、零 profile overrides 同步成本；base 是 cordis bundle（库包依赖它会倒转依赖方向），新建包踩实证 overrides 坑，均否决。
- logPrefix 参数保留各调用方既有失败日志逐字不变（前缀含包名与对象名）。
- holdings/fs-atomic.ts 删除，store-fs.ts 与 fx.ts 直引 dsh-home。
- **刻意排除** client-ui-trading/tasks/ledger.ts：sync + fsync + chmod 600 的台账持久化变体是刻意的耐久语义（崩溃窗口 + 文件权限），与异步 tmp+rename 不同构，不收敛。
- watchlist 的 3 个写路径（自选/分组/选中）在 2026-10-09 整体改走 `transactStore`（锁内读改写），不再有独立的 safeAtomicWrite 薄封装。
- 本入口**只管「一次写入不产生半截文件」**：跨进程「两进程整表回写互相覆盖」是另一条缺口，
  由同包兄弟入口 `withHomeFileLock`/`transactStore` 在 store 粒度按 id 合并解决（2026-10-09，
  见 [跨进程写保护记录](../bug-fix/2026-10-09-cross-process-store-merge-write.md)）。不把合并
  逻辑塞进 `writeJsonAtomic`：它拿不到条目身份，按 id 盲并会复活墓碑；且读-改-写必须整体入锁
  才有意义，只给写加锁仍是用陈旧快照覆盖。

## Alternatives considered

- 落 @dshtrading/base：base 只被 all(bundle) 依赖，库包依赖 cordis bundle 包会倒转方向，否决。
- 新建 @dshtrading/store-kit：新包要同步全部 profile pnpm overrides（复制手册实证成本），7 包已全依赖 dsh-home，否决。
- 连 ledger.ts 一起收敛：其 sync+fsync+chmod 是台账刻意的崩溃耐久语义，强并会破坏保证，否决。

## Consequences

- 原子写缺陷修复今后只改一处；新增 store 直接 import。
- 测试：dsh-home 的 writeJsonAtomic 用例覆盖正常写入、覆盖旧内容、父路径是文件、目录 fsync 无法完成时明确失败（POSIX 权限条件）、不可写目录清 tmp 保旧文件；watchlist / indicators / strategies / knowledge / holdings 全绿。
