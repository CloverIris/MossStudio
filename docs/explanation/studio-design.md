---
status: current
last-verified: 2026-11-08 (fec4fe3)
code: apps/desktop/src/renderer/src/pages/studio/, apps/desktop/src/renderer/src/components/shell/, apps/desktop/src/shared/agent/
---

# Why the Studio is a node board

MossStudio is for people who have never used an image generation tool, and its Studio is a node board anyway. This doc explains that choice: what the board is for, what it refuses to be, why the Rail keeps everything else out of the way, what is deliberately not configurable, the rule that features should be read from their form, not from text, and why the assistant acts through tools and cards. What is built, with file paths, is in [studio-node-board.md](/docs/reference/studio-node-board.md) and [studio-assistant.md](/docs/reference/studio-assistant.md).

## Who it is for

The primary user is a general user with a consumer GPU, not someone running a GPU server. They should get a picture from one description on the first run, with nothing to set up beyond choosing an engine and a model. Power users exist and are welcome, but the design is judged by the first ten minutes of a beginner, and features for the second group are added without taking anything from the first. Remote machines, training and LAN access are add-ons that stay out of sight until switched on.

## Why a board at all

A form would be simpler to build. Three things about picture generation argue for a board:

- Work happens in series. People do not make one picture; they make a picture, then a variant, then a bigger one, then three more in the same style. A form shows one state at a time and loses the lineage. A board keeps every attempt next to the thing that made it, so comparing is looking, and reusing is a wire.
- The useful operations are relations between pictures: start from this one, keep its composition, borrow its look, make it bigger. On a form those are file pickers buried in sections; on a board they are the lines between cards, visible at a glance and removable in one gesture.
- The tool should grow with the user. A beginner uses one card, a 画面 (`kind: 'layout'`), and one description. Later the same surface, with no mode switch, takes a 遮罩, a 控制图, a shared 风格 (`kind: 'style'`) and a 放大 (`upscale`). Nothing has to be unlocked or relearned; the cards they already know gain sockets.

ADR-0008's answer to the same needs, canvas tabs plus a gallery, failed on the first point: a run's output went to a gallery and comparing meant switching tabs. The filmstrip under every 画面 exists because of that.

## What it refuses to be

The board is not ComfyUI, and the difference is not polish. In a ComfyUI-style graph every processing step is a node: the model loader, the text encoder, the sampler, the VAE decode, the upscaler. The user assembles the pipeline, which is exactly the knowledge a beginner does not have. MossStudio's board hides the pipeline and shows the work:

| ComfyUI exposes | The board shows instead |
| --- | --- |
| Loader, encoder, sampler, decoder nodes | One 画面 card that generates |
| Untyped or dozens of typed data links | Four kinds of card and five named inputs; a wire is always a picture or a 风格 |
| A node palette and a search box | Empty sockets on the card that say what it accepts, and a right-click menu |
| The user wires a correct graph or gets a runtime error | Illegal wires are refused at the moment of the drop, with the reason |
| Settings as nodes and widgets everywhere | Settings in one panel for the selected card; most of them folded |

The board also refuses to be a skin over a web UI, a training front end or a model manager. Those exist elsewhere in the app, and their pages never share the screen with the board.

The test for a new feature is whether a beginner would understand it as a card, a socket or a setting on a card. If it only makes sense as a step in a pipeline, it belongs inside the engine or behind a preset, not on the board.

## The Rail

The old shell carried seven management pages beside 创作, first as bottom tabs and then as a title-bar menu (ADR-0011 tells that history). Both put installation, engines, devices and diagnostics on the same footing as making pictures, and both let users dock, drag and resize panels into a layout nobody else had.

The Rail answers with four destinations, 创作, 作品, 模型 and (when enabled) 训练, with 活动 and 设置 at the bottom. Management is one click away and never in the way. Everything that is not a destination moved into one of three places: a full-page first-run setup that disappears once the computer is ready, one Activity panel for jobs, notifications and problems, and settings as a page with sections. Panel positions are not a setting; every user sees the same screen, which is what makes screenshots, E2E specs and support answers match.

## Progressive disclosure, and what is not configurable

The board shows little by default and reveals on demand: a card is a picture with a title; sockets appear when the pointer pulls a wire; 高级 folds the settings the app can decide on its own. Several things are not configurable at all, on purpose:

| Not configurable | Why |
| --- | --- |
| The pipeline (sampler, scheduler, decoder as steps) | The engine owns it. The user chooses a 质量 preset; the preset carries the step count and sampler profile. |
| Panel layout and docking | A fixed layout is learnable and documentable. The sidebars resize and the assistant can be hidden; nothing moves. |
| Arbitrary wire types | Every wire is a picture into a named role, or a 风格 into a 画面. The port says what it takes, so a drop can be refused with a reason instead of failing later. |
| How 放大 works | It is a redraw at a chosen size and one of three detail levels, because that is what the engine does. A separate upscaler would be a lie about the pipeline. |
| What a CLI engine cannot do | 兼容模式 and AMD 原生 are text-to-image only. The inputs they lack are hidden behind one sentence rather than shown disabled with five tooltips. |
| The seed | A new random seed per run unless the user locks it. The old fixed default of 42 made every new 画面 repeat itself, and nobody had chosen it. |
| Where results go | Every run is a new result; nothing is overwritten. Results fold into the filmstrip until pinned or used, so the board does not fill with cards nobody asked for. |

Recipes follow the same rule. 改一张图, 局部重绘, 按构图生成, 参考风格, 放大一张图 and 一组同风格的图 are starting layouts, not modes: after the recipe lays out the cards nothing about them is special, and a user who has seen a recipe once can build the same thing by hand.

## Intuitive over explained

The board has no hint lines. No "起始图: start from this picture" under a control, no helper paragraph under a field, no tooltip that repeats the label. The rule from the design reviews was that features must read from their form: a thumbnail of the linked picture rather than its file name, a socket with a short label rather than an explanation of roles, the chosen option visibly selected rather than described.

Text appears in two cases:

- When something is blocked. The 生成 button lists what stands in the way and where the fix lives; a refused wire says why in a bubble at the pointer; a recipe that cannot run says what it needs. The wording comes from one source so the footer and the board never disagree.
- When something would otherwise be silent. An input that cannot be resolved stops the run and says so; it is never dropped quietly. A LoRA that comes from a 风格 is named as such when it blocks.

This is also why the assistant works through tools that act on the board rather than through advice: the user sees the description change on the card and the region appear, instead of reading what they should do.

## The assistant: tools, cards and two kinds of trust

The assistant is a second way to drive the same board, not a separate product, so it follows the same rules and adds four of its own.

- One definition per tool. The first version described each tool in four places (a schema for the model, a switch that parsed it, the page method that applied it, the type it wrote into), and a field missing from two of them produced text regions that could never generate. The fix was structural, not a patch: a tool's parameters are declared once, the model's schema is generated from that declaration, and the handler table must cover every declared tool or the code does not compile. The lesson, kept as a rule: express meaning through tool boundaries rather than optional fields. Words in the picture are a different tool from objects and characters, with both of their strings required, instead of one tool with a kind that sometimes needs a second field.
- Results say what is still missing. A write reports what would block 生成 right after it, so the model fixes the region instead of discovering the problem by starting a run. A refusal names the tool to call instead. The aim is a model that recovers in one round, not one that burns its round budget guessing.
- Asking is a turn, not a wait. A question to the user is a card attached to the model's message; the turn ends, and the answer comes back as the next message. Nothing blocks inside a tool call, because people answer in minutes while tool calls time out in seconds, panels unmount, and the app may be closed and reopened with the card still unanswered. The cost is one extra model call per question, which is acceptable at exactly the moments a person has to decide anyway.
- Two levels of trust, one code path. 自主 applies writes as they come and asks only when the picture depends on a choice; 审批 holds every write of a turn and shows them as one plan to approve. The modes mount the same tools and run the same handlers; only the executor differs. One plan per turn rather than one confirmation per tool, because a change is usually several steps and five 应用 clicks would tell the user nothing more than one. The plan is previewed on the board as dashed boxes, so approving means looking, not reading.

The panel itself keeps the no-hint rule: one header row, no introduction, no "Enter to send" line, the waiting card above the input with the input as its free-text answer, answered cards folded to a line, and tool traces as one plain line that opens on request.

## Trade-offs accepted

- A board needs more room than a form. Windows smaller than 1280 × 760 fit, but nothing collapses; small laptops get a cramped Studio.
- People who liked arranging panels lose that. There is no plan to bring docking back.
- Users on a CLI engine get a smaller Studio, and the board does not pretend otherwise.
- Hiding the pipeline means some things cannot be done here at all. Someone who needs a custom graph needs a different tool, and the board should not try to become it.
- A plan in 审批 is applied step by step and stops at the first failure without undoing the earlier steps; the user sees a partial change and a reason. Checking every step before the first runs is an open question.
- Answering a card sends at once. Someone who wanted to add a sentence after choosing gets overtaken; a "choose but do not send yet" action is not built.

## More information

- [ADR-0011](/docs/decisions/0011-rail-navigation-and-node-board.md): the Rail and the board replace the dock layout, with the history of the two earlier shells.
- [ADR-0012](/docs/decisions/0012-vulkan-and-hip-cli-engines.md): why CLI engines exist and what the Studio hides for them.
- PR #43 (2026-11-08): the node board as shipped in 2.0. PR #54 (2026-11-08): region boxes on the board, the first run, and the assistant's tool rack, cards and modes.
- `docs/archive/product-design.md`, `docs/archive/multi-canvas-studio.md` and `docs/archive/agent-tool-rack.md`: the 1.x workbench this replaced and the assistant's design history, kept for the record.
