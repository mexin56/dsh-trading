# Agent Note: 量比分档量能：五日成交量档位着色泛化为全级别预置指标 + 默认勾选补种

Status: implemented

## Problem

成交量按量比分档着色此前只存在于**「行情·5日」级别**：五日路径把量比档位算成 `volumeTiers`，渲染时逐根替换成交量柱的颜色（[middle-stage-tradingview-views](2026-08-30-middle-stage-tradingview-views.md) 是这条口径的拥有者）。其他 K 线级别没有任何等价能力，用户切到日线/分钟线就看不到量比档位。

把它泛化到全级别时有三处结构性缺口：

1. **契约没有逐根取色通道**：`IndicatorOutput` 只有单色 `color`，一个指标的一条序列只能一种颜色；而档位着色的本质是「同一组柱按档位分色」。
2. **档位色是主题双色**：五日图例的档位色分亮/暗两套（深色底上字面黑不可辨认，最高档换近白），契约只有单色，渲染侧无法按主题取色。
3. **契约没有「默认勾选」这一事实**：`IndicatorDefinition` 无法声明某指标应当默认激活，宿主启动也没有补种机制；而名册（`$DSH_HOME/indicators/chart.json`）是用户设置，每次启动硬塞会覆盖用户的删除意图。

## Decision

**新增预置 definition `vol-tier`（`pane: 'sub'`，`packages/indicators/src/presets.ts`），把五日的「成交量按量比档位着色」做成全市场、全级别通用的副图指标**，并给它配一条只会发生一次的默认激活补种。

**口径**（`vol-tier` 的 `description` 与代码同源）：

- 量比 = 本周期成交量 ÷ 前 N 个周期成交量均值（**不含本周期**，等价 `REF(MA(volume, N), 1)`；实现是 `sma(volumes, N)[i-1]`，即对移动均值右移一位）。参数 `n` 默认 4，范围 2..250。
- **柱高 = 本周期成交量，档位只决定颜色**——与五日级别的实际渲染一致（五日路径的柱高一直是 `kline.volume`，档位只决定颜色）。因此五条输出携带的是同一批柱高，只是按档位分到五条序列上，颜色由每条序列各自的 `themeColor` 决定。
- 阈值 1/2/3 分四档：量比 < 1、1 ≤ 量比 < 2、2 ≤ 量比 < 3、量比 ≥ 3；**比值恰好等于阈值时落较高一档**（与五日图例的区间写法一致）。
- 中性灰档 `无前值` 表达「不可判」，判定顺序为：① 本周期量非有限（脏数据）→ 灰；② 前值窗口不可用（前 N 个周期之内）或前值均值非有限（窗口含脏值）→ 灰；③ 前值均值 ≤ 0 且**本周期有量** → 量比取 `POSITIVE_INFINITY`，经档位判定落**最高档** `量比≥3`；④ 前值均值 ≤ 0 且**本周期量为 0** → 灰；⑤ 其余算 `本周期量 ÷ 前值均值`（溢出的极端值照样发散、落最高档）。③④ 两条与「行情·5日」现行分支逐字同口径（`five-day-series.ts:220-225`：前值全零时本分钟也为 0 才是 `noPrior` 中性灰，有量则取 `Number.POSITIVE_INFINITY` 落 `gte3`）。**本周期量为 0 且前值均值 > 0** 的普通情形仍是量比 0 → `量比<1` 档。发散的比值只用于定档，**不落进 `values`**（柱高是成交量），因此输出里不会出现 `Infinity`。
- 五条输出 key 即档位名（图例名），顺序 `无前值 / 量比<1 / 量比1-2 / 量比2-3 / 量比≥3`，均为 `histogram`；每根柱**只落在其中一条**，`values.length` 严格等于 `bars.length`，warm-up 与不适用位置一律 `undefined`，绝不输出 `NaN`/`Infinity`。
- 色值逐档镜像 `packages/client-ui-trading/src/client/five-day-series.ts` 的 `TIER_COLORS_LIGHT` / `TIER_COLORS_DARK`（那是这组色的唯一事实来源，本包不能反向依赖 UI 包，故注释注明来源并在单测里冻结字面量）。

**契约两个新字段**（`packages/indicators/src/types.ts`，均为可选，存量零迁移）：

- `IndicatorOutput.themeColor?: { light: string; dark: string }`：消费方按当前宿主主题取色，缺席回落 `color`。`color` 仍是必需字段并填同语义亮色值，旧消费方不会出现「无色可用」。类型名 `IndicatorThemeColor` 自 `index.ts` 导出，渲染侧可直接引用。
- `IndicatorDefinition.defaultActive?: boolean`（缺省 false）：true = 该指标要在用户图上默认激活一次；只有预置定义声明，`vol-tier` 与 `vol` 声明为 true。该字段是宿主初始化行为的事实，不改变 definition 的纯数据性质。

**一次性补种**（`packages/indicators/src/chart-seed.ts`）：

- `seedDefaultActivations(store, definitions, ledger?)`：definition 声明 `defaultActive`、名册里没有、账本也没记过 → 用定义 schema 的默认参数激活一次并记账；返回本次记账的 id；重复调用返回空数组。`seedDefaultChartActivations(store, ledger?)` 是宿主入口（预置名册 + 默认账本路径，一个家）。
- **名册里已有该 id 时只记账、不重复激活**（不动用户改过的参数）：这样「用户自己挂过、随后删掉」的默认勾选指标同样不复活。
- 账本是独立文件 `$DSH_HOME/indicators/chart-seed.json`，形状 `{ "seeded": ["vol-tier"] }`；整个补种（读账本 → 读名册 → 激活 → 记账）在一次跨进程排他锁内完成（`@dshtrading/dsh-home` 的 `transactStore`），桌面端与 CLI 同时启动只种一次。
- 调用点两处：`packages/indicators/src/plugin.ts` 的 `apply()`（正常部署）与 `packages/bot-api/src/index.ts` 的服务缺席兜底创建点（老部署自建 store 时）。两处都是**异步发起、不 await、失败只记日志**——补种失败不该让宿主起不来，用户手动勾选仍然可用。

**工具面连带事实**：预置现为 10 条，`<market>_get_indicators` 的默认集随之变化（crypto/us 8 个 id、hk 9 个 id；crypto/hk 的 `tail=` 行数 29）——每新增一条预置都会推动这组数字。`packages/indicators/test/tool.test.ts` 的计数夹具与 `packages/indicators/test/chart-seed.test.ts` 的默认勾选 id 集合夹具在同一变更里同步（只改数字与 id 集合，不放松断言）。

## Alternatives considered

- **接管图表内置成交量 pane（pane 1）**：直接沿用内置成交量柱，只换颜色，零新增副图。否决——内置 pane 的着色由「红涨绿跌」设置与五日档位两套逻辑各自驱动，接管它要把「哪些级别用档位色」塞进宿主图表层，和用户设置语义打架；用户明确要的是「独立副图，不改内置成交量 pane」。
- **给契约加「逐根色」通道（`colors?: string[]` 之类的按根取色数组）**：一条序列就能表达多档颜色，语义最直白。否决——契约要为每个消费方维护第二条颜色通道（含主题双色、图例、读数、`histogramBySign` 的优先级），而本需求只要 5 条固定分档；拆成五条序列 + 可选 `themeColor` 只用契约里已有的机制（多输出 + 单色字段扩展）就够，存量指标零迁移。
- **账本写进 `chart.json`**：少一个文件。否决——`chart.json` 是裸实例数组，桥的 `PUT /chart/indicators` 与「一次性迁移导入」都走 `replaceAll` 整表覆盖，账本混在里面会被整表覆盖抹掉，于是补种再来一次、用户删掉的指标复活。
- **柱高用比值、无前值那一根不出柱**：副图纵轴直接读量比，语义更「纯」。否决——无前值的柱会整根消失（五日级别是**照常画出灰色柱**，只是颜色换成中性灰），用户看到的柱子数与 K 线数不一致；且同一 pane 内「有前值画比值、无前值画体积」会把两套量纲混在一个纵轴上。
- **补种账本放客户端（localStorage / 客户端启动时补种）**：宿主侧零改动。否决——名册 SSOT 在宿主，客户端多实例（多浏览器/多设备）各自补种会让「只种一次」失效；且补种要写 `chart.json`，客户端写回与宿主 `transactStore` 的合并语义纠缠。
- **每次启动都检查「名册里没有就补上」而不记账**：实现最简单。否决——用户删掉之后每次启动都复活，等于删不掉。

## Consequences

- 用户可见：任意市场、任意级别挂上 `量比分档量能` 即得与五日图例逐档同色的量比档位副图；新工作区与已有工作区在宿主升级后的第一次启动各补种一次（含把五日之外级别的默认勾选补齐），用户删掉之后不再复活。换主题时颜色由消费方按 `themeColor` 重取（渲染侧实现见 task-2 的范围）。
- **后续变化（同一变更集）**：成交量柱本身随之搬进指标系统，成为可取消的预置指标 `vol`（图表层不再有内置成交量 pane，pane 1+ 全是副图指标）；五日级别的档位序列改由逐根通道 `barAux` 注入 `vol` 出档位色柱，`vol-tier` 的语义与实现不变。补种因此同时命中两条默认勾选预置，顺序是 `['vol', 'vol-tier']`（`vol` 的 definition 排在 `vol-tier` 之前）。详见 [volume-indicator-and-bar-aux-channel](2026-10-14-volume-indicator-and-bar-aux-channel.md)。
- 档位色只有镜像、没有共享：`presets.ts` 与 `five-day-series.ts` 两处字面量必须同步改，单测冻结了字面量以逼出「只改了一处」的情形；彻底收口需要把色表下沉到 indicators 包（本次未做，避免动 UI 包）。
- 前值无量分支是**口径对齐点**：本指标与五日级别共用一套档位语义，`five-day-series.ts:220-225` 一变，这里必须跟着变（反之亦然）；两处都各自冻结了一条用例（五日侧在 `client-ui-trading` 的量比分档用例里，本指标侧在 `packages/indicators/test/volume-tier.test.ts` 的「前值全为零但本周期有量」用例里），跨包不能互相 import，靠注释互相指路。
- 账本坏 JSON / 坏形按**空账本**降级（与同目录 `chart.json` 的读盘口径一致，错误记日志不抛）：此时会再补种一次——这是与「用户删除不复活」相反方向的一次放宽，只影响账本文件损坏的工作区，恢复后账本被重写为正确形状。
- 插件 `apply()` 的补种是 fire-and-forget：宿主启动不等待补种完成，启动日志会另起一行报告种入的 id；失败只留一条 `console.error`，没有任何重试（下次启动会再试一次，账本语义保证结果仍是一次）。
- 已知未收口：主图读数行（`packages/client-ui-trading/src/client/indicator-readout.ts`）仍直接读 `output.color`。本指标是副图，读数走 pane 图例（消费侧已按 `themeColor` 取色）；将来出现主图叠加的 `themeColor` 指标时该行需一并收口。
- 证据边界：单测（indicators 142 例、client-ui-trading 497 例）与 `pnpm gates:all` 16 项门禁通过；UI 级验证（真实宿主启动后默认勾选可见、切换主题立即变色）不在此范围内——宿主按 profile 刷新契约重建副本并重启后才可见。
