# Agent 工具挂架、交互卡与分镜助手

- 状态：🟡 **P0/P1 已实现**（2026-11-08）；P2–P4 仍是设计
- 日期：2026-11-08
- 关联：[agent-and-prompt.md](../agent-and-prompt.md)（Provider 与现状）、[multi-canvas-studio.md](./multi-canvas-studio.md)（画布板）、[layout-schema.md](../layout-schema.md)（布局编译契约）、[ui-rules.md](./ui-rules.md)（界面规则）
- 触发：右侧 Agent 创建「文字区域」时，提示词和要显示的文字没有分开，工具建出来的区域无法生成

## 0. 摘要

1. **先修一处硬伤**：`studio_add_layer` 没有 `text` 字段，而布局编译要求文字区域的 `text` 非空。工具能造出一个**永远生成失败**的区域，且没有任何工具能补上文字。模型只能把原文塞进 caption，用户被迫手动拆分。
2. **再把工具的注册方式换掉**：改造前同一件事写在四处（`shared/mcp.ts` 的 schema、`agentTools.ts` 的 switch、`StudioPage.tsx` 的 API、`ProjectLayer` 类型），任何一处漏字段都不会报错。已改成**一份 zod 注册表 + 穷举 handler 表**，让参数、校验、执行、编译契约同源。
3. **在挂架上加「问」的能力**：工具可以往对话里放一张卡（单选/多选/方案确认），人答完自动续一轮。这是分镜助手能用的前提。
4. **两种信任级别**：自动（直接改，关键处问一句）与高级（先出方案，确认后才改），由挂载的工具包和系统提示共同决定，不是两套代码。

## 0.1 As-built 差异（P0/P1 落地后回填）

| 原设计 | 落地 | 原因 |
| --- | --- | --- |
| `studio_add_layer` 一个工具带 `label: text`，用 JSON Schema `oneOf` 约束 | 拆成 `studio_add_layer`（object/character）与 `studio_add_text_layer`（`caption`、`text` 都必填） | Gemini 的 `FunctionDeclaration.parameters` 只接受对象根、不支持 `oneOf` / `const`；拆工具在所有 provider 上都能表达「文字必须给原文」，模型也更容易选对 |
| 回执 `{ ok, data, note, blockers }` | `{ ...data, summary, problems }`；失败 `{ error, fix? }` | `blockers` 会让人以为是引擎就绪状态；实现的 `problems` 只来自布局编译（`compileCanvasPrompt`），是「还差什么才能生成」的最小子集 |
| 按 `hasSelection` 卸载写工具 | 工具常驻，执行前用 `requires: ['editable']` 统一拦 | 一轮对话中途卸工具，历史里的 tool_calls 会引用未定义的工具，部分 provider 会报错 |
| 交互卡、自动/高级模式 | 未实现，仍是 P2/P3 | 本阶段只做工具层，避免一次改动过大 |

实现位置：`apps/desktop/src/shared/agent/schemas.ts`、`shared/agent/registry.ts`、`renderer/src/lib/agent/{types,executor}.ts`；`shared/mcp.ts` 已删除。


## 1. 本次故障复盘：文字工具的字段对不齐

### 1.1 现象

用户在右侧 Agent 里说「画一幅构图夸张的洛天依新年贺卡图」。模型拆了 5 个区域，其中一个是文字区域。画面上出现了文字区域，但「要显示的文字」是空的，点生成直接被拦：`文字区域 5 还没有填写要显示的文字`。用户只好在右栏手动把 `golden Chinese text 新年快乐` 拆成「样式」和「文字」两半。

### 1.2 证据

对话原始记录（`.dev-data/ai/agent.json`，两次请求都是同一条路）：

```
studio_add_layer {"label":"text","caption":"golden Chinese text 新年快乐", bbox:{…}}
  → {"added":"87c99956-…","bbox":[518,991,847,1129],"index":5}   ← 工具报告成功
studio_generate {}
  → {"error":"文字区域 5 还没有填写要显示的文字"}              ← 生成被拦
studio_read_context {}
  → …"text":""…                                                  ← 模型看到了空字段，但没有工具能写它
```

工程文件（`.dev-data/projects/project-3788fe96/project.json`，画面 15）：

```json
{ "kind": "text", "caption": "golden Chinese text ", "text": "" }
```

`caption` 末尾的空格是用户手动删掉「新年快乐」留下的。同一工程里还有 `caption: "hanging vertical banner reading "` + `text: ""甜品 SALE 50% OFF""` 这类记录：原文被手工塞进 `text`，但把模型写的句子尾巴（`reading `）和引号一起留在了里面。

第二次请求（登机牌）重演了一次，报错变成 `文字区域 4 …`。区别只是编号。

### 1.3 根因：四层各自对「文字」的认知不一致

| 层 | 位置 | 它对文字区域的认知 | 问题 |
| --- | --- | --- | --- |
| 暴露给模型的 schema | `shared/mcp.ts` `studio_add_layer` | `label` / `caption` / `bbox` | 没有 `text`；`additionalProperties: false` 让模型也不会主动多传 |
| 执行器 | `renderer/src/lib/agentTools.ts` `executeStudioTool` | 只组装 `{label, caption, bbox}` | 即使模型传了 `text` 也会被静默丢弃 |
| 状态写入 | `StudioPage.tsx` `addLayer` → `canvases.ts` `newRegion` | `newRegion('text')` 固定 `text: ''` | 创建即残缺 |
| 编译校验 | `lib/layout.ts:105` `compileLayout` | 文字区域 `text` 必须非空 | 拦截生成，且错误只回一句中文 |

模型其实**知道** `text` 存在——`studio_read_context` 的每个图层都带 `text`，追加的上下文里也写着 `[text: …]`。但它没有任何工具能写这个字段，只能把「样式 + 原文」挤进 `caption`。

更糟的是**只能加、不能改**：没有 `update_layer`、没有 `remove_layer`。模型发现自己搞错了，唯一的补救是再 `add_layer` 一次，于是画面越来越脏。

### 1.4 为什么测试没抓住

- `test/shared/mcp.test.ts` 只检查 schema 形状（名字、必填、数值范围），没有任何一条断言把「工具参数」接到「`compileLayout` 能通过」上。它甚至断言了 `label` 的枚举，却没断言文字区域的必填字段。
- `test/renderer/lib/agentTools.test.ts:72-81` 反过来**固化了错误行为**：它断言 `addLayer` 收到的就是 `{label, caption, bbox}` 三个字段，多一个都算失败。
- `test/renderer/studio/prompt.test.ts` 里所有文字区域都自带 `text`，所以编译路径永远绿。

缺少的那条测试很具体：**用工具的合法参数建一个文字区域，然后 `compileCanvasPrompt` 必须 ok**。

### 1.5 影响面

任何「写标题 / 加字幕 / 做海报 / 做封面」类请求都会在生成前失败，而模型在 4 轮工具调用（`MAX_TOOL_ROUNDS`）内自己修不好。用户看到的是「助手说做好了，点生成没反应」。

### 1.6 修法（P0，已实现）

1. 文字区域拆成独立工具 `studio_add_text_layer`，`caption` 与 `text` 都必填；`studio_add_layer` 只接受 `object` / `character`。
2. 旧写法 `studio_add_layer { label: "text" }` 不报 schema 错，而是返回带 `fix` 的可行动错误，指向新工具（模型的旧习惯一轮就能纠正）。
3. 补 `studio_update_layer`（按 1-based `index` 改 caption/text/bbox/visible/opacity）和 `studio_remove_layer`；`LayerEdit` 与 `ProjectLayer` 同源。
4. 系统提示写清语义：`caption` 是英文的样式/内容描述，`text` 是要原样渲染的文字（用户的语言，不带引号、不带 `reading` 这类连接词）。
5. 每次写操作的回执带 `problems`（布局编译的剩余错误），模型不必先 `generate` 才知道缺什么。
6. 补 1.4 里那条测试：`addRegion` 建出来的文字区域必须能通过 `compileCanvasPrompt`。

修完后模型的一轮变成：`add_text_layer(caption="large golden serif title", text="新年快乐")` → `generate` 成功。

为什么不用 `oneOf`：Gemini 的 `FunctionDeclaration.parameters` 只接受对象根结构，不支持 `oneOf` / `const`，而 OpenAI / Anthropic / Ollama 都能接受两种写法。把语义放进**工具边界**（两个工具）比放进**参数约束**（一个工具 + 条件 schema）更可移植，也更好懂。

第二步（P1）把这套参数搬进注册表，见下一节。


## 2. 挂架：一处定义，三方使用

### 2.1 改造前的样子

同一件事被写了四遍，且互相不知道对方：

```
shared/mcp.ts          schema（给模型看的）
renderer/agentTools.ts switch（怎么解析）
StudioPage.tsx         API（怎么写进状态）
ProjectLayer          类型（最终形状）
```

再加两个只有运行时才知道的约束（`compileLayout` 的必填、`newRegion` 的默认值），一共六个地方。本次故障就是这六个地方里有两处漏了字段。

### 2.2 现在的结构（P1 已落地）

```
shared/agent/schemas.ts   参数：zod，唯一真源
        │ z.toJSONSchema()                 │ z.infer
        ▼                                   ▼
shared/agent/registry.ts  名字·包·风险·摘要·挂载 ──→ main/services/ai.ts（给 provider）
                                            └────→ renderer/lib/agent/executor.ts
                                                   （穷举 handler 表：少一个编译不过）
        ▲                                   │
        └──── IPC: aiToolCall / aiToolResult ┘
```

- **参数只有一个写法**：zod。JSON Schema 由 `z.toJSONSchema()` 生成，执行前用同一个 schema `parse`，不存在「schema 说可以、执行器不认」。
- **handler 是穷举表**：`{ [N in ToolName]: Handler<N> }`，`ToolName` 从 schema 表推导。删一个工具、加一个参数，两边一起红。
- **渲染进程仍然拥有状态**：Studio 的实时状态在 renderer，执行只能在那里。主进程只负责「告诉模型有哪些工具」和转发。


### 2.3 工具描述符

```ts
export interface AgentTool {
  name: ToolName
  /** 工具行上的中文短名，例如「添加区域」。 */
  title: string
  pack: AgentPack
  /** 给模型看的英文说明：做什么、什么时候用、什么时候别用。 */
  description: string
  /** read 只读；write 改画面；run 起任务（要花钱/花时间）；ask 向人提问。 */
  risk: ToolRisk
  /** 执行前的统一前置检查，缺什么就返回可执行的错误。 */
  requires: readonly ToolRequirement[]
  /** 一行摘要，工具行和历史消息都用它，不用模型自己复述。 */
  summarize(args: Record<string, unknown>): string
}
```

字段承担了原来散落各处的策略：

- `risk` → 回执要不要带 `summary` / `problems`、工具行怎么显示、以后接超时预算和日志。
- `requires` → 统一在派发前检查，不再每个 handler 写 `if (!canvas)`；文案和界面里的叫法一致（「先在画布上选中一个画面」）。
- `summarize` → 「文字「新年快乐」」这种一行话，前端不再靠 `toolDetail` 猜 JSON 的键。
- `params` 不在描述符里：它按名字从 `TOOL_SCHEMAS` 取，避免同一个参数写两遍。


### 2.4 工具包与挂载

| 包 | 工具 | 什么时候挂 |
| --- | --- | --- |
| `canvas.read` | `studio_read_context` | 总是 |
| `canvas.write` | `set_prompt`、`set_sampler`、`add_layer`、`add_text_layer`、`update_layer`、`remove_layer`、`generate` | 创作页 |
| `ask` | `ask_user`、`propose_plan` | 模型支持工具调用时（P2） |
| `storyboard` | `storyboard_plan`、`storyboard_create`、`storyboard_fill` | 高级模式，或用户明确说「分镜/系列/一套图」（P4） |
| `library` | `pick_reference`（从作品里挑一张当输入） | 作品页 / 需要参考图时（P4） |

挂载是一个纯函数，能单测（现在的签名只有它真正用到的输入）：

```ts
resolveToolset({ mode?, page?, toolsSupported? }) → AgentTool[]
```

`toolsSupported: false`（Ollama 路径没有工具调用）返回空表；`page` 不是 `studio` 时只挂 `canvas.read`。

新增一个工具 = `TOOL_SCHEMAS` 加一项 + 注册表加一项 + handler 表加一项；`ipc.ts`、`schemas.ts`、UI 都不用改，tsc 会指出漏了哪一处。

### 2.5 回执契约（已实现）

```ts
// 成功：工具数据 + 一行摘要 + 还差什么才能生成
{ written: 9, summary: '描述改为「a red fox」', problems: ['先写一句整体描述'] }
// 失败：一句话 + 建议的下一步调用
{ error: '文字区域请用 studio_add_text_layer：caption 写样式，text 写要显示的文字', fix: { tool: 'studio_add_text_layer' } }
```

四条规则：

1. **错误必须可行动**。`fix` 是「你大概想这么调」的建议调用，模型可以不理，但 90% 的情况一轮就能纠回来，不用像这次一样烧完 4 轮。
2. **写操作回执带后置状态**。写操作统一附 `problems`（`compileCanvasPrompt` 的剩余错误），模型立刻知道「还差什么才能生成」，而不是等 `generate` 报错。
3. **返回实际生效值**。参数被夹取、吸附（例如步数吸附到 8/20/50）时，回执给的是最终值，不是模型传的值。
4. **摘要由工具自己给**。`summary` 由注册表的 `summarize(args)` 生成，聊天的工具行直接显示它，不再把结果 JSON 的前三个键拼出来。

### 2.6 让坏状态不可表示

这是本次故障真正的教训，写进编码规范：

- **语义用工具边界表达，而不是可空字段**。文字区域是独立工具、`text` 必填；`add_layer` 根本拿不到 `label: "text"`。同类需求优先拆工具，其次才是加字段。
- **补丁类型与状态同源**。`editLayer` 的入参只挑 `ProjectLayer` 上真实存在的字段，`ProjectLayer` 加字段时，工具要么自动获得能力，要么编译报错，不会静默落后。
- **工具的合法输出必须能通过下游校验**。`addRegion` 是工具和界面共用的唯一入口，测试直接用它的产物跑 `compileCanvasPrompt`。


### 2.7 和真正的 MCP 服务的关系

现在的「MCP 风格」只是形状（name / description / inputSchema），传输是 Electron IPC，执行在渲染进程。挂架把注册表抽出来之后，**传输可以换**：

- 今天：`ipcMain` → renderer handler。
- 以后要对外（Claude Desktop、Cursor、脚本）：同一个注册表起一个 stdio MCP server，`tools/list` 直接由 `z.toJSONSchema` 生成，`tools/call` 转发到同一个 handler，前置检查用纯函数，不需要 Electron。

所以「挂架」不是造一个新协议，而是把**已经像 MCP 的东西**变成**只有一个真源的 MCP**。

## 3. 对话里的交互卡

### 3.1 为什么是回合制，不是阻塞等待

最直觉的做法是工具调用挂起、等人点完再返回。这条路在这个代码库里走不通：

- `runToolInRenderer` 60 秒超时，人是分钟级的；
- 面板会卸载（切 tab、切窗口），挂起的 Promise 就丢了；
- 关掉应用再打开，卡还在，但那一轮已经没了。

所以：**卡是对话的一部分，答案是一条新的用户消息**。

```
模型  ask_user(question, options, mode)
      → 工具立刻返回 { shown: true, cardId }
      → 模型这一轮结束（"选一个，我接着做"）
用户  在卡上选 → 卡片记下答案 → 追加一条 user 消息（可见文字 + 结构化 answer）
      → 自动开始下一轮
```

好处：可持久化、可回放、可恢复、可审计。代价是每张卡多一次模型调用——可以接受，因为卡本来就是「需要人介入」的地方。

### 3.2 卡片数据

```ts
interface AgentCard {
  id: string
  kind: 'choice' | 'plan' | 'review'
  title: string
  /** 为什么问这一句，一句话，别让用户猜。 */
  why?: string
  options?: Array<{ id: string; label: string; detail?: string; preview?: CardPreview }>
  multiple?: boolean
  allowFreeText?: boolean
  /** 已答：用户选了什么。 */
  answer?: { selected: string[]; freeText?: string; skipped?: boolean }
  createdAt: string
}

interface AiMessage {
  // …现有字段
  card?: AgentCard
}
```

- 卡片挂在 assistant 消息上，持久化进 `agent.json`，历史对话里原样回放；已答的卡只读。
- 同一对话最多一张未答的卡；新卡到来时旧卡自动标「已跳过」。
- 跳过永远可用。

### 3.3 三种卡

| 卡 | 由谁发起 | 长什么样 | 答完之后 |
| --- | --- | --- | --- |
| **ChoiceCard** 选择 | `ask_user` | 单选 `Segmented`、多选 `Checkbox` 列表；选项可带副标题或小图；底部「选好了」+「跳过」 | 追加 user 消息，自动续一轮 |
| **PlanCard** 方案 | `propose_plan`、`storyboard_plan` | 将要发生的改动清单：尺寸、区域（带 bbox 小图）、描述 diff、预计耗时 | 「应用」在本地确定性执行（同一套 handler），不经过模型；「调整」把意见当 user 消息发回去 |
| **ReviewCard** 复核 | 高级模式下的 `set_prompt` | 现描述 vs 新描述，红/绿对照（复用现有「替换描述」弹窗的呈现） | 采纳 / 放弃 |

PlanCard 的「应用」很重要：它走的是 handler，不是模型，所以**确定、可测、不花钱**。模型提出方案、人点确认、机器执行——这也是高级模式的基本手感。

### 3.4 备选从哪来

| 要问的 | 选项怎么产生 | 要不要 GPU |
| --- | --- | --- |
| 构图 | 模型给 3 个 bbox 方案；卡上用本地 SVG 画三分法/居中/对角小图 | 不要 |
| 特征 | 从当前角色描述、历史画面里抽 6–10 个可多选标签 | 不要 |
| 文案 | 模型给 3 条候选，每条显示「原文 / 样式」两栏 | 不要 |
| 风格参考 | 先从作品里挑（`library` 包）；需要新图时才低步数跑草图 | 要，且要确认 |

「文案」这张卡就是本次故障最缺的东西：一张图里把**样式**和**原文**分两栏摆出来，人在选的时候顺手就把两件事分开了。

### 3.5 规则

- 一张卡只问一件事；标题是问句，`why` 一句话说清为什么问。
- 选项 2–5 个。超过 5 个说明应该分两次问，或者让模型先给方案。
- 卡里不放大段提示词；要展示提示词用 PlanCard / ReviewCard。
- 卡上永远能看到「这会改动什么」；纯询问卡不写「将修改画面」。

## 4. 分镜助手

目标是「一句话得到一套图」，不是「一句话得到一张图」。流程固定为四步：

1. **出方案**：`storyboard_plan({ brief, shots, ratio, style })` → 返回 `shots[]`（标题、描述、构图、出场角色、画面文字、预计耗时），渲染成 PlanCard。人可勾选、改标题、删镜。
2. **建画布**：应用后本地创建 N 个 Canvas，按顺序落到画布板，返回 id 列表给模型。这一步不花 GPU。
3. **逐镜细化**：模型对每一镜 `set_prompt` / `add_layer` / `ask_user`（构图、特征、文字），卡上显示「第 3/8 镜」，人可以只改其中几镜。
4. **批量生成**：一次一镜（引擎本来就是串行），进度回到画布板；高级模式下先给「8 张 × 约 28 秒」的确认卡。

和现有画布板的关系：分镜就是一批有顺序的 Canvas，用 `seriesId` + `page` 排序，**不新增数据结构**。分镜助手是「批量建画布 + 批量填内容」的编排层，不是新的文档类型。

## 5. 自动 / 高级

### 5.1 差异

| | 自动 | 高级 |
| --- | --- | --- |
| 一句话 | 直接改，关键处问一句 | 先给方案，点头再改 |
| 挂载的包 | `canvas.read` + `canvas.write` + `ask` | 全部，含 `storyboard` |
| 写入 | 立即执行 | `proposeInAdvanced` 的工具先出卡，确认后本地执行 |
| 询问频率 | 只在信息缺失时（例如文字区域没给原文） | 构图、特征、尺寸、文案都可能问 |
| 工具行 | 一行摘要（「添加区域 · 文字「新年快乐」」） | 完整参数 + 结果，可展开 |
| 生成 | 用户点「开始生成」就跑 | 先确认尺寸/步数/张数/预计耗时 |
| 系统提示 | Do it, then say what you did. | Propose first; never mutate without confirmation. |

两种模式共用同一批工具和同一套 handler，差别只在**挂载哪些包、要不要先出卡、提示词怎么写**。不做两套实现。

### 5.2 界面与文案

位置：输入框上方一行，和模型下拉同一块。

```
[ 自动 | 高级 ]                    (?)
它直接改画面，只在必须你定的时候问一句。
```

- 切换用 `Segmented`（不是 `Advanced` 折叠，那个是「应用自己能决定的事」）。
- 简介一行，跟着模式变，`text-caption text-ink-2`：
  - 自动：`它直接改画面，只在必须你定的时候问一句。`
  - 高级：`每一步都先给你看，确认后才改；构图和文字可以细调。`
- `?` 打开 `Popover`，三行差异，不弹窗。
- 切换写进对话：一条居中的 `已切换到高级模式`，让记录诚实。

### 5.3 持久化与边界

- `AiConversationInfo.mode: 'auto' | 'advanced'`，跟着对话存；新对话沿用上次选择（应用级设置），默认自动。
- 模型不支持工具调用（Ollama 路径现在是直接不给 tools）时：模式禁用，下面一行 `这个模型不能调用工具，只能出文字。`
- 切模式不打断进行中的回合；下一轮生效。

## 6. 落地改动清单

### 6.1 已实现（P0/P1）

| 文件 | 改动 |
| --- | --- |
| `shared/agent/schemas.ts` | 新增：8 个工具的 zod 参数，`ToolName` / `ToolArgs` 从这里推导 |
| `shared/agent/registry.ts` | 新增：`AGENT_TOOLS`（名字/包/风险/前置/摘要）、`toolSchema`、`toolDefinitions`、`resolveToolset`、`TOOL_RULES` |
| `shared/mcp.ts` | 删除，内容并入注册表 |
| `main/services/ai.ts` | 系统提示改写（文字的两段语义），工具规则从 `TOOL_RULES` 取 |
| `main/ipc.ts` | 工具表由 `toolDefinitions(resolveToolset({ page: 'studio' }))` 生成 |
| `renderer/lib/agent/types.ts` | 新增：`StudioToolApi`（含 `state` / `addTextLayer` / `updateLayer` / `removeLayer` / `problems`）、`LayerPatch` |
| `renderer/lib/agent/executor.ts` | 新增：穷举 handler 表、参数解析、前置检查、可行动错误、摘要与 `problems` 回执 |
| `renderer/lib/agentTools.ts` | 瘦成桥接层：`registerStudioTools`、`snapshot`、`formatStudioContext`、`installStudioToolBridge` |
| `pages/studio/StudioPage.tsx` | 工具 API 实现；`readContext` 的说明补上两个字段的语义 |
| `pages/studio/canvases.ts` | `addRegion`（归一化盒子 → 区域）、`editLayer`（补丁 + 夹取），`newRegion` 接受初始文字 |
| `pages/studio/assistant/format.ts` | 工具中文名来自注册表；结果行优先显示 `summary` / `problems` |

### 6.2 待实现（P2–P4）

| 文件 | 改动 |
| --- | --- |
| `shared/agent/cards.ts` | 新增：`AgentCard` 类型 |
| `shared/ai.ts` | `AiMessage.card?`、`AiConversationInfo.mode` |
| `shared/schemas.ts` | `aiChat.mode`、卡片答案的校验 |
| `main/services/ai.ts` | 按模式拼系统提示；`MAX_TOOL_ROUNDS` 按场景放宽 |
| `renderer/lib/agent/executor.ts` | `proposeInAdvanced`：高级模式下写操作先出卡 |
| `pages/studio/assistant/` | `ModeSwitch`、`ChoiceCard`、`PlanCard`、`ReviewCard`、卡片回放 |

数据结构没有破坏性变更：旧对话照常打开，工具回执仍是 `{ ok, content }`。


## 7. 测试与验收

已落地（`test/shared/agentRegistry.test.ts`、`test/renderer/lib/agentTools.test.ts`、`test/renderer/studio/canvases.test.ts`）：

1. **工具 → 编译的贯通测试**：`addRegion` 建出来的文字区域带着 `text`，`compileCanvasPrompt` 必须 `ok`；没有 `text` 时报「文字区域 1 还没有填写要显示的文字」。这条就是这次漏掉的。
2. **注册表 / handler 一致性**：注册表名字集合 = `TOOL_SCHEMAS` 的键；handler 表按 `ToolName` 穷举，漏一个 tsc 就红。
3. **schema 形状**：每个工具都是闭合对象、去掉 `$schema`、必填字段存在、数值范围与 `jobStart` 一致。
4. **文字区域的参数约束**：`add_text_layer` 的 `caption` / `text` 都必填，`add_layer` 的 `label` 只有 `object` / `character`，旧的 `label: "text"` 返回带 `fix` 的错误。
5. **执行器**：参数类型错给中文提示；无选中/结果是只读时统一拦；写操作回执带 `summary` / `problems`；读操作不带。
6. **`resolveToolset`**：Ollama 空表、非创作页只读、两种模式挂同一批工具。

还需要（P2/P3）：

- 卡片：答完追加一条 user 消息、跳过也追加、回放不重复发送、旧卡在新卡到来时自动跳过。
- 模式：高级模式下 `set_prompt` 不直接改画面，`ReviewCard` 采纳后才改。
- e2e（mock backend）：模型一轮里 `add_text_layer` + `generate`，画面上出现文字区域且「开始生成」可用。

## 8. 分期

| 期 | 内容 | 状态 | 出口 |
| --- | --- | --- | --- |
| P0 | 文字区域独立工具、`update_layer` / `remove_layer`、提示词语义、贯通测试 | ✅ 2026-11-08 | 「写字」类请求一次成功 |
| P1 | 注册表 + handler 表 + `resolveToolset`，行为不变 | ✅ 2026-11-08 | 工具只有一处定义，老测试全绿 |
| P2 | 三种卡 + 持久化 + 回放 + 自动续轮 | ⬜ | 「问一句」可用 |
| P3 | 模式开关 + 两套提示词 + 工具行详细度 | ⬜ | 自动/高级可切 |
| P4 | storyboard 包 + 构图小图 + 批量建画布 | ⬜ | 一句话出一套图 |


## 9. 未决问题

- 卡的答案是「新 user 回合」还是「续同一回合」：先用前者（简单、可恢复），以后可以加「同一回合内恢复」省一次调用。
- 自动模式要不要保留 PlanCard：建议单步直接做，**只有批量（≥3 个改动或整套分镜）才出卡**。
- 分镜要不要独立页面：倾向不做，就在创作页的助手栏里推进，画布板本身就是分镜板。
- 角色特征库从哪来：现有画面描述 vs 外部标签库，涉及可再分发数据，见 [agent-and-prompt.md](../agent-and-prompt.md) 的说明。
- `MAX_TOOL_ROUNDS = 4` 在分镜场景明显不够（8 镜 × 2 次调用），需要按 `risk` 或按模式放宽，并给用户一个「继续」的显式入口。
