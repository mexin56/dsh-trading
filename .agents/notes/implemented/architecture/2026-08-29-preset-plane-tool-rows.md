# Agent Note: 市场工具行放 preset 平面而非 bundle patch（host 面）

Status: implemented

## Problem

验收标准要求「挂 crypto-trader preset 的会话能看到 crypto 工具，普通会话看不到」。最初方案把 connector/kit 插件行 insert 进 bundle patch（host 面），但 tools/skills 注册表按 scope 分层——host 面注册的工具对所有会话全局可见，隔离验收必然失败。

## Decision

工具行写进市场 preset 的 `agent.cordis.yml`（agent 平面）：join 该 preset 的会话经 scope 分层注册表看到工具，standard 会话看不到（acceptance-all 五 agent 矩阵实证）。bundle patch 只保留 host 面安装器行（自安装 preset 到市场自有 root `~/.dsh-trading-presets/`）。

四个角色预设当前各自挂一条媒体工具行 `dsh-trading-tool-fs`（`@deepseek-ai/dsh-tool-fs`，
提供 `read` / `read_image` / `write` / `edit`）：Web 包把 host 面的 `tool-fs` 与 `tool-fs-search`
置 `disabled: true`，会话工具面由 preset 装配，缺这一行则**任何交易会话都没有 `read_image`**
（host 面被禁、preset 面不挂），`content-insight` 的正文图片实读与 UI 截图核对只能退化成文本 OCR。
`read_image` 另有两道前置：`ctx.attachments` 持久附件已挂载（`dsh-attachment-local`），
以及调用方路由声明图像输入（`llm-deepseek` 行的 `inputModalities` 含 `image`）；两者缺失时该工具
不注册或直接拒绝执行，而不是返回空图（2026-10-13 实证：路由行 `name` 失配被 loader 整行跳过时，
表现为设置页有自定义模型、运行时用回内置目录）。

两条配套硬性规则（均为实测修复）：

1. **提供服务的行必须包 `cordis:group` + `isolate` realm 组**，且 isolate 键 = 服务名（如 `tradingCryptoMarketData`）——否则服务发布进 root realm 被 dsh-agent-presets 挂载拒绝（官方 standard preset 头注规则）。
2. **preset 自安装必须在 bundle 的 host 面常驻插件里**（不能在做自安装的 kit 插件里——kit 行在 preset 平面，不挂 preset 就不运行，preset 永远不存在，鸡生蛋）。

## Alternatives considered

- **host 面挂载 + 工具内自行判断会话**：工具执行时无可靠的「当前会话 preset」判定面，且工具列表仍全局可见——否决。
- **bundle 行与 preset 行双挂**：同插件双实例注册同名工具冲突——否决（commit af5cfff 把 bundle 里的工具行移除）；2026-10-13 媒体工具行沿同一口径，只在 preset 面挂。
- **只在 profile 层按 id 重新打开 host 面 `tool-fs`**（`- id: tool-fs / disabled: false`）：能最快恢复 `read_image`，但那是被否决的双挂形态，且只在单机 profile 生效、不随包分发，四个角色里也只有跑该 profile 的会话受益——2026-10-13 作为临时手段用过一次后撤除。

## Consequences

- 会话隔离验收通过；卸载 bundle 后 preset 变 broken（行解析不到包）而非崩溃，重装恢复（S3 broken 语义）。
- 代价：headless 部署想绕开 preset 直接用市场工具时需自行组行（文档化，见 README 开发期安装）。
- 媒体工具行落在 preset 面后，四个角色都拿到文件读写与图像读取能力；host 面保持 `disabled: true`，
  任何 profile 都不得按 id 重新打开该行（双挂即上表被否决的形态）。行改动随包分发，
  需在仓库 `pnpm build` 后按 profile 刷新契约刷 `file:` 副本，宿主重启才生效。
- 画面验证的取证路径因此统一：会话 skill 用 `read_image` 看素材图片与截图，pytest/OCR 只作兜底。
