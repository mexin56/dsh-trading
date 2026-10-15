# Agent Note: 数据源 API 凭证图形化 UI 配置与运行时集成

Status: implemented

## Problem
- 商业数据源与网关连接器（如 FMP、Finnhub、Tushare Pro、Alpaca、Polygon、OKX 等）此前主要依赖手动配置操作系统环境变量。
- 用户希望在图形化设置界面中，直接为需要 API 密钥或本地网关地址的数据源提供输入、修改、脱敏查看与一键删除（清除）的能力。

## Decision

1. **设置 Schema 扩展 (`@dsh-trading/router`)**：
   - 在 `dshtrading` settings namespace 中增加 `credentials: Record<string, Record<string, string>>` 字典；
   - 在 `MarketRouterService` 中提供 `getCredential(provider)` 方法供连接器获取配置。

2. **控制器与 UI 组件 (`@dsh-trading/client-ui-settings`)**：
   - 声明 `PROVIDER_CREDENTIAL_SPECS`，规范定义各连接器的凭证字段；
   - 在 `MarketProviderPanel.tsx` 中嵌入 `ProviderCredentialCard`：
     - 提供已配置/未配置状态指示；
     - 展开式抽屉，带密码明密文显隐切换；
     - 提供【保存凭证】与【清除/删除凭证】操作；
     - 提供多语言支持与操作反馈 toast。
   - **卡片挂哪些字段的判据（2026-10-15 定稿）**：密文字段 × 真出站消费点，两条同时成立才挂。
     密文字段 = 值的家是 `dshtrading.credentials.<provider>`；真出站消费点 = 连接器真读这个键、
     且值能进请求。非密端点/账户标识（`gatewayUrl` / `host` / `port` / `tigerId`）归连接器自己的
     `Config`，由 `ProviderMeta.configField` 提示；无出站消费点的密文字段一律撤下而不是留在面板上。
     逐条 provider → 消费点对照表见
     [设置页凭据面收窄到连接器真实消费面](../simplification/2026-10-15-settings-credential-surface-narrowed.md)。

3. **连接器优先读取与优雅回退**：
   - 连接器优先读取 `tradingMarketRouter.getCredential(provider)`；
   - 未在 UI 配置或清除后自动回退至环境变量 `process.env[ref]`；
   - 这是**面板字段真有消费点**的那些 provider 的现状（okx / alpaca / fmp / finnhub / polygon /
     tushare / longbridge / tiger / jin10 / hithink，其中 longbridge 与 tiger 的读点于 2026-10-15 补齐）；
     其余 provider 的字段自同日撤下——面板键无人读即不该出现在 UI 上（清单与证据见上面那份记录）。


## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->


## Consequences

- 用户无需手动修改系统环境变量即可在图形化设置界面直观管理各券商 API 凭证；
- 凭证存储与读取严格遵循 BYOK 铁律，不向浏览器外泄。
