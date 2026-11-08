---
status: current
last-verified: 2026-11-08 (fec4fe3)
code: apps/desktop/src/renderer/src/pages/studio/assistant/, apps/desktop/src/renderer/src/lib/agent/, apps/desktop/src/renderer/src/lib/agentTools.ts, apps/desktop/src/shared/agent/, apps/desktop/src/shared/ai.ts, apps/desktop/src/main/services/ai.ts
---

# Studio assistant

The 助手 is a chat beside the board that changes the selected card through tools instead of giving advice. One registry defines every tool once (its zod schema, name, risk and one-line summary); the renderer runs them against live Studio state; the main process talks to the language model. Two modes decide whether a write happens at once (自主) or waits in a plan card for approval (审批).

Paths are relative to `apps/desktop/src/`; `assistant/` stands for `renderer/src/pages/studio/assistant/`. The board it acts on is described in [studio-node-board.md](/docs/reference/studio-node-board.md); the reasons for this design are in [studio-design.md](/docs/explanation/studio-design.md).

## 1. The panel

The 助手 button in the title bar opens the right sidebar; the panel stays mounted while hidden so a running turn survives (`renderer/src/pages/studio/StudioPage.tsx`). Its one header row (`assistant/Assistant.tsx`): a 语言模型 menu listing the connected providers with 连接设置… last, a 自主 | 审批 switch, 历史对话 and 新对话. An empty chat shows three starters (润色描述, 拆成区域, 做一套分镜). A reply's actions appear on hover: 用作描述, 复制, 重新回答. Enter sends, Shift+Enter breaks a line.

## 2. Providers

连接设置 opens 连接语言模型 (`assistant/ProviderDialog.tsx`). The kinds are `AiProviderKind` in `shared/ai.ts`: `openai` (shown as OpenAI 兼容; also DeepSeek and Moonshot), `anthropic`, `gemini` and `ollama`; `AI_PROVIDER_PRESETS` fills name, address and model for each. Main (`main/services/ai.ts`) keeps providers and conversations in `ai/agent.json` under the data root and returns only `hasKey`; a key never reaches the renderer. The Ollama path (`ollamaChat`) sends no tools and returns no tool calls, so that assistant answers in text only.

## 3. What the model sees

Every message carries the selected canvas as it is at send time: `lib/agentTools.ts` `formatStudioContext(readStudioSnapshot())` gives title, size, description and the regions in order. The system prompt (`main/services/ai.ts` `SYSTEM_PROMPT`) adds `TOOL_RULES` and the `MODE_RULES` of the conversation's mode from `shared/agent/registry.ts`. A turn runs at most `MAX_TOOL_ROUNDS` (4) rounds of tool calls and streams `AiStreamEvent`s to the panel.

## 4. The tool rack

| Piece | File | Holds |
| --- | --- | --- |
| Parameters | `shared/agent/schemas.ts` (`TOOL_SCHEMAS`) | One zod object per tool; `ToolName` and `ToolArgs` are inferred from it |
| Registry | `shared/agent/registry.ts` (`AGENT_TOOLS`) | Per tool: `title` (Chinese, for the chat line), `pack`, `risk` (`read`, `write`, `run`, `ask`), `requires` (`editable`), `description` for the model, `summarize(args)` |
| Provider list | `toolDefinitions(resolveToolset({ page: 'studio' }))` in `main/ipc.ts` | JSON Schema from `z.toJSONSchema`, without `$schema` |
| Handlers | `renderer/src/lib/agent/executor.ts` (`HANDLERS`) | One per `ToolName`; the table is exhaustive, so a tool without a handler fails to compile |
| Studio API | `renderer/src/lib/agent/types.ts` (`StudioToolApi`), implemented in `StudioPage.tsx` | `state`, `readContext`, `setPrompt`, `setSampler`, `addLayer`, `addTextLayer`, `updateLayer`, `removeLayer`, `createScenes`, `selectCanvas`, `generate`, `problems` |
| Bridge | `lib/agentTools.ts` (`installStudioToolBridge`) | `Events.aiToolCall` from main runs `executeStudioTool`; the result goes back through `Ipc.aiToolResult` |

`resolveToolset` mounts `canvas.read` and `ask` everywhere, `canvas.write` and `storyboard` on the Studio only, and nothing when the provider cannot call tools. The `library` pack exists as a name only (section 9).

| Tool | 标题 | Pack, risk | Does | Refused when |
| --- | --- | --- | --- | --- |
| `studio_read_context` | 查看画面 | `canvas.read`, read | Project name, every canvas (kind, title, size, job state), the selected canvas with its regions by 1-based index | never |
| `studio_select_canvas` | 切换画面 | `canvas.read`, read | Makes another canvas the selected one | unknown id (没有这个画面) |
| `studio_ask_user` | 问你一句 | `ask`, ask | Shows a choice card with 2 to 5 options | fewer than 2 options |
| `studio_ask_approval` | 等你确认 | `ask`, ask | Shows a confirm card (approve, reject, change it) | never |
| `studio_set_prompt` | 改写描述 | `canvas.write`, write | Writes the description of the selected 画面 or 风格 | see precheck |
| `studio_set_sampler` | 调整参数 | `canvas.write`, write | Size (snapped to the 16 px grid), steps (snapped to the nearest 质量 preset), CFG, seed (then locked) | a 放大's size (只能改放大倍数); no fields |
| `studio_add_layer` | 添加区域 | `canvas.write`, write | Adds an `object` or `character` region with a normalised box | on a 放大; `label: "text"` is redirected to the next tool with a `fix` |
| `studio_add_text_layer` | 添加文字 | `canvas.write`, write | Adds a text region; `caption` is the lettering style, `text` the exact words, both required | on a 放大 |
| `studio_update_layer` | 修改区域 | `canvas.write`, write | Changes caption, text, box, visibility or opacity of region `index` | no such index |
| `studio_remove_layer` | 删除区域 | `canvas.write`, write | Deletes region `index` | no such index |
| `studio_generate` | 开始生成 | `canvas.write`, run | Optionally writes a description, then starts the run | whatever blocks 生成 |
| `studio_create_scenes` | 建一套画面 | `storyboard`, write | Builds one 画面 per scene (title, description, size, regions, texts) in free board spots and selects the last (`canvases.ts` `sceneCanvas`) | never |

Precheck (`renderer/src/lib/agent/executor.ts` `precheck`): a tool with `requires: ['editable']` fails with 先在画布上选中一个画面 when nothing is selected and 选中的是生成结果，不能修改；请先复制成新画面 when a result is. Arguments are parsed with the tool's own schema; a bad field fails with 参数不对：`path` and the reason.

## 5. Results

A read returns its data. An ask returns `{ shown, card, summary }`. A write or run returns `{ ...data, summary, problems }`: `summary` from the registry's `summarize`, `problems` from `StudioToolApi.problems()`, which is what `compileCanvasPrompt` still rejects on the selected canvas, so the model learns what blocks 生成 without calling it. A failure returns `{ error, fix? }`, where `fix` names the tool to call instead. The chat shows a trace as one line (`assistant/ToolTrace.tsx`, `assistant/format.ts` `traceHeadline`: 查看画面、改写描述, a repeated step counted as 添加区域 ×3, more than three kinds as …等 N 步) that opens to one line per step (`toolDetail`: the summary, then 还差：the first problem).

## 6. Modes

`AgentMode` (`shared/ai.ts`) is `auto`, shown as 自主, or `advanced`, shown as 审批. It is stored per conversation (`AiConversationInfo.mode`), a new conversation starts with the last choice (`localStorage` key `mossstudio.agentMode`), and a change applies from the next turn. Both modes mount the same tools; the difference is in the executor:

| | 自主 (`auto`) | 审批 (`advanced`) |
| --- | --- | --- |
| A `write` or `run` tool | Runs at once; the trace line reports it | Is held: the executor returns `{ proposed: { tool, args, label } }` and nothing changes |
| End of the turn | The reply | Main collects every held step of the turn into one plan card (`planCardFor`: title 将改动 N 处, or the step's label when there is one; `why` is the model's text) |
| On the board | Nothing | The regions the plan would add are previewed on the selected 画面 as dashed boxes tagged 方案 (`canvases.ts` `plannedRegions`, `lib/shell.ts` `planPreview`, `RegionLayer.tsx`) |
| 应用 | | `lib/agent/executor.ts` `applyPlan` runs the steps in order through the same handlers, without the model; it stops at the first step that fails and does not undo the earlier ones |

## 7. Cards

A card (`shared/agent/cards.ts` `AgentCard`) is attached to the assistant message that asked and saved with the conversation, so a reopened chat shows it. Nothing waits inside a tool call: the tool returns, the turn ends, and the answer becomes the next user message (`assistant/Assistant.tsx` `followUpFor`), which starts the next turn by itself.

| Card | Made by | Buttons | The follow-up message |
| --- | --- | --- | --- |
| choice (`assistant/ChoiceCard.tsx`) | `studio_ask_user` | Single or multiple options with a detail line, 跳过, 确定 | The chosen labels, plus 补充：the typed text; 跳过 sends 「question」先跳过，你按默认继续。 |
| plan (`assistant/PlanCard.tsx`) | A turn in 审批 that held writes | The list of steps, 放弃, 调整…, 应用 | 已按方案改了 N 处 (with 还差：the first problem); 调整 sends 方案先不应用，改一下：the typed text |
| confirm (`assistant/ConfirmCard.tsx`) | `studio_ask_approval` | 拒绝, 改一句…, and the approve button (批准 unless the tool named it) | 批准，开始吧。 or 先别做。; 改一句 sends 先改一下：the typed text |

Only one card waits at a time: the newest unanswered one sits above the composer and does not scroll with the chat. While it waits, text typed in the composer answers it (the placeholder changes: 或者直接写你的答案…, 想改哪里？写给助手…, 想先改什么？写给助手…); 调整… and 改一句… only move focus there. The answer is stored through `Ipc.aiCardAnswer` (`main/services/ai.ts` `answerAgentCard`) before the follow-up is sent. An answered card folds to one line in its message (the question; a plan reads 标题 · 已应用 N 处改动, 已放弃 or 提了调整).

## 8. Writing a description by hand

Text replies are never written automatically. 用作描述 under a reply opens 替换描述？ with 现在 and 替换为, and `applyStudioDescription` writes it on confirm.

## 9. Not built

From `docs/design/agent-tool-rack.md`, still open at fec4fe3: thumbnails for composition choices (options are text only); the `library` pack (`pick_reference` from 作品); a `MAX_TOOL_ROUNDS` that grows for a storyboard; a check of all plan steps before 应用 runs the first; a way to answer a card without sending at once.

## 10. Tests

`apps/desktop/test/shared/agentRegistry.test.ts` (registry names equal `TOOL_SCHEMAS` keys, schema shape, mounting), `test/renderer/lib/agentTools.test.ts` (executor: prechecks, held writes, `applyPlan`, cards, and that a text region made through the tools passes `compileCanvasPrompt`), `test/renderer/studio/canvases.test.ts` (`addRegion`, `editLayer`, `sceneCanvas`), `test/renderer/studio/assistantFormat.test.ts`; end to end `apps/desktop/e2e/specs/agent.e2e.ts` against the mock backend.
