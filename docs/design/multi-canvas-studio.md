# Studio 多 Canvas Project 设计

- 状态：**已实现**（2026-10-31 更新到 as-built）
- 日期：2026-10-31
- 范围：Project 内的多 Canvas Board、串行推理任务、进度与生成结果呈现

## As-built 差异（相对本设计早期提案）

本设计最初假设"在 2×2 网格里平铺、默认就有一个「新建内容」占位"。落地时改成**自由坐标画布板**，与提案的差异：

| 提案 | 落地 |
| --- | --- |
| `board.columns: 2` 网格 + `row/column` | 移除网格与行列字段，Canvas 用 `x/y`（board pixels）自由定位，可拖动 |
| 固定槽位缩放 | 卡片按自身宽高比呈现，`BOARD_UNIT = 0.34`：512² 占 1024² 四分之一面积 |
| 选中才启用面板 | 保留；另增加点选自动居中到 125% 工作缩放 |
| 结果覆盖/追加到同一卡片 | 结果永远是**新的一张 Result Canvas**，放在来源卡片下方 |
| 进度只在节点文字里 | 增加底部进度绑带 + 生成中卡片呼吸光晕，并移除了生成时自动弹出终端 |
| 未提及 | 增加缩略图导航、滚轮光标锚点缩放、空白处拖动平移、适配视图 |
| schema v2 + v1 迁移 | 最终定为 **schema v3**，删除全部向前兼容（旧工程不可读） |

工作台信息架构也在同一轮调整：布局描述从左栏之外移回左栏，生成时自动编译布局 Prompt（见 [product-design.md](../product-design.md)）。

## 当前实现进度

- 已落地：Project schema v3 Canvas 数据（自由 `x/y`）、原子保存；空 Project Board 与 Canvas 选择/新增/复制/删除/拖动。
- 已落地：Layout/Result Canvas 与 Job 关联、MossInfer FIFO 启动队列及排队取消；Canvas 上显示结构化阶段/去噪进度。
- 已落地：生成结果节点内预览图片；重跑创建新结果，不覆盖旧节点；无 Canvas 时编辑面板提示并禁用。
- 已覆盖：Project v3 多 Canvas/Job/输出持久化、多个同名背景资源隔离、空 Board 保存、旧 schema 文件如实返回不可读。
- 已覆盖：fake MossInfer FIFO、Canvas/Project 关联、排队取消与串行完成场景；Result 预览包含文件缺失与 Job 记录失联提示。
- 已覆盖：Studio 窗口级创建 Canvas、独立 Prompt 自动保存、刷新后重新打开 Project 的交互测试。
- 本轮验证：`tsc -p tsconfig.node.json`、`tsc -p tsconfig.web.json`、`electron-vite build`、8 套工具链测试 55 项断言、本机 RTX 2080 真实出图。


## 1. 背景与目标

当前 Studio 的 Project 对应一个可编辑布局画布；生成任务虽然有独立的 Job 和输出文件，但成功图片只进入全局画廊。用户需要自己发现并打开画廊，难以判断生成是否完成、结果属于哪个 Prompt，也无法自然地比较多次生成。

本设计将 Project 变为一块创作 Board：布局、参数、任务和结果以独立 Canvas 节点组织在同一空间内。生成结果直接显示在节点中；全局画廊仍作为跨 Project 的素材浏览入口。

目标：

1. 在一个 Project 中表达多个布局、生成任务和结果，并保留它们的参数快照与来源关系。
2. 选中某个 Canvas 后才启用左右编辑面板，所有编辑都明确作用于当前选择。
3. 把队列、实际阶段、采样进度、错误和结果显示在对应 Canvas 上。
4. 第一阶段严格串行执行生成任务，不允许两个 Canvas 并行占用推理引擎。
5. 兼容当前 schema v1 Project、已有任务记录和全局画廊；升级不能丢失已有创作或生成文件。

非目标：

- Canvas 之间合成、蒙版、图层式图像编辑或时间线。
- 多 GPU 并行、同时运行多个 Canvas 任务，或复杂的队列优先级管理。
- 将模型/引擎二进制、模型权重或输出 PNG 复制进 Project。
- 用不可靠的文本正则取代 MossInfer 已有的结构化进度协议。

## 2. 概念与层级

```text
Project
└─ Canvas Board
   ├─ Layout Canvas       可编辑布局与 Prompt，允许提交生成
   ├─ Result Canvas       任务输出图片与本次参数快照
   ├─ Layout Canvas       用户新建或复制参数得到的可编辑 Canvas
   └─ New Canvas Slot     未持久化的创建入口
```

- **Project tab**：Studio 顶部现有 Project 切换继续保留，一个 Project 对应一个 Board。
- **Canvas**：Board 上可选择的持久化节点。第一阶段包括 `layout` 和 `result` 两种类型。
- **Layout Canvas**：有自己的尺寸、布局草稿、Prompt、负面 Prompt、Seed、采样参数、模型与设备引用。
- **Result Canvas**：有输入快照、来源 Canvas/Job、Job 状态、进度、错误与零个或多个输出引用。完成前也可显示为任务 Canvas。
- **New Canvas Slot**：Board 上的“新建内容”占位入口，不是空 Project、不创建 Job，也不写入 Project 文件；用户点击后才创建 Layout Canvas。

项目以稳定 Canvas ID 关联任务，不以屏幕顺序或索引关联。Board 排布和 Canvas 身份相互独立。

## 3. Board 与交互

### 3.1 初始与创建

1. 新建 Project 后，Board 默认以 2×2 Canvas 大小的视野显示一个空白入口，中央提示“新建内容”。
2. 点击后，将空白入口转成一个 Layout Canvas，显示现有的布局编辑器；同时在其相邻位置显示一个“新建内容”占位入口。
3. 占位入口点击后才转成新的 Layout Canvas，并继续提供下一个占位入口。未使用的入口不计入 Project Canvas 数量。
4. Canvas 按固定网格位置排列；初始视野容纳 2×2 节点，内容超过视野后 Board 延展并可平移/缩放。新增、删除、复制和重跑不应让既有节点无故换位。
5. 每个 Canvas 有明确类型、标题、状态和尺寸。结果节点使用缩略图/预览图作为主体；空 Layout Canvas 显示布局占位和编辑提示。

### 3.2 选择与面板

- 点击 Canvas 主体或标题会选择它；被选中节点有清晰且不只依赖颜色的描边/标记。
- 左侧生成参数面板只编辑当前选中的 Layout Canvas；选择 Result Canvas 时显示该次生成的只读参数快照。未选择时显示“请点击选择一个 Canvas”。
- 选择 Result Canvas 时，参数面板显示该次生成的只读参数快照；用户可通过“复制参数为新 Canvas”创建可编辑副本。
- 中央工具栏的尺寸、选择、绘制、缩放等操作绑定当前 Layout Canvas。Result Canvas 选择时，布局绘制工具禁用。
- Project 切换时恢复其 Board、选择状态和滚动位置；若保存的选择已删除，选择首个有效 Canvas，否则显示空入口。

### 3.3 Canvas 操作

操作栏按节点状态提供适用动作：

| 操作 | Layout Canvas | Result/Task Canvas |
| --- | --- | --- |
| 生成/运行 | 校验后将当前参数快照提交为任务 | 不适用 |
| 重跑 | 以当前参数创建新的 Result/Task Canvas，在源节点下方放置并立即入队；不覆盖历史结果 | 以该节点保存的参数快照创建新任务节点 |
| 复制参数为新 Canvas | 复制布局及生成参数，创建未提交的 Layout Canvas | 复制该次实际运行的参数/Prompt，结果图片不复制 |
| 删除 | 删除该 Canvas 及其 Project 引用 | 删除任务/结果节点与其 Project 引用 |
| 打开文件 | 不适用 | 对已完成的输出打开文件位置/预览 |

- “重跑”是立即创建任务，“复制参数为新 Canvas”是只创建草稿；标签、图标或确认提示必须表达差异。
- 删除正在运行的 Canvas 不允许直接丢失任务引用。先停止任务并确认，或禁用删除直到任务完成/取消；不得静默取消。
- 删除 Result Canvas 不删除输出文件。输出仍由全局画廊/输出管理负责；同一输出可能被其他 Project 引用。
- 若删除源 Layout Canvas，其重跑产生的 Result Canvas 保持可用，来源显示为已删除来源，而不级联删除结果。
- 键盘可聚焦并选择 Canvas；所有按钮有可访问名称，选中态使用 `aria-selected` 或等价语义。

### 3.4 Board 空间布局

- 采用 Canvas 网格而非自由拖放作为第一阶段的定位模型；默认 2 列，向下扩展，源 Canvas 的重跑节点插入其下方并稳定推移后续行。
- Project 保存 Canvas 的逻辑位置/排序，不保存像素缩放比例作为节点数据。
- 缩放与平移属于 Board viewport 状态，可先按 Project 本地保存；即使 viewport 状态丢失也不得影响 Canvas 的位置和数据。
- 保持可读的最小/最大缩放范围；缩放时以指针位置为中心，空间操作与现有布局编辑器的画布手势保持一致。

## 4. 生成任务、串行策略与状态

### 4.1 提交快照

提交时，从 Layout Canvas 原子地生成不可变任务快照，包括：

- Prompt 与负面 Prompt（若来自布局编译器，保存最终提交字符串及对应布局草稿）。
- 宽、高、步数、CFG、Seed、profile。
- 模型 Bundle/组件绑定、设备、host/远端模型路径引用。
- 推理后端、选定引擎路径/版本标识（路径仅用于诊断，不复制引擎）。
- 源 Canvas ID、Project ID、提交时间。

提交后再修改源 Layout Canvas，不反向修改已排队/运行的 Job 参数或历史 Result Canvas。重跑读取所选源 Canvas 的当前草稿；从 Result Canvas 重跑则读取它的原始快照。

### 4.2 串行队列

- 第一阶段全应用最多有一个由 Studio Canvas 提交的活动生成任务；包括本机和远端，避免不同执行入口绕过串行保证。
- 后续任务进入 FIFO 队列，并立即创建对应 Result/Task Canvas，状态为“排队中”。用户可取消尚未开始的队列项。
- 队列项进入执行前重新检查引擎、模型绑定和设备可用性。检查失败只使该 Canvas 失败，不阻塞之后的队列项。
- 活动任务可从 Canvas 操作栏或终端取消；取消状态必须同步到 Job、Canvas 和终端。
- 第一阶段不支持调序、并行或多个活动任务；UI 不显示会暗示并行的控件。
- FIFO 所有权应集中在现有 Job/Supervisor 或等价的主进程任务协调层；UI 显示状态但不自行实现第二套调度器。当前 MossInfer sidecar 内部 FIFO 可作为引擎保护，但不能替代 Studio 跨本机/远端的全局队列。

### 4.3 状态机

```text
queued → starting → running → succeeded
                   ↘ failed
queued/running → canceled
```

- `queued`、`starting`、`running`、`succeeded`、`failed`、`canceled` 映射现有 Job 状态，禁止在 Project 与 Job 中各自维护可冲突的状态机。
- Project 保存 Job ID 与必要的最后已知摘要；任务状态及日志以 Supervisor 的 Job 记录为准。
- Project 加载时，以 Job ID 对照任务列表恢复状态；若任务记录缺失，保留最后已知状态并展示“任务记录不可用”，不伪装为运行中。
- 完成时将输出引用挂到 Result Canvas 并立即渲染图像；成功 Toast 仅作补充，不作为结果唯一入口。
- 失败时在对应节点原位显示可读错误、查看日志/诊断和重试操作；队列继续执行下一项。

## 5. 进度与终端

### 5.1 结构化主通道

MossInfer protocol 2 已有 `progress` 事件，当前 `mossInfer.ts` 会转换为 Runner 风格的 `stage`/`progress` 事件；Supervisor 已将其写入 `JobRecord.progress` 并广播 `Events.job`。主要缺口在于 Studio Canvas 和终端没有将这些字段作为明显的进度 UI 展示。

Canvas 底部和终端当前任务头部共同显示：

- 队列等待：排队位置/等待状态（无需伪造百分比）。
- 启动/模型加载：阶段标签与不确定进度动画。
- 文本编码：阶段标签与不确定进度动画。
- 去噪：`current / total`、百分比及可用 ETA。
- VAE 解码、保存：阶段标签与不确定进度动画，完成后 100%。
- 失败/取消/成功：终态标签，不留旋转中的进度条。

阶段名使用对用户友好的术语（如“准备引擎”“加载模型”“文本编码”“去噪”“解码”“保存”），不直接暴露内部 enum 名称。阶段切换不应让总进度倒退；去噪步骤进度只表示采样过程，不冒充整个任务的精确百分比。

### 5.2 文本进度兼容

- MossInfer 的结构化事件是主来源；优先补齐协议事件字段、Supervisor Job 更新和 UI 消费。
- TQDM/stdout/stderr 解析仅作为旧 Runner 或第三方程序的回退。复用现有 `parseTqdm`、`LineSplitter` 和诊断管道，覆盖 carriage return、ANSI 清理、stderr 与分块输入。
- 文本解析出不确定阶段时只更新阶段/步骤，不应覆盖可靠的结构化进度，也不能凭单条“x/y”误识别模型日志。
- 若 OwOinfer/MossInfer 分支仍缺少阶段，优先增补稳定的机器可读 protocol event（阶段、当前步、总步、每步耗时/ETA、消息）；面向人的 stderr 日志可保留，但不作为 UI 契约。
- 协议事件应对缺失/未知字段向前兼容；未知阶段落到“处理中”，而不是错误地归类为去噪。

### 5.3 可观察性

- 终端继续显示详细日志；同时在任务头部/任务列表显示阶段、进度条、步数和 ETA，避免日志滚动把状态挤走。
- Canvas 与终端的数据源必须是同一个 Job 更新，不各自解析 stdout 得出不同百分比。
- 日志不可用时仍显示 Job 结构化进度；进度不可用时显示阶段/运行状态，不假造百分比。

## 6. 生成结果呈现

- Result Canvas 完成后直接显示输出图；加载缩略图失败时保留“打开文件”和错误状态。
- 图像按 Canvas 容器等比缩放，不改变 Project 逻辑尺寸/生成尺寸；支持点击查看大图。
- 提供“设为布局参考/背景”显式操作，但不自动把结果作为可编辑 bbox 布局，也不自动覆盖现有背景。
- 多张输出作为同一个 Result Canvas 内的结果集合；支持切换/缩略图；除非引擎/Job 返回多个结果，不预留虚构占位图。
- 画廊继续显示所有输出，并可从画廊跳转到拥有对应 Result Canvas 的 Project（若可追溯）；画廊不是生成成功后的唯一可发现路径。

## 7. 持久化与兼容迁移

> **As-built（2026-10-31）**：最终落地的 `schemaVersion` 是 **3**，不是本节建议的 2。兼容策略也已反转——**不保留 v1/v2 读取**，旧文件直接视为不可读。本节以下内容保留为当时的推导过程，字段以 [backend-and-project.md](../backend-and-project.md) 为准。

当前 `ProjectDocument` 为 `schemaVersion: 1`，在 Project 根记录一份尺寸、summary、layers、Prompt 和生成参数。多 Canvas 需要将创作状态下沉到节点层级。

建议 `schemaVersion: 2` 采用如下逻辑结构（字段名可在实现时与现有类型统一）：

```ts
interface ProjectDocumentV2 {
  schemaVersion: 2
  id: string
  name: string
  canvases: CanvasDocument[]
  selectedCanvasId?: string
  board: { columns: 2; positions: Record<string, { row: number; column: number }> }
  createdAt: string
  updatedAt: string
}

interface CanvasDocument {
  id: string
  kind: 'layout' | 'result'
  title: string
  layout?: {
    width: number
    height: number
    summary: LayoutSummary
    layers: ProjectLayer[]
    prompt: string
    negative: string
    seed: number
    steps: number
    cfg: number
    modelBundleId?: string
    deviceId?: string
    backgroundPath?: string
  }
  generation?: {
    sourceCanvasId?: string
    jobId?: string
    params: GenerationSnapshot
    statusSnapshot?: JobState
    outputs: Array<{ path: string; width: number; height: number; seed: number }>
    error?: { code: string; message: string }
  }
}
```

迁移规则：

1. 读取 schema v1 时，在内存中映射为一个稳定 ID 的 Layout Canvas，复制全部字段；保留 Project ID、创建/更新时间、系列/页等旧元数据。
2. v1 → v2 的写入采用原子文件替换/备份策略；读旧文件本身不立即改写，只有用户保存或显式迁移时升级，避免启动时破坏旧数据。
3. 旧的 `backgroundPath` 继续作为迁移后 Layout Canvas 的参考背景。
4. 旧的 `instanceId` 仍忽略；不重新引入 Instance 依赖。
5. 现有画廊输出不移动、不复制、不删除；不能可靠关联到旧 Project 的图片继续在全局画廊中可见。
6. 新增/删除 Canvas、节点顺序、画布参数、Job 关联都通过 Project save 持久化；运行中的进度从 Job 服务实时恢复，不高频写入 Project 文件。
7. 删除 Project 不级联删除 Job 输出或模型文件，沿用当前数据边界。

Job 需要增加可选的 `projectId`、`canvasId`/关联元数据，或在 Project 中保存 Job ID；关联字段必须在 HTTP、本机事件和远端路径中一致，并避免循环嵌套保存完整 Job。

## 8. API 与架构变化

- Project API 从保存单份根布局演进到保存/读取完整 Canvas 集合；v1 输入继续兼容或在服务边界完成迁移。
- `/api/engine-jobs` 请求携带 `projectId`、`canvasId` 和参数快照；Job 创建成功后立即返回 ID，前端将其绑定到任务 Canvas。
- `/api/jobs/:id` 和 WebSocket `Events.job` 继续提供权威任务状态；结果与进度使用既有输出/进度字段，必要时增补协议字段而非新增重复的 UI 状态 API。
- 所有用户输入仍需 Zod schema 验证；Canvas ID 与 Project ID 作为关联标识验证，文件路径沿用输出服务的受控路径处理。
- Supervisor/任务协调器负责串行队列、取消与启动下一个任务；renderer 不自行启动多个并发请求。
- UI 需覆盖 HTTP Web、Electron IPC/事件与 Project JSON 三条消费/持久化路径，不能只在桌面 React 组件维护临时状态。

## 9. 失败与边界场景

| 场景 | 预期行为 |
| --- | --- |
| 模型未准备好/绑定失效 | 不创建运行中任务；在所选 Layout Canvas 显示可操作错误和模型页入口 |
| 用户提交后立即切换 Project | 任务仍在全局串行队列运行；完成后按 Project/Canvas ID 更新原节点 |
| Project 被关闭或应用重启 | 从持久化 Job ID 恢复状态；运行任务遵循现有重启中断策略 |
| Canvas 正在排队时删除 | 先取消队列项并确认，或禁止删除并解释；不留下孤儿 Job |
| Canvas 正在运行时删除 | 要求确认停止后删除关联，输出仍保留；不得静默终止 |
| Job 记录已清理但输出存在 | Result Canvas 保留输出和最后快照，状态标成“任务记录不可用” |
| 输出文件被外部删除 | 显示缺失占位、路径和打开/重新生成操作，不显示空白画布冒充未完成 |
| 多输出 Job | 单 Result Canvas 内分页/切换输出，统一引用同一个 Job |
| 未知/缺失 progress 字段 | 保持运行阶段和不确定进度，不抛错或制造百分比 |
| 连续快速提交多个 Canvas | FIFO；清楚显示排队位置，所有 Canvas 不并行运行 |

## 10. 实施阶段

### Phase 1：任务 UX 基础

- 在终端任务列表/头部显示现有 `JobRecord.progress` 阶段、百分比、步数、ETA。
- 为旧 Runner 补齐或验证 TQDM 文本回退；增加结构化进度到 UI 的测试。
- 明确展示成功输出链接/预览入口，为后续 Result Canvas 确认链路。

### Phase 2：Project v2 与 Board

- 定义并验证 v2 schema、v1 读取迁移、原子保存和 Project summary 统计。
- 实现 Board 网格、空入口、选中态、空白提示和多 Canvas 参数面板。
- 实现新增、复制参数、删除和稳定位置持久化；先不接真实生成也能编辑/重开。

### Phase 3：任务与 Canvas 关联

- 实现单一串行队列、排队取消、运行取消及 Project/Canvas/Job 关联。
- 实现任务 Canvas 底部进度、终态错误、重跑生成新节点。
- 建立 HTTP 与 WebSocket 任务恢复测试，覆盖切换 Project 和重启。

### Phase 4：结果 Canvas 与回归

- 完成后把输出绑定 Result Canvas 并自动显示图片；加入打开/放大/设为参考操作。
- 验证全局画廊兼容、旧 Project 迁移、输出不被级联删除。
- Windows RTX 2080（SM75）验收 Reference + exact attention；记录实际阶段、百分比和最终 PNG。

## 11. 验收标准

- 新 Project 打开时显示单一“新建内容”入口；点击后形成 Layout Canvas 和相邻新建入口。
- Project 至少支持多个独立 Canvas；各自 Prompt、布局、参数和模型选择互不串值；保存/重启后保持一致。
- 未选择 Canvas 时编辑控件禁用且提示明确；选择后操作目标始终与高亮节点一致。
- 复制参数只创建草稿；重跑永不覆盖旧 Canvas/图片，并在源节点下方生成新任务节点。
- 任意时刻最多一个 Studio Canvas 推理任务运行；后续任务可见 FIFO 状态且可取消。
- MossInfer 结构化进度在终端和对应 Canvas 一致显示阶段；去噪显示准确的 `step/total`，其他阶段不显示伪造百分比。
- 任务完成后图像直接显示在对应 Result Canvas；成功不依赖用户去画廊寻找。
- 错误、取消、模型缺失、Job 丢失和文件缺失都有明确原位状态。
- schema v1 Project 可无损读取；升级后 Project 与全局输出/模型数据均不丢失。
- 自动化测试覆盖 Project schema/迁移、FIFO/取消、Canvas-Job 关联、进度映射、结果路径和 renderer 状态；Windows SM75 真实生成作为硬件验收。

## 12. 待实现前确认的产品细节

以下细节不改变上述核心模型，但应在视觉稿/Phase 2 前定稿：

1. 生成结果是否占用与布局 Canvas 相同尺寸的节点，或结果图像在固定比例卡片内完整适配。
2. Canvas 标题自动取 Prompt 摘要还是由用户命名；自动标题允许后续编辑。
3. Board viewport 的缩放/平移状态是保存在设备本地，还是作为 Project 跨设备共享。
4. 远端输出完成回传之前，Result Canvas 使用“传回中”子阶段还是统一归入“保存”阶段。
