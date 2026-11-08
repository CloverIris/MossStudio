# Agent、Provider 与提示词工作台

- 状态：代码基座（2026-10-21）
- 决策：[ADR-0007](decisions/0007-mossstudio-single-ui-and-web.md)
- 入口：MossStudio 右侧 Agent 栏、提示词“分段”按钮

## 1. AI Provider

主进程保存 provider，密钥不返回 renderer；只暴露 `hasKey`。

| 协议 | 默认端点 | 适配 |
| --- | --- | --- |
| OpenAI-compatible | `https://api.openai.com/v1` | OpenAI / DeepSeek / Moonshot / 自定义 |
| Anthropic | `https://api.anthropic.com` | `/v1/messages` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `generateContent` |
| Ollama | `http://127.0.0.1:11434` | `/api/chat`，本地无需 key |

- 文件：`<userData>/ai/agent.json`
- 每个 provider：name/kind/baseUrl/model/temperature/apiKey/hasKey
- 对话持久化在同一文件；renderer 只拿公开 provider 和消息
- 请求超时 120s；错误直接显示在 Agent 栏

## 2. Agent 栏

- 右侧固定栏，发送/停止状态、历史对话、Provider 下拉、Provider 管理
- 自动把当前 `studioPrompt` 作为上下文
- 回复可“写入 Prompt”，但会先弹出红/绿对比确认，不会直接覆盖
- 确认弹窗：当前 Prompt（红） vs Agent 建议（绿），逐段勾选采纳/整条驳回
- 未勾选的绿色段不会覆盖当前 Prompt

## 3. 提示词分段

- 提示词区“分段”打开面板
- 按换行或逗号拆段
- 每段可编辑、着色、固定（置顶）、上移/下移、删除、新增
- 应用后按“固定优先 + 当前顺序”合并为一条 Prompt
- 颜色：blue/rose/violet/amber/slate；按关键词自动猜测光影/构图/文字/主体

## 4. 系列与分页

- Project 增加 `seriesId` / `page`
- Studio Project 条：系列 ID、当前页、上一页/下一页、`+ 新页`
- 同一系列按 page 排序；复制当前页为新页会保留布局/Prompt/参数
- WebUI 保存/打开同样读写 seriesId/page
- 还没有“一次 Agent 回复写多页”和系列级共享上下文

## 5. 还没实现（下一步）

- 更细的字符级 diff（当前是分段勾选）
- 76k Danbooru 中文标签库、6.9 万角色特征库（需要确定可再分发数据源/体积）
- 系列页间引用/一次回复多页（基础多页已接）
- 润色/翻译/图像反推的多模型顺序后备
- Web 端 Agent 栏与 Provider 管理
- 对话内的选择/方案卡、自动/高级模式、分镜助手（工具层已落地，见 [design/agent-tool-rack.md](design/agent-tool-rack.md)）

> 标签/角色数据不会凭训练数据虚构；必须下载可核对、可再分发的数据并记录来源与版本。
