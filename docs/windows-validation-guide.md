# Windows 开发与验收手册

本文面向 Windows 实机开发与验收。当前仓库有 Windows 代码路径，但**尚未提供 Windows 安装包/签名，也未完成真实 NVIDIA Windows 出图验收**。

## 1. 当前边界

- 两个窗口：MossStudio（创作 + 底部管理页 + 终端抽屉）、Kohaku Trainer。
- 推理：MossInfer `moss-server`，Windows x86_64 + NVIDIA。
- 不再需要官方 MOSS 仓库、推理 Python、Instance 或 runtime。
- Trainer 仍需要 Python/Git；这些检测只在 Trainer 范围。
- 远端 sidecar 只支持 Linux x86_64 + NVIDIA。
- 没有 NSIS、签名、公证或自动安装器；`pnpm build` 只验证 Electron/Vite 构建。

## 2. 环境记录

请记录：

- Windows 版本、架构、DPI；
- Node.js、pnpm、Git；
- NVIDIA 驱动、`nvidia-smi`；
- CUDA Toolkit / `cublasLt64_*.dll` 位置；
- 模型/引擎/输出目录；
- 磁盘剩余空间。

## 3. 构建与测试

```powershell
corepack enable
corepack prepare pnpm@9.14.2 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm --filter @clover/desktop exec electron . --smoke
```

UI：

```powershell
pnpm test:ui
# 设备 DPI 审查：网页缩放保持 100%，分别启动设备缩放 100%/125%/150%/175%/200% 的独立进程
node tools/test-ui.mjs --dpi
```

DPI 审查使用实际 App 外壳、创作页和设置页，配合内存 IPC 与临时用户目录，不读写 `.dev-data/`。
报告及原始截图保存在 `docs/assets/ui-dpi-review/index.html`，并记录实际 DPR、网页 zoom、窗口/工作区 DIP、
截图物理像素、计算字号、画布区和滚动容器。覆盖生产默认窗口、本机工作区和 1080p 工作区三个场景；
窗口最小尺寸保持生产设置，边框及分数 DPI 的舍入允许 2 DIP 误差。
`--dpi` 通过 Electron 设备缩放开关模拟，不更改 Windows 显示设置；不替代真实跨屏拖动验收。
原有 `--scaled` 使用 `webContents.setZoomFactor`，属于网页缩放回归，应与设备 DPI 结果分别记录。

材质回归同时检查构建后的 `backdrop-filter` 和动画中间帧的实际像素。
覆盖页面淡入、浮层淡入/淡出与反向重开、关闭动效时的清理，以及 100%/150%/200% renderer 缩放。
共用玻璃表面（`.glass`、`.glass-thin`、`.glass-strong`、`.content-surface`）的祖先不参与透明度动画，
位移保留在容器，透明度作用于玻璃表面自身和不包含玻璃子层的内容组，避免截断背景采样。
卡片淡出时背景自然显露；检查的是模糊贡献随透明度连续变化，而非整个动画期间突然失效。

MossInfer fake sidecar：

```powershell
pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-engine-job
pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-remote-job
```

## 4. 验收矩阵

| 项目 | 操作 | 通过标准 |
| --- | --- | --- |
| 启动 | `pnpm dev` | 只出现 Studio；Trainer 由训练页打开 |
| 引擎版本 | 引擎页加载 GitHub Release | 可选择多个正式版本；无 Release 时明确提示 CI 回退和 Token 要求 |
| 本机版本管理 | 下载多个引擎包 | 可查看、切换、删除历史版本；正在使用的版本不可删除 |
| 引擎预检 | 引擎页选择 system-cuda | 正确识别 `cublasLt64_*.dll` / 缺失 |
| 引擎解压 | 下载 Windows ZIP 包 | `yauzl` ZIP 流程完成，不要求系统 Python |
| 缺库回退 | 没有系统库时安装 | 弹窗可选 bundled；下载后 `hello` 成功 |
| 原生 CUDA wheel | 选择“下载 system + 解压 CUDA 库” | 不调用 Python/uv/pip；lib/bin 出现 DLL |
| 模型 | 模型库下载/导入 | 组件完整，Project 可选 |
| 生成 | 选择模型/设备，开始生成 | PNG 输出到 outputs；取消/失败有日志 |
| 引擎控制台 | 终端抽屉切本机/远端 | 只显示 engine 聚合视图；无每个 Case 一个终端 |
| 远端 | Linux SSH host 安装引擎/准备模型/生成 | SSH sidecar 出图，PNG 回传 |
| Trainer | 打开 Trainer | Python/Git 检测只在 Trainer 内 |

## 5. 已知风险

- Windows wheel 解压后的 DLL 搜索路径需要实机确认。
- 系统 CUDA Toolkit 版本必须与引擎 cu12/cu13 匹配。
- GitHub release/artifact 下载和真实 Windows NVIDIA 安装仍需实机验证。
- 真实远端 UDP/SSH 网络、路径空格、中文路径、非 ASCII 用户名需实测。
- 打包/签名/更新未实现。

## 6. 失败记录

记录至少包含：

- 复现步骤、截图/日志路径；
- `nvidia-smi`、cuBLASLt 路径；
- 引擎版本/包类型；
- 模型路径；
- 是否 fake/真实；
- 是否已回退到 bundled。
