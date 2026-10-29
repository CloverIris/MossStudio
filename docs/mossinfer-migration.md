# MossInfer 迁移状态

## 引擎版本

- 适配 MossInfer 2.0（owoinfer v2.0.0，server protocol 2 / ABI 1）：
  - `hello` 发送/校验 `protocol_version: 2`（本机 `mossInfer.ts`、远端 `remoteEngine.ts`、`probeMossInfer`）；
  - `load` 的 `tier` 必填且只能是 `reference | high | turbo`：设置项移除 `auto`，旧配置迁移为 `high`（上游推荐默认；bf16 bundle 的精确档为 `reference`）；
  - 下载/安装路径不变：release 资产与 CI artifact 命名在 2.0 未变（`mossinfer-<version>-<os>-cu<N>-x86_64[-system-cuda]` / `mossinfer-<platform>-cuda<N>`）。

## 已完成

- 默认推理后端：`mossinfer`
- 引擎控制页（`/engines`）
  - 本机路径/状态
  - `hello` 探测
  - stable/dev 下载
  - 默认 system-cuda，下载前检测系统 cuBLASLt
  - 缺库时弹窗：bundled，或下载 system + 原生解压 NVIDIA wheels
  - 不再用 uv/pip 自动装库
  - 下载进度/取消
  - SSH 主机列表（远端目标占位）
- 无 Instance 的引擎任务
  - `startEngineJob`：只接受模型绑定、设备、生成参数
  - 输出目录：`<userData>/outputs`
  - `/api/engine-jobs` 供桌面/WebUI 提交
  - `mossinfer-engine-job` 冒烟通过
- Studio
  - 移除实例选择、实例 URL、Project `instanceId` 写入
  - 改选模型 bundle + 设备
  - Project 记录 `modelBundleId`/`deviceId`
- UI fixture 改为验证无实例引擎 payload
- Linux SSH 远端 sidecar（第一版）
  - 复用 SSH host 的 `engineRoot`/`outputRoot`
  - SSH 启动远端 `moss-server`，JSON-lines 协议
  - 远端生成 PNG 通过 SSH + base64 回传本地
  - 远端 HF 默认 SFT 下载（curl，无 Python）
  - 远端 bundled 引擎安装（GitHub Release + curl/tar，无 Python）
  - host 记录 `modelPath`，Studio 选择远端时自动带出
  - `mossinfer-remote-job` fake SSH 冒烟通过

## 下一阶段

1. 删除 `Instances`/`InstanceDetail`/`Home`/`Run` 页面与 App 路由残留
2. 删除推理 Worker：`git.ts`、`instances.ts`、`remoteInstances.ts`、`runtimes.ts` 的推理部分
3. 删除旧 `startJob`/runner Python 路径；所有推理只走 `startEngineJob`
4. 删除 `/api/instances`、`listInstances`、cases/launchQueue 旧数据
5. 远端（部分完成）：
   - SSH 启动 Linux sidecar ✅
   - 远端输出回传 ✅（base64，后续改 scp）
   - 远端 HF 默认 SFT 下载 ✅（组件 bundle/断点续传待补）
   - 远端引擎安装/解压 ✅（Linux x86_64 bundled）
6. Python/Git 检测只保留在 Trainer
7. 旧推理数据重置/归档 ❌（已实现首次启动归档，尚未清理旧模块）
8. 真实 Windows/Linux NVIDIA 验收

## 注意

- 当前 macOS 开发机没有 MossInfer 二进制；只能跑 fake sidecar/管理 UI。
- GBC 仍是显式可选外部 Python 工具，不进入核心启动检测。
- Trainer 仍保留自己的 Python/Git 环境。
