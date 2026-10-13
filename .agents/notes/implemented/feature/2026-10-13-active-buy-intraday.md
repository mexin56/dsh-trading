# Agent Note: A股主动买盘副图盘中实时化（宿主内置 aux 指标 + 桥端点，数据内嵌式退出）

Status: implemented

## Problem

用户报告：图表「主动买盘」副图在**盘中是空白**，当日值要等收盘后（15:05 采集任务跑完）才出现。

根因在数据通路而非渲染。该副图原本是一个**自定义指标** `active_buy_real`：`computeSource` 把 `snapshots.jsonl` 编译成源码里的 `DATA` 常量（由 `cowork/data/active-buy/build_indicator.py` 生成），只在每交易日 15:05 采集任务跑完 close 轮之后经 `indicator_author` 重投一次。当日 bar 在 15:05 之前没有任何日期键 → 空白。图本身有当日 bar（`QuoteStage.withTickerBar` 用 ticker 合并最后一根 K 线），所以缺口只在指标数据。

内嵌式这条通路另有三个硬边界，本次一并解决：

1. **自定义指标契约没有取数能力**：`IndicatorDefinition.compute` 是纯同步函数，自定义指标更是只有 `computeSource` 一个入口，所以外部数据只能编译进源码（`aux`/`computeAux` 缝当时只对内置 definition 生效）。
2. **源码上限 16KB**（`indicators/src/validate.ts` 的 `MAX_SOURCE_LENGTH`）：5 标的 × 120 交易日 ≈ 19.5KB，约再攒 100 个交易日重建就会失败、副图停更。
3. **每次更新都要起一个 agent 会话**，且落库是「整表 store + 进程内缓存」，多宿主共用同一 home 时曾互相覆盖（[cross-process-store-merge-write](../bug-fix/2026-10-09-cross-process-store-merge-write.md)）。

## Decision

**把「主动买盘」从「内嵌数据的自定义指标」改成「宿主内置指标 + 桥端点读本地数据集」**，四层各司其职，接口一次冻结：

1. **契约与连接器（可选能力）**：`@dshtrading/api` 新增 `ActiveBuySnapshot` 与 `MarketDataService.getActiveBuySnapshot?(symbol)`（紧邻 `getSouthboundHoldings?`，同族可选能力写法）。`connector-tencent` 的 **cn 实例**实现它——复用既有的 `#fetchQuoteFields` 报价行（`f6` 总量 / `f7` 外盘 / `f8` 内盘 / `f30` 时间戳 / `f47`/`f48` 涨跌停价）：复用同一条取数与解析路径、不另开端点，但该路径**没有进程内缓存**，所以每次调用仍各发一次报价请求（`getTicker` 后再 `getActiveBuySnapshot` 实测请求计数 1 → 2）；hk 实例**方法缺席**（类体声明会让两个市场实例都长出该能力，故按 `connector-eastmoney` 的 hk 港股通持股先例在构造函数内按市场条件挂载 + `declare`）。
2. **桥端点**：`GET /dshtrading/api/active-buy?market=cn&symbol=` 是**唯一**读这份数据集的地方，返回 `{ok, symbol, points[], live?}`。`points` 由文件按 `(symbol,date)` 归并而来（同 `phase` 取 `time` 最晚）、升序、最多 250 个交易日。**当日取值分三层**（初版只按「今天有没有行」判，独立验收实测出「今日有 manual 行就冻结盘中刷新」的副作用后改正）：① 文件里今天有 `phase === 'close'` 行 → 用它，且不注入 live（终值优先）；② 否则能力可用、快照日期是上海今天、**且快照自身的交易所墙钟时刻落在 `09:15:00 ≤ time ≤ 15:05:00`** → 当日点是 **live 点**并回填 `live.at`，同日文件行让位（同日只出一条；下界在集合竞价之前、上界给收盘集合竞价与结算抖动留余量）；③ 否则今天只有 manual 行 → 取该日**最晚**一条兜底。**能力缺席 / 调用抛错 / 上游日期过期 / 快照时刻在会话之外一律只返回文件历史**——不报 500、不补 0、不编值；非 cn 市场固定返回空序列。**收盘后当日终值必须来自采集到的 close 行**：live 只在 `09:15–15:05` 的会话窗口内注入，漏采（且当天没有 manual 行）就是空白——2026-10-13 实测过反例：宿主停机导致 15:05 那轮没采，16:53 接口仍返回 `phase:"live"`（快照时刻 `16:14:30`），图上会挂着「盘中」徽标过夜、而且那个值并不在数据集里；这条门控因此是「缺口一眼可见」而非「多显示一点」。能力解析是「active 优先 → 按 provider 名排序扫注册项 → 都没有则只回历史」三段式（registry 完全缺席时保留 `getMarketService` 的 legacy 路径）。数据文件是 `<trading home>/active-buy/snapshots.jsonl`，`DSH_TRADING_ACTIVE_BUY_FILE` 可整体覆盖（测试与隔离演练用）。
3. **指标**：新增内置预设 `active-buy`（`pane: 'sub'`、`markets: ['cn']`、`aux: ['cn-active-buy']`、`defaultApplyScope` 只勾 `1d/1w/1M`，同 [hk-connect-holding](2026-10-12-hk-connect-holding-indicator.md) 的决策 7）。`computeAux` 出两条：「净买」柱 = aux 原值（`netSharePct`），「买占」线 = `(100 + 净买)/2`。对齐**不用**通用前向填充 `alignAuxToBars`（那是给水位序列如港股通持股比例用的），而是预设局部的**区间精确匹配** `alignAuxToBarCoverage`：每根 bar 只取自身覆盖区间内的最新一条点（日线 = 当日精确匹配；周/月 = 区间内），区间内无点即 `undefined`、**绝不跨缺失区间沿用**。空序列返回 `[]` → 副图整体隐藏（空 ≠ 0，同款纪律）。
4. **客户端**：按 `${market}:${symbol}` 首取一次（不依赖交易时段与标签可见性），并在 **cn 交易时段窗口内每 5 分钟**复取（窗口判据是纯函数 `isCnPollingWindow`：Asia/Shanghai **周一至周五** 09:25–11:32 / 12:58–**15:12**；它**不含交易日历**，工作日节假日会照常轮询、读数不变——与本仓「不维护节假日历」的既有口径一致）。复取失败或空序列**保留上一次真实序列**，不清空、不造值。**尾段延到 15:12 是为了覆盖 15:05 采集任务的落盘时刻**：close 行落盘后的第一次复取会把 live 点换成 close 点、`liveKeys` 随之清空（独立验收实测旧尾段止于 15:02:59，已打开的页面永不收敛、徽标可留到次日）；15:00 收盘到 close 行落盘之间取数仍是 live 点、徽标仍显示「盘中」，但数值就是当日终值读数——这段差异有意保留，不按时间猜徽标（节假日没有 live 点，数据门控已保证徽标不撒谎）。竞态守卫改为**代际隔离**，覆盖 A→B→A 时旧应答不得覆盖新标的。副图标题的「盘中」徽标**由数据驱动**（本轮取数里该键确实拿到了 `phase==='live'` 的点）。
5. **数据集落点**：`snapshots.jsonl` 从 `cowork/data/active-buy/` 迁到 **trading home**（`~/.dsh-trading/active-buy/`，写入侧 `snapshot.py` 带「拒绝 `~/.dsh` 及路径别名」的 home 守卫）；采集脚本与 `symbols.txt` 留在研究工作区，cowork 侧只留脚本与说明。旧的三件退役产物（`build_indicator.py` / `indicator_source.js` / `indicator_meta.json`）在 cowork 仓留有基线提交，可回溯。
6. **旧指标退役**：自定义指标 `active_buy_real` 及其 5 份 per-symbol `sym` 绑定被内置预设取代——序列天然按标的分，不再需要「把数字代码当参数传」的错绑隐患。

## Alternatives considered

- **保留内嵌数据、把采集+重建频率提到盘中（不动仓库代码）**：最贴合现状、当天可用。否决——每 5 分钟一个 agent 会话只为刷一个读数，且 16KB 上限与「跨进程整表重建」两个结构问题原样留着；用户明确选了彻底方案。
- **给自定义指标契约加 `aux`/`computeAux`（保留内嵌历史 + 只注入当日 live 点）**：改动比新建内置预设大（要扩 `computeSource` 之外的第二个源码入口、校验、存储、桥与工具面），而且内嵌历史与 16KB 上限都留着。否决。
- **两个 aux 键（净买、买占 各一条序列）**：能让「买占」用源记录值而非派生值。否决——取数翻倍且要与「一轮 HTTP 复用」的缓存语义纠缠；而两者之差只有「未归向成交残差 / 2」（本数据集 5 标的实测 ≤0.036 个百分点，见 Consequences），比读图分辨率低一个量级，代价不值。
- **客户端直连 `qt.gtimg.cn`**：绕开桥与连接器。否决——跨域，且把上游契约散进浏览器半；本仓纪律是取数归连接器、浏览器半只消费宿主桥。
- **只认「当前路由服务」不跨 provider 解析**：桥本可只问 `registry.active('cn')`。否决——cn 有 tencent/qmt 两个候选，路由一旦切到 qmt，当日 live 点会**静默消失**，正是本次要修的症状。改用与 `southboundHoldings` 同款的「active 优先 → 按 provider 名排序扫注册项」三段式（registry 完全缺席时保留 `getMarketService` 的 legacy 路径）。
- **盘中不显示、只在收盘后立刻出**：等于维持用户抱怨的行为。否决。

## Consequences

- 用户可见：cn 标的挂上 `active-buy` 即可，**当日柱在盘中就有值**并每 5 分钟自刷；交易时段窗口内该组副图标题显示「盘中」徽标（数据驱动）。**收盘后当日值只来自采集到的 close 行**：live 只在会话窗口内注入，漏采且当天无 manual 行时当日柱是**空白**（缺口一眼可见，不插值、不估算）。**未采集但当天有 live 读数的标的**（会话内）会得到一根只有今日、没有历史的点——数据本身真实，但别把它当成「有采集记录」；若要恢复「只服务已采集标的」的 fail-closed 语义，得在桥里加一道文件存在性判据（本次未做）。
- **口径与派生值**：aux 序列的值是 `netSharePct`（净主动买占当日总量 %）；「买占」线由恒等式 `(100 + 净买)/2` 现算，其前提是「外盘 + 内盘 ≈ 当日总量」——该差值是**未归向成交**（集合竞价与价间成交计入总量却不计入内外盘），量级不固定：本数据集 5 标的**已记录行**实测上限 0.071%（517520 2026-09-18），派生差 ≤0.036 个百分点；但**不能把这个上限推广到盘中全市场**——独立验收用同一条解析路径重放 600519 的单条报价行得残差 0.629%、派生买占 52.845 对源 52.53（差 0.315 个百分点）。这是**有意的单序列取舍**（代价是与源记录 `buySharePct` 相差「残差 / 2」），代码注释与指标 `description` 都写明了前提；若将来要逐日精确等于源读数，出路是拆成两条 aux 序列。
- 契约面：`MarketDataService` 增加一个可选方法（additive，存量连接器零迁移）；`IndicatorDefinition` 增加可选 `description`，并在 `indicator_list`／`resolveIndicatorSpec` 透传——预置指标从此也能带口径说明（GUI 目前没有渲染它的位置，真实消费方是 agent 工具面与桥的 spec 面）。
- 工具面：`cn_get_indicators` 默认集合多出 `active-buy`，以「需要宿主行情副图数据（本工具面不可用）」一行呈现（与 `hk-connect-holding` 同款，不假装算出空序列）。
- 数据面：数据集单份住在 trading home，退出 cowork 工作区的 Syncthing/git 备份范围；写侧脚本的 home 守卫与门禁 `home-guard:check` 同源（测试用 `DSH_TRADING_ACTIVE_BUY_FILE` 整体覆盖 + 临时 `DSH_HOME`，故用 `home-guard-allow:` 显式豁免并写明理由）。
- 15:05 采集任务只剩「采集 + 记日志」：不再跑 `build_indicator.py`、不再调 `indicator_author`、不再重放 per-symbol 激活。
- 已知边界：`fetchedAt` 用带偏移的 ISO 渲染（不用 `toISOString`），读数不随宿主时区漂移；桥除 ENOENT 外的文件 IO 错误仍然传播（只把「缺文件」与「坏行」当降级）；同一条路径的 250 日截断意味着更早的历史不在图上（数据集本身 append-only，不截断）。

## Verification

- 门禁（`pnpm gates:all`，HEAD `9f9fd857` 现场复跑；独立验收者另跑一次同结论）：**16 通过 / 0 失败**。此前唯一红项 `tool-contract:check` 是**存量**矛盾——`packages/knowledge/src/tool.ts` 的 `*Json` 参数已在 `6d4c92d9`（issue #100）改为 `type: 'json'`，而 `f20e3ff4` 引入的冻结快照仍记 `"type": "string"`；该矛盾由同一分支并入的 `b4709461` 修掉（重跑 `--update` 的 diff 恰为 8 行 `string → json`：holdings `itemsJson` + knowledge_ingest 的七个 `*Json`，无其它漂移），不是本特性的行为改动。**整改后的最终 HEAD 现场复跑为 15 通过 / 1 失败**：唯一红项 `test:scripts` 里 `scripts/futu-openapi-bridge.test.mjs` 的 `beforeAll` 启动真进程超时，是**环境依赖**——该桥在模块级就 `OpenQuoteContext(host, OPEND_PORT)`，而本机 Futu OpenD 未监听（`11111`/`11112` 均 closed，其前置条件写明「FutuOpenD 已启动并登录」），本批提交一笔未碰 `scripts/futu-*`（同一门禁在更早一轮 5.6 秒通过）；其余 15 条——含 `-r test`（四包 45/252/119/429）与 `coverage:check`/`typecheck-gate`——全绿。
- 包测试（含整改后）：`connector-tencent` 45 例、`bot-api` **252** 例、`indicators` **119** 例、`client-ui-trading` **429** 例全绿；测试棘轮（`test:audit`）无新增债。
- **独立验收（另一会话、fresh 上下文，绑 `9f9fd857`）：判定 FAIL**。它自行复跑 `gates:all` 得 16/0、四包数字逐个复现（45/240/115/427），但用真实 React hook 与预设本体重放出两条确定性缺陷（见下「整改」），并明确「不因单测全绿改判」；强制项的宿主 E2E 因宿主进程无监听而未完成。**该判定已被接受**——本记录的状态是「已交付 + 已按验收结论整改」，不是「已验收」。
- **整改三处**（都在初版之上）：
  1. 指标对齐不再前向填充（反例回归钉住：aux 只有 `2026-10-12` 的点 → bars `10-12/10-13/10-20` 得 `[8.25, undefined, undefined]`）；同一反例喂 `hk-connect-holding` 仍得 `[8.25, 8.25, 8.25]`，水位语义零回归。
  2. 客户端轮询尾段 `15:02 → 15:12`（覆盖 15:05 落盘），新增两条真实 hook 用例：「尾段复取到 close 后更新终值并落下徽标」「空响应与失败保留真实序列、恢复可见后收敛 close」。先按旧判据跑红（期望 close 9.99 实得 6.73）再改实现。
  3. 桥当日取值改三层（close 优先 / 否则 live / 否则最晚 manual），修掉「今日有 manual 行就冻结盘中刷新」；同样先只改测试拿到红（manual 52 对期望 live 65）再改实现。
  4. 桥的 live 注入补**会话门控**（快照自身墙钟 `09:15:00 ≤ time ≤ 15:05:00`）：2026-10-13 现场发现宿主停机导致 15:05 那轮没采、16:53 接口仍在返回 live（快照时刻 `16:14:30`），收盘后图上会挂「盘中」徽标过夜且该值不在数据集里；owner 裁定为「收盘后当日值只来自采集到的 close 行，漏采即空白」。先只改测试拿到红（5 失败 / 24 通过）再改实现，新增 8 个时刻矩阵判据（含精确上下界与界外一秒）。
- 连接器真实证据：`spikes/impl-active-buy/` 存 4 份 curl 原始 GBK 响应 + `r3-parse.mjs`（把落盘字节喂回 `rest.ts` 本体重放，只有取数时刻是注入值）；数值向量 总量 91083 / 外盘 43668 / 内盘 47410 → 买占 47.94、净买 −4.11。该脚本默认只打印、`--write` 才刷新证据快照（复跑不再写脏工作区）。
- 桥端到端：`dispatchBridgeRequest(GET, '/active-buy')` 实返各层 JSON（close 62 + manual 70 + live 75 → 只出 close；manual 48/52 + 会话内 live 65 → 出 live 且带 `live.at`；只有 manual 且能力缺席/盘后 → 出最晚那条 manual；快照 `16:14:30` 或 `09:10:00` 或非今天 → 当日空白且 `live` 缺席）；坏行跳过、非 cn 空序列（注入有能力的服务也仍为空）、250 日截断、上游过期拒注入各有判据；能力解析三条分支（active 优先 / qmt 无能力时取排序后 tencent / 全无能力只回历史）各有判据。
- **2026-10-13 现场事故与收尾**：宿主在为刷新 profile 停机期间跨过了 15:05，采集轮没执行；16:52 的 catch-up 又因存量工作区注册表缺陷失败（另开卡 `260e7cfc` 跟踪），数据集因此缺当天 close 行、接口按第 2 层继续返回 live。owner 裁定后人工补采（`DSH_HOME=~/.dsh-trading python3 …/snapshot.py`，幂等）写入 5 条 `2026-10-13` close 行（数据集 50 → 55 行，补采时刻 16:59、源快照时刻 16:14），接口随即回到第 1 层（`phase:"close"`、无 `live`）、徽标不再挂；补采与漏采原因已记入 cowork 的 agent 轨日志。
- 客户端：5 分钟窗口边界（09:24/09:25/11:32/11:33/12:58/15:02/15:12/15:13/周末）各有判据；复取失败不清空已有序列、A→B→A 在途旧应答丢弃、空序列隐藏副图、数据驱动徽标各有判据；`i18n:check` 绿（`indicator.live` 三处一致）。
- 部署后端到端（2026-10-13 盘中，trading-web profile 刷新并重启实例之后，**整改之前**）：`GET /dshtrading/api/active-buy?market=cn&symbol=002714.SZ` 返回 2026-10-13 的 `phase: "live"` 点（11:08:12，买占 42.05 / 净买 −15.88），即当日柱在盘中有值；自有 CDP 无头实例（非用户 Chrome）截图显示副图读数行「主动买盘 盘中 净买: 16.48 买占: 58.24」，其中 58.24 = (100 + 16.48) / 2 与恒等式一致。旧自定义指标 `active_buy_real` 已从图表名册与自定义指标名册摘除（记录先备份到 `~/.dsh-trading/backup/`）。
- **未验证（如实标注）**：① **整改后的宿主 E2E 尚未复验**——需重建 `lib/`、刷新 profile 并重开实例，再核当日 `live` 点、`market=us` 与未采集标的的降级、指标名册「新在旧不在」；② 真实 15:05 落盘后的收敛只能在部署后按时间观察；③ 图表 canvas 的响应式矩阵未覆盖（jsdom 挂不起 lightweight-charts，图表侧只有上述真实截图证据）。
