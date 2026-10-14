/**
 * 五日成交量档位 → 逐根序列注入（barAux 通道）的客户端编码器。
 *
 * 为什么需要：搬到指标系统后的成交量由 `vol` 指标自己画柱，柱色要反映量比档位；而
 * 档位是客户端在五日级别按「同分钟对齐」算出来的 bar 级事实，不是按交易日公布的
 * 日频外部序列，因此走不了 aux 的点序列通道（对齐规则完全不同），只能在调度时把整条
 * 编码序列**逐根**注入。编码数值即 indicators 侧 FIVE_DAY_VOLUME_TIER_CODES 的下标。
 */
import type { AuxBarSeriesMap, FiveDayVolumeTierCode } from '@dshtrading/indicators'
import { FIVE_DAY_VOLUME_TIER_AUX_KEY } from '@dshtrading/indicators'
import type { FiveDayTier } from './five-day-series.ts'

/**
 * 档位 → 编码：baseline（比较窗口首日，无前值可比）与 noPrior（前值均值为 0，比值
 * 无定义）同为中性档 0——两者在图上同色，分成两个码只会让指标侧多一条永不命中的分支。
 * 穷举 Record：FiveDayTier 新增档位时这里编译即失败，不会静默漏一个色。
 */
const TIER_CODE: Record<FiveDayTier, FiveDayVolumeTierCode> = {
  noPrior: 0,
  baseline: 0,
  lt1: 1,
  lt2: 2,
  lt3: 3,
  gte3: 4,
}

/** 档位序列 → 编码序列：长度与输入严格一致（逐根对齐），不改动输入数组。 */
export function fiveDayVolumeTierCodes(tiers: readonly FiveDayTier[]): FiveDayVolumeTierCode[] {
  return tiers.map(tier => TIER_CODE[tier])
}

/**
 * 档位序列 → 调度入参 barAux。键是冻结字面量，与 `vol` 预置 definition 的
 * `definition.barAux` 声明同源；长度必须等于喂给调度的图表序列根数，否则调度按
 * 「未就绪」回落 compute（见 aux-series 的 barAuxSeriesReady）。
 */
export function fiveDayVolumeTierBarAux(tiers: readonly FiveDayTier[]): AuxBarSeriesMap {
  return { [FIVE_DAY_VOLUME_TIER_AUX_KEY]: fiveDayVolumeTierCodes(tiers) }
}
