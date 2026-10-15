/**
 * 指标调度（契约 §5）：适用实例 × K 线 × 外部序列 → TvChart 的渲染输入。
 *
 * 为什么从 QuoteStage 抽出来：调度里的三条门控正是本次交付的核心行为——声明了
 * aux 的实例在外部序列未就绪且**每个**声明键都没有非空序列时出一个空 outputs 的
 * 占位组（决策 3 修订：副图 pane 出现并在标题行给理由，但绝不画空线、不画 0），
 * 未就绪的其它形态（宿主无 computeAux、部分键有数据）仍然整体不进调度，以及
 * definition.markets 白名单（决策 5）；jsdom 下挂不起真实图表
 * （lightweight-charts 需 canvas），纯函数是能钉住这些行为的落点，
 * 同时让 QuoteStage 只留接线。
 */
import type { AuxBarSeriesMap, AuxSeriesKey, AuxSeriesMap, IndicatorDefinition, IndicatorInstance, IndicatorOutput } from '@dshtrading/indicators'
import { effectiveInstanceParams, isDefinitionAvailableOn } from '@dshtrading/indicators'
import { auxSeriesReady, barAuxSeriesReady } from './aux-series.ts'
import type { Kline } from './types.ts'

/** 调度输出：TvChart 的渲染输入 + 读数行/词条带要的身份字段。 */
export interface DispatchedIndicatorGroup {
  id: string
  pane: 'main' | 'sub'
  title: string
  key: string
  live?: true
  outputs: readonly IndicatorOutput[]
  /**
   * 空态占位标记：声明了 aux 且**每个**声明键都没有非空序列时给出，值 = 首个声明键
   * （文案按键位归属，见 aux-series.auxEmptyNoticeKey）。带此标记的组 outputs 恒为空：
   * 副图 pane 出现、标题行给出理由，但不构造任何数据点（不是零线、不前向填充、不伪造 live）。
   */
  auxEmptyKey?: AuxSeriesKey
}

/** 注册表能力（注入：生产传 indicators 注册表，单测传真实名册）。 */
export interface IndicatorDispatchDeps {
  getDefinition(id: string): IndicatorDefinition | undefined
  clampParams(definition: IndicatorDefinition, params: Record<string, number>): Record<string, number>
  instanceKey(instance: IndicatorInstance): string
}

/**
 * 构建渲染组。未声明 aux/barAux 的实例维持原路径（compute）；声明了 aux 的实例只走
 * computeAux——外部序列每个声明键都空 → 出占位组（见 DispatchedIndicatorGroup.auxEmptyKey），
 * 未就绪的其它形态整体跳过（旧宿主未接线时拿到的是「无副图」而不是一条贴底的假线）；
 * 声明了 barAux 的实例在逐根序列齐备时走 computeBarAux，
 * 否则回落 compute（不隐藏实例，见 aux-series 的 barAuxSeriesReady）。
 */
export function dispatchIndicatorGroups(input: {
  klines: readonly Kline[]
  instances: readonly IndicatorInstance[]
  market?: string | undefined
  symbol?: string | undefined
  aux: AuxSeriesMap
  barAux?: AuxBarSeriesMap
  liveKeys?: readonly string[]
  deps: IndicatorDispatchDeps
}): DispatchedIndicatorGroup[] {
  const { klines, instances, market, symbol, aux, deps } = input
  const barAux = input.barAux ?? {}
  const groups: DispatchedIndicatorGroup[] = []
  for (const instance of instances) {
    const definition = deps.getDefinition(instance.id)
    if (definition === undefined) continue
    // 决策 5：definition.markets 白名单外的市场不渲染（与选择器/词条带同一判据，
    // 避免「切市场后残留一个空副图」）。
    if (!isDefinitionAvailableOn(definition, market)) continue
    // issue #72：命中 symbolParams 覆盖时该套参数整体替代全局 params，计算前按当前
    // schema clamp——re-author 改 schema 后 stale 覆盖的旧键/越界值不直通 compute。
    const params = deps.clampParams(definition, effectiveInstanceParams(instance, market, symbol))
    const declared = definition.aux ?? []
    if (declared.length > 0) {
      // 契约 §3：声明 aux 时宿主只认 computeAux。
      if (!auxSeriesReady(definition, aux)) {
        // 空态占位（决策 3 修订）：**每个**声明键都没有非空序列 → 出一个 outputs 为空的
        // 占位组，让副图 pane 出现、标题行给理由（不再静默消失）。两类情形仍然不进调度：
        // ① computeAux 缺席是宿主没实现这个能力，不是「该标的没数据」——写成「无采集记录」
        // 就是撒谎；② 部分键有数据是当前未定义的语义（谁知道该画哪条），按未就绪整体隐藏。
        const emptyKey = declared[0]
        if (definition.computeAux !== undefined && emptyKey !== undefined && declared.every(key => (aux[key]?.length ?? 0) === 0)) {
          groups.push({
            id: instance.id,
            title: definition.title,
            pane: definition.pane,
            key: deps.instanceKey(instance),
            outputs: [],
            auxEmptyKey: emptyKey,
          })
        }
        continue
      }
      groups.push({
        id: instance.id,
        title: definition.title,
        pane: definition.pane,
        key: deps.instanceKey(instance),
        outputs: definition.computeAux(klines, params, aux),
        ...(declared.some(key => input.liveKeys?.includes(key)) ? { live: true as const } : {}),
      })
      continue
    }
    // 逐根序列通道（barAux）：档位色这类与 bars 逐根对齐的宿主注入数据。与上面 aux 的
    // 门控**故意不同**——数据未就绪时回落 compute 而不是隐藏实例：着色缺失只该退化为
    // 无色柱，不该让整个副图 pane 消失。长度不符同样按未就绪处理（下标对齐不猜）。
    if ((definition.barAux ?? []).length > 0 && definition.computeBarAux !== undefined && barAuxSeriesReady(definition, barAux, klines.length)) {
      groups.push({
        id: instance.id,
        title: definition.title,
        pane: definition.pane,
        key: deps.instanceKey(instance),
        outputs: definition.computeBarAux(klines, params, barAux),
      })
      continue
    }
    groups.push({
      id: instance.id,
      title: definition.title,
      pane: definition.pane,
      key: deps.instanceKey(instance),
      outputs: definition.compute(klines, params),
    })
  }
  return groups
}

/** 选择器与底部词条带共用的定义表（决策 5：markets 白名单过滤，无聚焦市场不过滤）。 */
export function availableDefinitions(definitions: readonly IndicatorDefinition[], market?: string | undefined): IndicatorDefinition[] {
  return definitions.filter(definition => isDefinitionAvailableOn(definition, market))
}
