# MossInfer 迁移状态

## 引擎版本

- 适配 MossInfer 2.0（owoinfer v2.0.0，server protocol 2 / ABI 1）：
  - `hello` 发送/校验 `protocol_version: 2`（本机 `mossInfer.ts`、远端 `remoteEngine.ts`、一次性探测 `probeEngine.ts`）；
  - `load` 的 `tier` 必填且只能是 `reference | high | turbo`：设置项移除 `auto`，旧配置迁移为 `high`（上游推荐默认；bf16 bundle 的精确档为 `reference`）；
  - 下载/安装路径不变：release 资产与 CI artifact 命名在 2.0 未变（`mossinfer-<version>-<os>-cu<N>-x86_64[-system-cuda]` / `mossinfer-<platform>-cuda<N>`）。

## 统一协议解码与兼容判定

- `shared/engineProtocol.ts` 是所有不可信 `hello` 的唯一运行时解码入口；一次性本机探测统一由 `main/lib/probeEngine.ts` 启动、超时并关闭进程，远端只复用同一解码与 protocol 2 门禁。
- `EngineHello.raw` 保留原始响应供开发者诊断；业务代码只消费解码后的协议、设备和 `probe` 字段。
- 引擎返回的目标设备 `supported: true` 是兼容性唯一权威。缺失或为 `false` 都拒绝；不再由客户端用 `compute_major >= 8` 或 SM75 名称自行推断。算力、驱动和构建架构差异只用于选包、展示与 warning。
- 长驻本机 runtime 已设置 `CUDA_VISIBLE_DEVICES`，目标卡在 hello 中重映射为序号 0，因此只用序号匹配，不能再按系统序号或名称猜测。

## 原子安装与版本验证

- 下载、CUDA wheels、probe、兼容性判定和 `.engine.json` manifest 全部在 `.staging` 完成；只有验证通过才执行目录晋升。校验失败的目录不会进入版本列表。
- 替换当前版本时先 shutdown，再把旧目录移到 `.backup`；rename 失败自动回滚，settings 只在晋升成功后更新。启动时根据 `.pending.json` 恢复中断事务。
- 无 manifest 的旧目录继续显示为「未验证」，不隐藏也不删除；通过「验证并切换」重新探测并写入验证记录后才可激活。切换已验证版本也会刷新当前 GPU 的验证记录。
- managed 验证记录写入安装目录的 `.engine.json`；external 验证记录只写应用数据目录下的 `external.json`，绝不修改用户选择的外部引擎目录。
- 活跃安装进度仅保存在内存；最近一次成功或失败写入 `last-attempt.json`，取消不会覆盖这条历史。

## 单一就绪状态

- `EngineReadiness` 统一为 `missing | unverified | stale | unsupported | ready`，由 `main/services/engineReadiness.ts` 计算和缓存；store、Engine、Oobe、Settings 不再各自用 binary 是否存在推断可用性。
- readiness 按引擎路径、mtime 和 GPU 选择失效；只有未验证或验证过期的条目允许强制重新 probe，不会仅凭一次探测伪造验证记录。
- `ready` 与 `lastAttempt.error` 可以同时存在，统一表达「当前引擎仍可用，上次更新失败」，不能一边显示就绪、一边把当前引擎标成缺失。

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
