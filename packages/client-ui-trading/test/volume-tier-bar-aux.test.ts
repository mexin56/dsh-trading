/**
 * 逐根序列通道（barAux）编码器的纯逻辑用例：五日成交量档位 → 逐根编码。
 *
 * 覆盖：四档量比 1..4、两个中性档（baseline / noPrior）同为 0、编码与 indicators 侧
 * 冻结码表同源、注入 map 用冻结键且长度严格对齐、空窗口为未就绪（空数组）。
 */
import { describe, expect, it } from 'vitest'
import { FIVE_DAY_VOLUME_TIER_AUX_KEY, FIVE_DAY_VOLUME_TIER_CODES } from '@dshtrading/indicators'
import type { FiveDayTier } from '../src/client/five-day-series.ts'
import { fiveDayVolumeTierBarAux, fiveDayVolumeTierCodes } from '../src/client/volume-tier-bar-aux.ts'

describe('五日成交量档位编码（barAux 逐根通道）', () => {
  it('用户看五日图时，四档量比编码为 1..4、基准日与无前值同为中性档 0', () => {
    // Given 一段覆盖全部六个档位、且刻意打乱顺序的档位序列
    const tiers: FiveDayTier[] = ['gte3', 'baseline', 'lt1', 'noPrior', 'lt3', 'lt2']

    // When 编码
    const codes = fiveDayVolumeTierCodes(tiers)

    // Then 逐档对应且逐根对齐（顺序与长度都不变，不是按下标照搬）
    expect(codes).toEqual([4, 0, 1, 0, 3, 2])
    expect(codes).toHaveLength(tiers.length)
  })

  it('用户看五日图时，档位编码与 indicators 侧冻结码表同源：每位就是它在 FIVE_DAY_VOLUME_TIER_CODES 里的下标', () => {
    // Given 冻结码表本身（客户端不另存一份档位表，码值只有这一个家）

    // When 按码表顺序编码
    const codes = fiveDayVolumeTierCodes(FIVE_DAY_VOLUME_TIER_CODES)

    // Then 逐位等于自身下标——码表顺序一旦调整，这里立刻红
    expect(FIVE_DAY_VOLUME_TIER_CODES.map((tier, index) => [tier, codes[index]])).toEqual([
      ['noPrior', 0],
      ['lt1', 1],
      ['lt2', 2],
      ['lt3', 3],
      ['gte3', 4],
    ])
  })

  it('用户看五日图时，档位序列按冻结键注入调度，值与图表序列逐根对齐', () => {
    // Given 图表窗口内的三根档位（基准日 + 两档量比）
    const tiers: FiveDayTier[] = ['baseline', 'lt2', 'gte3']

    // When 构造调度入参 barAux
    const barAux = fiveDayVolumeTierBarAux(tiers)

    // Then 键就是冻结字面量（与 vol 预置定义声明的键同名），值逐根对齐
    expect(Object.keys(barAux)).toEqual(['five-day-volume-tiers'])
    expect(Object.keys(barAux)).toEqual([FIVE_DAY_VOLUME_TIER_AUX_KEY])
    expect(barAux[FIVE_DAY_VOLUME_TIER_AUX_KEY]).toEqual([0, 2, 4])
    expect(barAux[FIVE_DAY_VOLUME_TIER_AUX_KEY]).toHaveLength(tiers.length)
  })

  it('用户滚到显示窗口内没有任何 bar 的档位时，注入的是空数组（调度按未就绪回落 compute，不当作 0 档）', () => {
    // Given 空窗口（五日档位已换到无数据的区间）

    // When 构造调度入参
    const barAux = fiveDayVolumeTierBarAux([])

    // Then 该键存在但长度为 0：就绪判定要求长度等于 bars 根数，空数组必然未就绪
    expect(barAux[FIVE_DAY_VOLUME_TIER_AUX_KEY]).toEqual([])
  })

  it('用户持有的档位数组不被编码器改动（注入通道是纯函数）', () => {
    // Given 调用方自己的档位数组（React state 的引用）
    const tiers: FiveDayTier[] = ['baseline', 'gte3']

    // When 编码并构造注入 map
    fiveDayVolumeTierCodes(tiers)
    fiveDayVolumeTierBarAux(tiers)

    // Then 输入原样（不改写、不排序、不补齐）
    expect(tiers).toEqual(['baseline', 'gte3'])
  })
})
