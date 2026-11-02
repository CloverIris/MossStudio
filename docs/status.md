# 实现状态

最后更新：2026-11-02
当前开发版本：`1.0.2`（严格 SemVer；未构建发布包）
更新验收基线：`1.0.1` Windows x64 便携包

## 1. 当前可运行

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 双窗口 shell | ✅ | Studio + Trainer；管理页/终端在 Studio 内 |
| Project 多 Canvas 画布板 | ✅ | 自由坐标、拖动、缩放锚点、缩略图、适配视图 |
| Canvas 卡片 | ✅ | 按自身宽高比呈现、状态色、生成中动画与底部进度绑带 |
| 布局 Canvas 编辑 | ✅ | 区域框内提示词、图层列表双向定位、图层拖拽排序 |
| 生成与结果 | ✅ | 串行队列；结果落在新 Canvas，不覆盖旧结果；双击预览 |
| Canvas LoRA | ✅ | 每画布选择权重与强度；id 在提交时解析为路径，缺失/远端/未安装直接报错；支持导入本地 `.safetensors` |
| 更新与公告 | ✅ | 启动、定时（45 min）与窗口聚焦时检查；标题栏版本胶囊、通知中心未读角标、公告自动推送 |
| 布局 Prompt 合成 | ✅ | 有区域自动编译，无区域用手写提示词；提交前可预览 |
| Project tabs | ✅ | 重命名、删除、拖动排序、`Ctrl/Cmd+S` 显式保存、自动保存 |
| 本机 MossInfer | ✅ | Windows + RTX 2080 真实出图（1024² / 8 步 / 69.2s） |
| GPU 质量档兼容 | ✅ | 按任务实际分配的 GPU 生效；SM 8.0 以下固定 Reference（BF16），不影响同机其他 GPU |
| 引擎管理页 | ✅ | 状态、探测、Release 选择、安装进度、本机版本切换与删除；下载/探测/兼容性都在 `.staging` 完成，安装失败不进版本列表 |
| GPU 清单与默认设备 | 🟡 | 启动扫描 UUID/SM/显存；OOBE/引擎页可选默认卡与显存建议；按 GPU 持久化 memory/tier 覆盖并随 Job 快照；标题栏展示统一遥测与队列；Canvas UUID 绑定、每卡独立 sidecar/队列；真实双卡硬件复验待完成 |
| system/bundled 引擎包 | 🟡 | Windows ZIP、Linux tar、预检、CUDA wheel 解压已接 |
| Linux SSH 远端 sidecar | 🟡 | fake SSH 出图通过；真实 Linux GPU 未验收 |
| 远端 HF 模型准备 | 🟡 | 默认 SFT curl 下载；组件 bundle/断点续传未做 |
| 模型库/下载 | ✅ | 组件、HF 缓存、推荐组合、本地导入 |
| Agent | 🟡 | Provider、历史、分段/确认、快捷动作；真实模型调用未验收 |
| GBC 解析桥 | 🟡 | 外部 `gbc`、导入区域；真实 GBC/GPU 未验收 |
| Trainer | 🟡 | 独立窗口、Python/Git 环境；真实训练未验收 |
| 设置页 | ✅ | 8 个任务域分区；设备别名/启停可持久化 |
| LAN WebUI | 🟡 | HTTP/WS 可用；Web 端仍是简化布局编辑器 |
| 安装包/签名 | ⬜ | 无 NSIS/签名/公证产物 |

## 2. 推理链路

```
Studio → IPC / HTTP → startEngineJob
  → local moss-server（每 GPU UUID 独立 sidecar + FIFO）
  → Linux SSH moss-server
  → outputs/<job>.png
```

- 推理任务不要求 Instance / Python runtime。
- `prompt` 由 Canvas 布局编译而来（有区域时），无区域时取手写提示词。
- 远端目前每个 job 一个 SSH sidecar 进程；per-host 持久队列仍待补。
- 旧 `instances/git/remoteInstances/runtimes/runner` 文件仍在仓库中，产品入口已删除。

## 3. 验证证据

```bash
pnpm typecheck
pnpm build
node --test "tests/*.test.mjs"
CLOVER_UI_NO_SANDBOX=1 pnpm test:ui
pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-engine-job
```

本机结果（Windows 11 / RTX 2080 / CUDA 12）：

- `tsc -p tsconfig.node.json` ✅ 0 error
- `tsc -p tsconfig.web.json` ✅ 0 error
- `electron-vite build` ✅
- 工具链与协议测试 74 项断言 ✅（含 LoRA、更新/发布文档、引擎协议、原子安装、就绪状态）
- `pnpm test:ui` ✅ 100% / 150% / 200% 三档缩放，含 LoRA 选择与强度、引擎就绪页面分支
- 真实出图：`job-mvw31llh-60fe09`，1024×1024，8 步，CFG 3，seed 42，profile `dmd8`，耗时 69.2s，输出 `outputs/job-mvw31llh-60fe09-1.png` ✅

## 4. 已知限制

- RTX 2080 是 Turing（CC 7.5）；在引擎页选择 SM75 架构包（上游 v2.1.1+，Windows CUDA 13）而非默认 SM80+ 构建。默认 bundled 与 system-cuda 均为 CUDA 13；CUDA 13 需要 NVIDIA R580+ 驱动，不会静默降级到 CUDA 12。
- 架构自动选择改为依赖独立 GPU 清单；若驱动无法报告 SM，必须手动选择，禁止静默回退到标准包。多卡并发已有 fake-server 验证，真实双卡硬件验收仍待完成。
- 真实引擎下载、CUDA 库修补只在单台 Windows 机器上验证过；Linux 远端未验收。
- 远端 HF 仅默认 SFT 全量；组件 bundle、断点续传、失败恢复未完成。
- Trainer 仍依赖 Python/Git；GBC 依赖外部 Python 工具。
- **无向前兼容**：`project.json` 只读 `schemaVersion: 3`，旧工程不会出现在列表里。
- 已发布 Windows x64 便携 ZIP 与应用内更新，但没有签名安装程序；macOS/Linux 产物仍未构建。
- 远端引擎（SSH）暂不支持 LoRA；选择远端引擎时提交会直接报错，不做静默降级。

## 5. 下一轮

1. 发布 1.0.2：`pnpm release:build`、上传 ZIP 与 `release.md`，tag 用 `1.0.2`（不带 `v`）。
2. 签名安装包与 NSIS 产物、通道验证。
3. 真实 Linux NVIDIA 远端验收：预检、system/bundled、wheels、出图。
4. 远端 `RemoteEngineManager`：每 host 一个持久 sidecar + FIFO。
