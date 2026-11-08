# ADR-0007：MossStudio 作为唯一最终用户 UI，官方 Gradio 退役

- 状态：**方向已确认（2026-10-20），P0/P2 基础链路与移动端 Layout 编辑器已落，画廊/PIN 待做**
- 取代：[ADR-0004](0004-workspaces-remote-devices.md) 中“不做浏览器 WebUI”这一条
- 关联：[ADR-0003](0003-launcher-first.md)、[ADR-0005](0005-release-channel-and-updates.md)
- 影响：窗口、路由、Case、Gradio 支持、后端 API、局域网服务、移动端布局、文档

## 1. 背景

当前产品有两条生成入口：

1. 启动器启动官方 `gradio_app.py`，在浏览器/独立窗口里生成；
2. 独立创作窗口，走 Clover 后端 + 薄 runner。

官方 Gradio 只适合作为上游参考，不适合作为正式产品的最终用户 UI：

- 启动器无法控制生成表单的布局/交互，Case 只能保存启动参数；
- Gradio 是另一套视觉与状态，无法和 Project、画廊、模型、诊断统一；
- 远端 Gradio 还要额外做 SSH 隧道/输出回传；
- 正式发布不应让用户看到两套产品。

同时，创作窗口目前只有 Electron 桌面版，用户离开电脑就无法继续创作。
方向改为：**MossStudio 是唯一的最终用户创作 UI，同一套 UI 同时提供桌面版和
可显式开启的局域网 WebUI/移动端版。**

## 2. 决策

### 2.1 官方 Gradio 退役

- 不再把官方 Gradio 作为产品入口；不打包、不启动、不做 SSH 隧道；
- `Case.workspace` 的 `official` 降级为迁移输入：读取旧 Case 时一律映射到
  MossStudio，不丢实例/设备/参数；
- 删除 `GradioLaunchConfig`、Gradio 侧滑面板、Gradio 独立窗口、
  `gradio:open` IPC、Gradio 相关诊断/文档入口；
- 上游 `gradio_app.py` 仅作为我们 runner 的行为参考，不进入发布物；
- 上游模型/pipeline 的 layout、sampling、offload 语义仍以 MOSS-Image 为准。

### 2.2 MossStudio 是唯一最终用户 UI

- 现在的创作窗口更名为 **MossStudio**（窗口标题/品牌/路由入口统一）；
- 桌面版保留现有 Electron 窗口与交互；
- 启动器、训练、终端、设备管理器降级为**管理/高级界面**，不属于最终用户主流程；
- WebUI 只提供 MossStudio 的能力：Project、画布/Layout、提示词、生成、
  画廊、任务状态；不暴露训练、SSH、设备维护、设置写操作；
- 桌面版和 WebUI 共用同一套 Studio feature 组件与数据模型，不维护两份 UI。

### 2.3 两种呈现，一套业务

```
                    ┌─────────────────────────────┐
                    │  MossStudio feature layer    │
                    │  Project / Layout / Prompt   │
                    │  Job / Gallery / Model       │
                    └─────────────┬───────────────┘
                                  │ StudioClient
              ┌───────────────────┴───────────────────┐
              │ Electron transport (IPC)              │ Web transport (HTTP/WS)
              ▼                                       ▼
       Electron renderer                        浏览器 (LAN / 手机)
       desktop window                           responsive web shell
              │                                       │
              └──────────────┬────────────────────────┘
                             ▼
                    Electron main + backend
                    （唯一领域状态/文件/进程所有者）
```

- **StudioClient** 是传输接口：`projects.*`、`gallery.*`、`instances.list`、
  `jobs.start/cancel/list/logs`、`models.list`、`studio.capabilities`；
- Electron 实现走现有 preload/IPC；浏览器实现走 HTTP + WS；
- 业务状态仍由 main/backend 拥有，WebUI 不直接读文件、不执行 Node/系统命令；
- 同一 React 构建产出桌面路由和 Web 路由；移动端用响应式布局，不是第二套页面。

### 2.4 局域网 WebUI

- 由桌面应用显式开启“局域网访问”，默认关闭；
- 服务监听 `0.0.0.0:<port>`，只提供 MossStudio 静态资源 + Studio API；
- 访问凭证：每次开启生成随机 bearer token，二维码/链接携带 token；
  可选 4–6 位 PIN，作为同网段二次确认；
- 只允许 Studio 安全子集；不允许任意路径、文件浏览、终端、训练、设置写入；
- 显示当前连接数、可随时停止/轮换 token；
- 明确提示：同一局域网内拿到链接的人可以访问；不要在公共 Wi-Fi 开启；
- 传输先用 HTTP + token；TLS/反向代理不作为首版要求，文档写清边界。

### 2.5 移动端

- Web shell 增加手机断点：画布优先，工具栏折叠为底部/顶部 tab；
- 画布支持 pointer/touch 拖动与双指缩放；桌面保留 hover/右键/快捷键；
- 生成队列、进度、画廊在手机上可完成“看结果/继续生成”；
- 不在手机端做训练、SSH、设备维护。

## 3. 数据与安全边界

- `Project`：Project JSON + assets 仍由 main 写；Web 只做 CRUD；
- `Gallery`：Web 通过 token 化的 `clover://`/HTTP 资源访问，不暴露任意磁盘路径；
- `Job`：Web 提交的 Job 带 `source: 'web'`，终端/诊断可区分；
- 设置/模型下载/实例安装仍只在桌面管理面完成；
- Web 服务与 backend 进程同生命周期；桌面应用退出即停止；
- CORS 仅允许同源 Web shell；CSP 收紧，去掉开发期 `unsafe-eval`；
- token 不写日志；二维码只显示一次，可轮换。

## 4. 上游版本策略

- MOSS-Image：推荐 commit 前移到 `95559c93`；当前与 `c1355e6` 的差异只有
  文档/展示素材，推理接口未变；
- KohakuMossTrainer：稳定基线 `v0.1.0`；`main` 的 ComfyUI 权重、量化、
  FSDP/流水线等作为可选实验特性，不阻塞 Studio 改造；
- 训练仍通过外部 commit/worktree 接入，不 vendor、不 import；
- 上游变更记录见 [upstream-2026-10-20.md](../records/2026-10-20-upstream-research.md)。

## 5. 实施阶段

### P0：方向落地与 Gradio 退役

1. 文档/窗口/路由改名 MossStudio；
2. 旧 Case 的 `official` 迁移到 MossStudio；
3. 移除 Gradio UI、启动参数、独立窗口和 SSH 隧道入口；
4. 保留 runner 生成链，确保桌面 MossStudio 可独立生成。

### P1：传输层与桌面回归

1. 抽出 `StudioClient`，Electron 实现走 IPC；
2. 扩展 backend Studio API（projects/gallery/instances/models/jobs）；
3. MossStudio 桌面版全部改走 client，不直接 `call(Ipc.*)`；
4. 桌面回归：Project 保存/打开、布局编译、生成、画廊。

### P2：局域网 WebUI

1. Web 构建入口 + 静态服务；
2. token/PIN、开关、二维码、连接数、停止/轮换；
3. Web transport 与 WS 日志/进度；
4. 移动端断点与触控画布；
5. 真机手机/同网段验收。

### P3：清理

1. 删除 Gradio 代码/类型/文档残留；
2. 删除旧 Case 字段；
3. 更新 README/状态/路线图/发布说明；
4. 真实权重与 CUDA/SSH 回归。

## 6. 非目标

- 不做公网托管/账号/云同步；
- 不做手机原生 App；
- 不在 WebUI 暴露训练/终端/SSH/设置写操作；
- 不把 Electron 主进程改成独立云服务；
- 不要求 WebUI 在桌面应用关闭后继续运行。

## 7. 待确认

1. WebUI 首版是否接受“随机 token + 可选 PIN”，还是必须密码登录；
2. 桌面端是否保留启动器/训练/终端入口（建议保留在“高级”菜单，不作为最终用户主流程）；
3. 手机端首版是否必须支持画布拖拽，还是先支持提示词/生成/看结果；
4. 是否把 `MossStudio` 作为整个产品名，还是仅创作窗口名（当前按窗口名处理）。
