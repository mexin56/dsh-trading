/**
 * <market>_get_indicators 工具工厂单测：mock 行情服务（合成趋势 K 线 close=100+i），
 * 覆盖默认全指标 / 指定子集 / 未知 id / 空序列 / required 框架校验 / 市场前缀，
 * 以及 definition 契约新增的市场过滤与 aux 指标（港股通持股比例）处理。
 * 手算锚点：最新 close=399；MA5=(395+396+397+398+399)/5=397。
 */
import { describe, expect, it, vi } from 'vitest'
import { createGetIndicatorsTool } from '../src/tool.ts'
import type { Kline } from '../src/types.ts'

function syntheticBars(n: number): Kline[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: 1_700_000_000_000 + i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 10 + i,
  }))
}

function makeTool(overrides: Record<string, unknown> = {}) {
  const getKlines = vi.fn(async () => syntheticBars(300))
  const tool = createGetIndicatorsTool({
    marketData: { getKlines } as never,
    providerLabel: 'fake',
    ...overrides,
  })
  return { tool, getKlines }
}

/** 工具参数 schema 里 indicators 参数的描述文本（agent 读到的默认集）。 */
function indicatorsParamDescription(tool: { parameters: unknown }): string {
  const schema = tool.parameters as { properties?: { indicators?: { description?: string } } }
  return schema.properties?.indicators?.description ?? ''
}

describe('crypto_get_indicators 工厂', () => {
  it('默认全指标：7 个 id、27 条序列（crypto 市场不含港股通持股比例），MA5 latest 手算=397，取数参数透传', async () => {
    const { tool, getKlines } = makeTool()
    const text = await tool.execute({ symbol: 'BTCUSDT', interval: '1d' }) as string
    expect(text).toContain('7 indicator(s)')
    expect(text).toContain('provider=fake')
    expect(text).toContain('MA5 latest=397')
    // 港股通持股比例 markets: ['hk']：crypto 市场既不该列出，也不该留下空标题。
    expect(text).not.toContain('港股通持股比例')
    expect((text.match(/tail=\[/g) || []).length).toBe(27)
    expect(getKlines).toHaveBeenCalledWith('BTCUSDT', '1d', 300)
  })

  it('指定子集 + points 截尾：ma+rsi 共 7 条序列，tail 长度 = points', async () => {
    const { tool, getKlines } = makeTool()
    const text = await tool.execute({ symbol: 'BTCUSDT', interval: '1h', indicators: 'ma,rsi', points: 5 }) as string
    expect(text).toContain('2 indicator(s)')
    expect(text).toContain('MA5 ')
    expect(text).toContain('RSI14')
    expect(text).not.toContain('MACD')
    expect((text.match(/tail=\[/g) || []).length).toBe(7)
    const tailLine = text.split('\n').find((l) => l.includes('MA5'))!
    expect(tailLine.match(/tail=\[[^\]]*\]/)?.[0]?.split(',')).toHaveLength(5)
    expect(getKlines).toHaveBeenCalledWith('BTCUSDT', '1h', 300)
  })

  it('未知指标 id → 报错并列出可选集', async () => {
    const { tool } = makeTool()
    await expect(tool.execute({ symbol: 'BTCUSDT', interval: '1d', indicators: 'ma,nope' }))
      .rejects.toThrowError(/unknown indicator id/)
  })

  it('空 K 线 → 报错；required 缺失由 dsh-tools 框架校验拦截', async () => {
    const getKlines = vi.fn(async () => [])
    const tool = createGetIndicatorsTool({ marketData: { getKlines } as never })
    await expect(tool.execute({ symbol: 'BTCUSDT', interval: '1d' })).rejects.toThrowError(/no klines/)
    await expect(tool.execute({ interval: '1d' })).rejects.toThrowError(/invalid arguments/)
    await expect(tool.execute({ symbol: 'BTCUSDT' })).rejects.toThrowError(/invalid arguments/)
  })

  it('market 前缀可换：us_get_indicators', () => {
    const { tool } = makeTool({ market: 'us' })
    expect(tool.name).toBe('us_get_indicators')
  })
})

describe('crypto_get_indicators 市场过滤与 aux 指标', () => {
  it('用户请求美股市场指标时，默认集不含仅港股的港股通持股比例，显式请求该 id 明确报错', async () => {
    // Given 工具以 us 市场构建，港股通持股比例声明 markets: ['hk']
    const { tool } = makeTool({ market: 'us' })
    // When 先取默认集，再显式请求该仅港股可用的 id
    const text = await tool.execute({ symbol: 'AAPL', interval: '1d' }) as string
    // Then 默认集只列 7 个美股可用预置，显式请求被拒绝且错误里给出该市场的可用预置清单
    expect(text).toContain('7 indicator(s)')
    expect(text).not.toContain('港股通持股比例')
    await expect(tool.execute({ symbol: 'AAPL', interval: '1d', indicators: 'hk-connect-holding' }))
      .rejects.toThrowError(/not available on market us/)
    await expect(tool.execute({ symbol: 'AAPL', interval: '1d', indicators: 'hk-connect-holding' }))
      .rejects.toThrowError(/available presets: ma, ema, boll, macd, rsi, kdj/)
  })

  it('用户请求未知 id 时，错误里列出的可用预置按市场过滤，不宣称别处才可用的 id', async () => {
    // Given 同一未知 id 分别落在 crypto 与 hk 两个市场工具上
    const crypto = makeTool().tool
    const hk = makeTool({ market: 'hk' }).tool
    // When 两个市场各自请求未知 id
    const cryptoError = await crypto.execute({ symbol: 'BTCUSDT', interval: '1d', indicators: 'nope' })
      .catch((error: unknown) => String(error))
    const hkError = await hk.execute({ symbol: '00700.HK', interval: '1d', indicators: 'nope' })
      .catch((error: unknown) => String(error))
    // Then crypto 清单不含仅港股的 id，hk 清单含它
    expect(cryptoError).toContain('available presets: ma, ema, boll, macd, rsi, kdj')
    expect(cryptoError).not.toContain('hk-connect-holding')
    expect(hkError).toContain('hk-connect-holding')
  })

  it('用户读工具说明时，indicators 默认集随市场过滤（crypto 不含仅港股 id，hk 含）', () => {
    // Given 两个市场的工具实例
    const crypto = makeTool().tool
    const hk = makeTool({ market: 'hk' }).tool
    // When 读 indicators 参数的描述文本（agent 看到的默认集）
    const cryptoText = indicatorsParamDescription(crypto)
    const hkText = indicatorsParamDescription(hk)
    // Then 默认集按市场过滤而不是全量预置
    expect(cryptoText).toContain('all presets available on this market: ma,ema,boll,macd,rsi,kdj')
    expect(cryptoText).not.toContain('hk-connect-holding')
    expect(hkText).toContain('hk-connect-holding')
  })

  it('用户请求港股市场指标时，港股通持股比例列出并给出工具面不可用的说明行，不产生空段落', async () => {
    // Given 工具以 hk 市场构建，该指标声明 aux 外部序列（工具面没有该数据源）
    const { tool } = makeTool({ market: 'hk' })
    // When 默认取数，以及显式只请求这一个 id
    const text = await tool.execute({ symbol: '00700.HK', interval: '1d' }) as string
    const explicit = await tool.execute({ symbol: '00700.HK', interval: '1d', indicators: 'hk-connect-holding' }) as string
    // Then 两处都是可读说明行，且没有 "title ():" 形式的空段落，其他预置照常出序列
    expect(text).toContain('8 indicator(s)')
    expect(text).toContain('港股通持股比例: 需要宿主行情副图数据（本工具面不可用）')
    expect(explicit).toContain('港股通持股比例: 需要宿主行情副图数据（本工具面不可用）')
    expect(text).not.toContain('港股通持股比例 (')
    expect(explicit).not.toContain('港股通持股比例 (')
    expect(text).toContain('MA5 latest=397')
    expect(text).toContain('MACD')
    expect((text.match(/tail=\[/g) || []).length).toBe(27)
  })

  it('用户在任何市场查指标时，未声明 markets 的存量预置都照常列出（零回归）', async () => {
    // Given 四个市场各自构建工具，存量预置（MA/MACD 等）均未声明 markets
    for (const market of ['crypto', 'us', 'cn', 'hk']) {
      const { tool } = makeTool({ market })
      // When 显式请求 ma,macd
      const text = await tool.execute({ symbol: 'X', interval: '1d', indicators: 'ma,macd' }) as string
      // Then 两个预置都照常算出输出（MA 6 条 + MACD 3 条）
      expect(text).toContain('MA5 latest=397')
      expect(text).toContain('MACD')
      expect((text.match(/tail=\[/g) || []).length).toBe(9)
    }
  })
})
