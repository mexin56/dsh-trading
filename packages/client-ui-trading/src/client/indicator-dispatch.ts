/**
 * 指标调度（契约 §5）：适用实例 × K 线 × 外部序列 → TvChart 的渲染输入。
 *
 * 为什么从 QuoteStage 抽出来：调度里的两条门控正是本次交付的核心行为——声明了
 * aux 的实例在外部序列未就绪时**整体不进**调度（决策 3：副图 pane 不存在，不是画
 * 空线、不是画 0），以及 definition.markets 白名单（决策 5）；jsdom 下挂不起真实
 * 图表（lightweight-charts 需 canvas），纯函数是能钉住这两条行为的落点，
 * 同时让 QuoteStage 只留接线。
 */
import type { AuxBarSeriesMap, AuxSeriesMap, IndicatorDefinition, IndicatorInstance, IndicatorOutput } from '@dshtrading/indicators'
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
}

/** 注册表能力（注入：生产传 indicators 注册表，单测传真实名册）。 */
export interface IndicatorDispatchDeps {
  getDefinition(id: string): IndicatorDefinition | undefined
  clampParams(definition: IndicatorDefinition, params: Record<string, number>): Record<string, number>
  instanceKey(instance: IndicatorInstance): string
}

/**
 * 构建渲染组。未声明 aux/barAux 的实例维持原路径（compute）；声明了 aux 的实例只走
 * computeAux，且外部序列缺失/为空时整体跳过——旧宿主（未接线）拿到的也是「无副图」，
 * 不会画出一条贴底的假线；声明了 barAux 的实例在逐根序列齐备时走 computeBarAux，
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
      // 契约 §3：声明 aux 时宿主只认 computeAux；未取到数据（缺失/空）不得调用它，
      // 该实例不进调度 = 副图 pane 不存在（决策 3「整体隐藏」）。
      if (definition.computeAux === undefined || !auxSeriesReady(definition, aux)) continue
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
