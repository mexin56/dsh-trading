/**
 * 新挂载实例的默认适用范围（决策 7，2026-10-13）：港股通持股比例取自日频序列，
 * 分钟级没有对应数据，首次挂载时默认只勾 1d/1w/1M。
 *
 * 默认值不在客户端另立一份表——唯一的家是 definition.defaultApplyScope
 *（packages/indicators/src/presets.ts），宿主侧两条创建路径（indicator_activate /
 * 桥 PUT）读的是同一份声明。本模块只做「definition → 客户端写入条目」的翻译。
 */
import type { IndicatorDefinition, IndicatorMarketScope } from '@dshtrading/indicators'
import type { MarketId } from './types.ts'

/**
 * 挂载时要补写的范围条目；definition 未声明默认范围返回空表。
 * 只在挂载那一刻调用：用户在适用范围面板把级别改成「全部支持级别」时条目会被归一
 * 删除，若改成「条目缺席就补写」就会每次渲染都覆盖用户的显式选择。
 */
export function defaultScopeEntries(
  definition: IndicatorDefinition | undefined,
): Array<{ market: MarketId; scope: IndicatorMarketScope }> {
  const applyScope = definition?.defaultApplyScope
  if (applyScope === undefined) return []
  // 表键是本仓市场词汇（crypto/us/cn/hk/futures/global），与 setIndicatorScope 同域。
  return Object.entries(applyScope).map(([market, scope]) => ({
    market: market as MarketId,
    scope: { enabled: scope.enabled, intervals: [...scope.intervals] },
  }))
}
