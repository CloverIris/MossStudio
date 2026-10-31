# 实现状态

最后更新：2026-10-31
版本：`0.1.0`（开发版）

## 1. 当前可运行

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 双窗口 shell | ✅ | Studio + Trainer；管理页/终端在 Studio 内 |
| Studio 三列工作台 | ✅ | 左右栏可调宽/收起，卡片可调高，面板可拖拽停靠 |
| 画布 tabs | ✅ | 新建、保存状态、拖动排序、未保存草稿保留 |
| 画布编辑 | ✅ | 区域框内提示词、缩放/平移、图层列表双向定位 |
| 本机 MossInfer | 🟡 | `startEngineJob` + fake sidecar 通过；真实 NVIDIA 未验收 |
| 引擎管理页 | ✅ | 状态、探测、Release 选择、安装进度/通知、本机版本切换与删除 |
| system/bundled 引擎包 | 🟡 | Windows ZIP 使用 Node 解压；Linux tar、预检、bundled 回退、CUDA wheel 解压已接；真实包未验收 |
| Linux SSH 远端 sidecar | 🟡 | fake SSH 出图通过；真实 Linux GPU 未验收 |
| 远端 HF 模型准备 | 🟡 | 默认 SFT curl 下载；组件 bundle/断点续传未做 |
| 模型库/下载 | 🟡 | 组件、HF 缓存、推荐组合；真实生成未验收 |
| Project/系列页 | ✅ | 自动保存、分页、模型/设备字段 |
| Agent | 🟡 | Provider、历史、分段/确认、快捷动作；真实模型调用未验收 |
| GBC 解析桥 | 🟡 | 外部 `gbc`、导入区域；真实 GBC/GPU 未验收 |
| Trainer | 🟡 | 独立窗口、Python/Git 环境；真实训练未验收 |
| LAN WebUI | 🟡 | HTTP/WS、布局编辑器；实例选择旧路径未清理 |
| 安装包/签名 | ⬜ | 无 NSIS/签名/公证产物 |

## 2. 推理链路

```
Studio → /api/engine-jobs → startEngineJob
  → local moss-server
  → Linux SSH moss-server
  → outputs/<job>.png
```

- 推理任务不再要求 Instance/Python runtime。
- 本机 `mossInfer.ts` 是单例 + FIFO。
- 远端目前每个 job 一个 SSH sidecar 进程；引擎控制台已按 host 聚合，持久单引擎队列仍待补。
- 旧 `instances/git/remoteInstances/runtimes/runner` 文件仍在仓库中，但产品入口已删除；下一轮清理。
- 旧推理数据首次启动归档到 `legacy-inference-*`。

## 3. 验证证据

```bash
pnpm typecheck
pnpm build
pnpm test:ui
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --smoke
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-engine-job
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-remote-job
```

当前本机结果：

- typecheck ✅
- build ✅
- UI checks 100%/150%/200% ✅
- fake 本机 sidecar 出图 ✅
- fake SSH 远端 sidecar 出图 ✅

## 4. 已知限制

- 开发机 macOS 无 NVIDIA，真实 MossInfer 不能本地运行。
- Windows/Linux 的真实引擎下载、CUDA 库、出图未验收。
- 远端 HF 只做默认 SFT 全量；组件 bundle、断点续传、失败恢复未完成。
- 远端引擎安装未在真实主机验证。
- 上游 Release/API 与真实引擎包下载、安装尚未在 Windows/Linux NVIDIA 主机验收。
- Trainer 仍依赖 Python/Git；GBC 依赖外部 Python 工具。
- LAN WebUI 仍保留实例 bootstrap 兼容字段。
- 旧推理模块/场景文件未全部删除。

## 5. 下一轮

1. 删除 `instances/git/remoteInstances/runtimes/cases` 和旧 scenario/store/WebUI 引用。
2. 远端 `RemoteEngineManager`：每 host 一个持久 sidecar + FIFO，替代每 job 一个进程。
3. 真实 Windows/Linux NVIDIA 验收：预检、system/bundled、wheels、出图。
4. 正式安装包、签名、更新。
