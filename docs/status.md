# 实现状态

最后更新：2026-10-31
版本：`0.1.0`（开发版）

## 1. 当前可运行

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 双窗口 shell | ✅ | Studio + Trainer；管理页/终端在 Studio 内 |
| Project 多 Canvas 画布板 | ✅ | 自由坐标、拖动、缩放锚点、缩略图、适配视图 |
| Canvas 卡片 | ✅ | 按自身宽高比呈现、状态色、生成中动画与底部进度绑带 |
| 布局 Canvas 编辑 | ✅ | 区域框内提示词、图层列表双向定位、图层拖拽排序 |
| 生成与结果 | ✅ | 串行队列；结果落在新 Canvas，不覆盖旧结果；双击预览 |
| 布局 Prompt 合成 | ✅ | 有区域自动编译，无区域用手写提示词；提交前可预览 |
| Project tabs | ✅ | 重命名、删除、拖动排序、`Ctrl/Cmd+S` 显式保存、自动保存 |
| 本机 MossInfer | ✅ | Windows + RTX 2080 真实出图（1024² / 8 步 / 69.2s） |
| 引擎管理页 | ✅ | 状态、探测、Release 选择、安装进度、本机版本切换与删除 |
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
  → local moss-server（单例 + FIFO）
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
node --test tools/test-onboarding.mjs
pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-engine-job
```

本机结果（Windows 11 / RTX 2080 / CUDA 12）：

- `tsc -p tsconfig.node.json` ✅ 0 error
- `tsc -p tsconfig.web.json` ✅ 0 error
- `electron-vite build` ✅
- 工具链测试 8 个套件 55 项断言 ✅
- 真实出图：`job-mvw31llh-60fe09`，1024×1024，8 步，CFG 3，seed 42，profile `dmd8`，耗时 69.2s，输出 `outputs/job-mvw31llh-60fe09-1.png` ✅

## 4. 已知限制

- RTX 2080 是 Turing（CC 7.5），默认引擎构建面向 Ampere 8.0+，需配置 tier/attention 才能跑。
- 真实引擎下载、CUDA 库修补只在单台 Windows 机器上验证过；Linux 远端未验收。
- 远端 HF 仅默认 SFT 全量；组件 bundle、断点续传、失败恢复未完成。
- Trainer 仍依赖 Python/Git；GBC 依赖外部 Python 工具。
- **无向前兼容**：`project.json` 只读 `schemaVersion: 3`，旧工程不会出现在列表里。
- 无安装包、无签名、无自动更新产物。

## 5. 下一轮

1. 安装包与更新：NSIS 产物、签名、通道验证。
2. 真实 Linux NVIDIA 远端验收：预检、system/bundled、wheels、出图。
3. 远端 `RemoteEngineManager`：每 host 一个持久 sidecar + FIFO。
4. 清理仓库里残留的旧推理模块与 scenario。
