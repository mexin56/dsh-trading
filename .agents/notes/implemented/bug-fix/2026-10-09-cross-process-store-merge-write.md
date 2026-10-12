# Agent Note: 多进程共用 DSH_HOME 的整表 store 跨进程写保护（锁内读改写）

Status: implemented

## Problem

2026-10-09 实测事故：桌面端（pid 11571，加载 `~/.dsh-trading`）与一个 CLI 实例共用同一
home 期间，14:45:47 `~/.dsh-trading/indicators/chart.json` 被写成 `active_buy_real.symbolParams`
与 `hiddenScopes` 皆 null（4838B），图表「主动买盘」副图因此空白；15:06 文件变 5137B、数据
「自己回来」——那是另一进程内存里还留着旧快照又被刷回，是运气不是机制。

根因不是原子写：`writeJsonAtomic` 的 tmp+rename 保证单次写入不产生半截文件，但下列 store
都是「进程内内存缓存 + 整表回写」，两个进程各自持一份缓存、各自把整表写回，后写者用自己
那份**陈旧快照**覆盖先写者的累积数据（last-writer-wins，静默无告警）。进程内已由 cordis
Service 单实例收口（见 [strategy-store-singleton](2026-09-07-strategy-store-singleton.md)），
缺口只在跨进程。

## Decision

跨进程写保护收口到 `@dshtrading/dsh-home`，三个导出构成**唯一**实现，各 store 只调用它们：

- `withHomeFileLock(filePath, work, options)`（`src/file-lock.ts`）：跨进程排他锁。锁文件
  （`<file>.lock`）经「把完整身份写进唯一 staging 文件 → `link` 到锁路径」原子创建，所以锁路径
  一旦存在就带 **owner 身份**（pid + host + 每次获取唯一的 token + 获取时刻），没有「先建空锁、
  再补身份」的未知窗口（文件系统不支持硬链接时退回 `open('wx')` 独占创建 + 写身份）。持锁期间的
  心跳只在锁仍归本实例时刷新 mtime。回收判据是**可证明的死亡**：owner 在本机（host 相同）、其 pid
  经 `process.kill(pid, 0)` 确认已不存在、且 mtime 超过 `staleMs`（缺省 30s）——活着的 owner、
  异机 owner、读不出身份的锁一律不回收（等锁超时）。抢占用 `rename` 原子裁决，抢到后复核 token；
  若抢到窗口里被重建的新锁（尤其活 owner）则用 `link` 原样放回（不覆盖已存在的锁路径），绝不误删
  活锁。等锁超时抛 `HomeFileLockTimeoutError`。
- 归属复核：`withHomeFileLock` 把句柄交给 work；`lock.assertOwned()` 在提交前按 token 复核「这把锁
  现在是否仍归本实例」，被顶替抛 `HomeFileLockLostError`；释放时同样按 token 判断，只删自己的锁，
  绝不按路径盲删新 owner 的锁。
- `transactStore(filePath, readFromDisk, mutate, serialize, logPrefix)`（`src/store-transaction.ts`）：
  **锁内新鲜重读磁盘 → mutate 在新鲜值上做本次修改 → 提交前 `assertOwned()` → 原子写**。mutate
  返回 `SKIP_WRITE` 表示无内容变化（不落盘，沿用既有「无变化不重写」语义），函数返回锁内新鲜值
  供调用方刷新缓存。
- `createStoreCache(filePath, readFromDisk)`（`src/store-transaction.ts`）：整表 store 的读缓存。
  `load()` 每次先 `stat` 目标文件核对签名（dev/ino/size/mtimeNs/ctimeNs），签名未变才用缓存，变了
  就重读——另一个实例确认落盘的写因此在下一次读取可见，缓存不会永久命中。`replace()` 只在
  `transactStore` 成功返回后调用；写失败不发布本实例缓存。

**冲突语义（选定）：先读回并在对方结果上继续改（读-改-写整体入锁），而不是拒绝第二实例写。**
本机桌面端与 CLI 长期共用同一 home 是既定用法，粗暴拒绝会让第二实例完全存不了设置；而
「各持缓存、整表回写」又是丢数据的根源，所以正解是让每次写都先看到对方已落盘的事实。
明确失败的出路保留给两种情况：**拿不到锁**（`HomeFileLockTimeoutError`）与**提交前发现锁已被
顶替**（`HomeFileLockLostError`）：宁可按明确错误失败，也绝不按陈旧快照静默覆盖。

**不落在 `writeJsonAtomic` 内**的两个理由：(1) 原子写只应负责「一次写入不产生半截文件」，
让它去重读并合并会把它变成读改写器，职责错位；(2) 它拿不到条目身份，按 id 盲并会**复活
墓碑**（见下 Alternatives）。因此 `writeJsonAtomic` 保持原语义（见
[atomic-json-write-consolidation](../simplification/2026-09-09-atomic-json-write-consolidation.md)），
跨进程保护作为同包兄弟模块按 store 粒度接入。

合并粒度是**条目**：行表按 id、嵌套表按各自键。同一 id 被两个进程同时改时，后写者在该 id
上的整条值胜出（刻意不做字段级三方合并，见 Residue）。

### 接入清单（8 个 store 全覆盖）

| store | 写路径 | 并发用例 |
|---|---|---|
| `indicators/src/chart-activations-fs.ts` | `transactStore`（activate/deactivate/replaceAll） | `test/chart-activations-concurrency.test.ts` |
| `indicators/src/custom-fs.ts` | `transactStore` | `test/custom-fs-concurrency.test.ts` |
| `holdings/src/store-fs.ts` + `store-core.ts` | driver `transact` → `transactStore`，八条写路径同源 | `test/store-concurrency.test.ts` |
| `knowledge/src/knowledge-fs.ts` | `transactStore` | `test/store-concurrency.test.ts` |
| `strategies/src/custom-fs.ts` | `transactStore`（归档 sidecar 在锁外追加） | `test/custom-fs-concurrency.test.ts` |
| `strategies/src/custom-screener-fs.ts` | `transactStore` | `test/custom-fs-concurrency.test.ts` |
| `strategies/src/builtin-tombstones-fs.ts` | `transactStore`（Set ↔ 表适配） | `test/custom-fs-concurrency.test.ts` |
| `watchlist/src/file-store.ts`（watchlist/groups/selection） | `transactStore`，进程内 enqueue 保留 | `test/file-store-concurrency.test.ts` |

无 store 刻意不接入。两个形状特例在接入时就地说明，不改变对外契约：

- `chart-activations-fs.ts` 的 `replaceAll` 是刻意的**整表替换**（一次性迁移导入，桥另有
  「非空拒绝」幂等闸门），只取锁不并入磁盘既有内容——替换就该只留本次内容。
- `watchlist/src/file-store.ts` 的 `selection` 是**单值**记录（「当前选中标的」），没有可按
  id 合并的条目语义，本来就该后写者胜；它同样走锁内读改写，只是值恒被整条替换。

## Alternatives considered

- **只给 `writeJsonAtomic` 加锁（或加「锁 + 写」）**：仍然是「调用方那份陈旧整表」写回，
  只是把覆盖窗口缩到锁内，丢数据照旧；写保护必须把**读**也拉进临界区。
- **写完后按 id 盲并（union）**：会把调用方在本进程里删掉的 id，用磁盘上对方仍在的行**复活**
  ——墓碑/删除语义直接破功（`deactivate`/`remove`）。正确形态是删除也在锁内基于新鲜值判定。
- **只在进程内加锁**：2026-09-08 审查 H1 已否决——锁在同一进程内无法区分两个 store 实例的
  缓存，且跨进程无效；本任务要解的正是跨进程缺口。
- **flock/fcntl**：Node 无内建 flock 绑定，Windows 与网络盘语义不一致；锁文件三平台一致且
  崩溃后可由后来者按「本机 owner + 已确认死亡」回收，不依赖持锁者自己清理。
- **冲突时 fail-closed 拒绝第二实例写**：桌面端 + CLI 共用 home 是既定用法，拒绝会让第二实例
  完全存不了设置；因此只把「拿不到锁」与「提交前锁被顶替」保留为明确失败。
- **改用 SQLite**：对若干张扁平 JSON 表引入新依赖与全部既有 home 的数据迁移，收益与成本不匹配；
  本仓既有磁盘格式与消费方（桥/工具/客户端）都按 JSON 表约定，改动面远超本缺陷。
- **每个 store 各自复制一份临界区**：正是
  [atomic-json-write-consolidation](../simplification/2026-09-09-atomic-json-write-consolidation.md)
  已付过学费的漂移形态（7 包 9+ 处同体副本），不再重演。

## Consequences

- 两个进程各自新增的行都留在盘上（实测 `A 写 id1 → B 写 id2` 后磁盘含两条）；删除不会被
  对方的新增或本进程旧快照复活，两进程各删一条时两条删除都落盘。
- 同一 id 被两进程同时改时，后写者在该 id 上的整条值胜出（Residue：无字段级三方合并）。
- 锁文件是瞬时产物（`<file>.lock`）：owner 崩溃后由后来者按「本机 + pid 已死 + 陈旧阈值」回收；
  异机或身份未知的陈旧锁不自动回收（只能人工删除）——这是刻意的 fail-closed，宁可停等也不冒
  双写风险。正常路径不产生 `.lock`/`.owner-*`/`.tmp` 残留。
- 跨实例读：每次 `list()`/`snapshot()` 先核对磁盘签名，另一实例已确认的写在下一次读取可见；
  写失败时本实例缓存保持旧值，不会出现「缓存里有、盘上没有」。
- 每次写多一次锁 staging 文件创建 + `link` + `unlink` 与一次读盘；读路径每次多一次 `stat`；写频率是设置级（用户操作触发），代价可忽略。
- 无磁盘格式变化、无版本号变化、无迁移；老实例写入的数据仍按原形状读取。
- `holdings` 的 `HoldingsBookDriver` 新增可选 `transact`：file store 提供、memory store 缺席
  （内存版无跨进程缺口），八条写路径共用同一 plan 闭包，契约 §2 语义（校验顺序、revision
  自增、幂等 no-op）不变。

## Verification

- 复现（修复前红）：`packages/indicators/test/chart-activations-concurrency.test.ts` 修复前
  `expected [ 'ema' ] to deeply equal [ 'active_buy_real', 'ema' ]`；接入后同用例转绿。
- 新增用例：dsh-home 层 5 例（排他/超时明确失败/陈旧回收/两次事务追加/无变化不重写）、
  8 个 store 的跨实例并发用例（含删除-删除、加-加两组方向）。
- 锁归属与读新鲜度（2026-10-12 补强，用例均先红后绿）：`dsh-home/test/store-transaction.test.ts`
  的活 owner/未知身份不被回收、释放不删新 owner、提交前被顶替明确失败；`dsh-home/test/fs-atomic.test.ts`
  的目录 fsync 无法完成时明确失败、不可写目录清 tmp 保旧文件；`dsh-home/test/store-cache.test.ts`
  的磁盘签名变化重读、写失败不发布；7 个 store 并发用例新增「两个实例都读过之后，桌面端新增对
  CLI 下一次读取可见」，holdings 另加「写盘失败不出现未落盘持仓」。connector-polymarket 的快照表
  本就没有进程内缓存（读走锁内新鲜读），补一条跨实例回归用例。
- 多进程实测（隔离 `/tmp` home，非内存双实例）：8 个 store 各起两个真实进程并发写不同 id，
  磁盘最终含双方数据；同条件对照的旧机制（`writeJsonAtomic` + 整表回写）丢数据。见报告。
- 门禁（HEAD 现场）：`pnpm build`、`pnpm -r test`、`pnpm test:audit`、`pnpm i18n:check`、
  `pnpm coverage:check`、`node scripts/typecheck-gate.mjs` 全绿。
