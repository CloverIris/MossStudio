# 路线图

- 更新：2026-11-02
- 当前开发版本：`1.0.2`（严格 SemVer；未构建发布包）
- 更新验收基线：`1.0.1` Windows x64 便携包（GitHub Release，tag `1.0.1`）
- 基线：[status.md](status.md)
- 当前判断：训练器/SSH 远端代码基座、Clover HTTP/WS 基座、Project JSON/基础图层已完成；
  下一步是 **真实 host/CUDA 验收**、**Clover 真实生成/Project UI 收尾**；
  发布源/更新弹窗/下载校验已接，真实签名安装与 electron-updater 排在 P2；
  系统 Git/Python 工具链检测与安装引导作为新的 P0 插到最前。

> 这里只列**尚未完成**的工作和验收条件。已完成能力见 [status.md](status.md)。
> 不使用虚构日期；按 P0/P1/P2 和依赖关系排。

## 0. 当前基线

已具备：

- 五窗口：启动器 / MossStudio（原创作）/ 终端 / Kohaku Trainer / 设备管理器；
- 环境、实例、运行时、模型、下载、画廊、诊断；
- Supervisor + runner + 终端；推理/训练共用 Job 表；
- Trainer 仓库/版本/环境/训练窗口/本机训练 Job；
- SSH host 探测、远端 mirror/worktree/venv/train/export 代码路径（fake ssh）；
- 队列落盘、实例 pin 切换、适配器绑定、设备启用/禁用；
- 独立 HTTP/WS Clover 后端（health/WS/RPC/simulate）；
- 远端 Instance 部署、旧 Gradio 隧道（将退役）；
- Project JSON+assets、自动保存、基础图层；
- GitHub Release `release.md`、公告/模型镜像、更新弹窗、sha256 下载/打开安装包。

未具备：

- 真实 SSH host / CUDA 验收；
- 真实训练导出/采样；
- Clover 真实生成验收、Project 完整 UI；
- 签名/公证安装包、electron-updater、macOS/Linux 打包（Windows 便携 ZIP 与在线更新已可用）；
- 系统 Git/Python 工具链检测、安装引导与 OOBE 运行环境（ADR-0006）。

> 官方 Gradio 退役、MossStudio 增加局域网/移动 WebUI（ADR-0007）；
> 旧 ADR-0004 的“不做浏览器 WebUI”已被取代。

## 0.4 P0 · MossStudio 单一 UI 与局域网 WebUI

**目标**：官方 Gradio 退出正式产品；MossStudio 成为唯一最终用户创作 UI，
同一套 Studio 能力提供桌面 Electron 窗口与局域网/移动 WebUI。

范围：

1. 旧 Case `workspace: official` 迁移到 MossStudio；删除 Gradio UI/启动参数/独立窗口；
2. 抽出 `StudioClient`，桌面走 IPC，Web 走 HTTP/WS；
3. backend 扩展 Project/Gallery/Instance/Model/Job 的 Studio 安全子集；
4. 局域网服务：显式开关、token/PIN、二维码、连接数、停止/轮换；
5. Web 构建与响应式/触控移动布局；
6. 桌面 MossStudio 回归，确保不依赖 Gradio 也能生成。

验收：

- 正式构建中不存在 Gradio 入口/窗口/启动参数；
- 旧 Case 打开后仍能用，不丢实例/设备/档位；
- 桌面 MossStudio 完成 Project→生成→画廊闭环；
- 同一 Wi-Fi 手机通过局域网 URL 打开 MossStudio，完成提示词/生成/看结果；
- WebUI 不能访问训练/终端/设置写操作/任意文件路径；
- 断网、token 失效、主机关闭时页面有明确错误。

> 决策：[ADR-0007](decisions/0007-mossstudio-single-ui-and-web.md)。

## 0.5 P0 · 系统工具链与首次运行

**目标**：用户机器没有 Git/Python，或 PATH 不可用时，启动器仍能检测、
引导打开官方安装器/页面、重新扫描并接管；不修改系统 PATH，不要管理员权限。

范围：

1. `toolchain.ts`：系统 Git/Python 扫描、版本校验、安装入口、重新扫描；
2. Git 接管：`git.ts` 统一走解析后的系统 Git 绝对路径；
3. Python 接管：`pickPython` 使用扫描/显式路径，uv 可选；
4. OOBE 增加“运行环境”行与官方安装引导面板；
5. 设置增加工具链分组；诊断增加缺 Git/Python 预检卡片；
6. Windows 代码路径同步，macOS 先实测。

验收：

- 干净 macOS（无 CLT/Git、无 Python）能按 OOBE 引导打开安装器，装完重新检查；
- PATH 为空或被污染时能通过常见目录/显式路径发现并启动工具；
- 安装器打开失败、权限不足、版本过低时错误可解释，可重新扫描/手动路径；
- 不改系统 PATH、不要求管理员权限；
- 真实 Windows 未验证前标 🟡/⬜。

> 设计依据：[ADR-0006](decisions/0006-system-toolchain.md)、
> [工具链与首次运行准备](toolchain-and-onboarding.md)。

## 1. P0 · SSH 远端训练

**目标**：Mac 上管 Linux/Windows NVIDIA 训练机，训练日志/step/loss 回到共享终端。

**当前进度**：系统 ssh host probe、远端 mirror/worktree/版本、venv/doctor、train/export
代码路径已接，并用 fake ssh 验证；真实 host 验收未完成。

范围：

1. 系统 `ssh` 连接：host/user/port/identityFile/ssh config；
2. host key 校验与错误诊断（首次连接、密钥、权限、超时）；
3. 远端 `trainerRoot` 检查：目录、git、uv、Python、NVIDIA；
4. 远端 mirror/worktree：复用 trainerGit 逻辑，但命令经 ssh 执行；
5. 远端 venv/环境：lock hash、安装、doctor；
6. 远端训练：生成远端脚本、启动/停止、stdout/stderr/step/loss 回传；
7. 远端 host 与本地 Job 的映射；
8. 远端路径不做自动上传，使用用户指定路径。

验收：

- 从 SSH host 列表测试连接成功/失败都有可解释诊断；
- 在远端创建 trainer 版本并完成 `kohakumoss-doctor`；
- 远端启动训练，终端出现 `step N loss=...`；
- 停止/取消可用，JS 进程退出后远端无孤儿进程；
- 本地/远端训练 Job 在终端可区分 host。

## 1.1 P0（Gradio 部分已退役）· 远端 Instance

**当前进度**：设备管理器、Instance placement、远端 mirror/worktree/venv/删除/切版本、
远端 Instance 部署与旧 Gradio SSH 隧道已验证；Gradio 部分随 ADR-0007 退役，
远端生成改走 Clover runner；
远端模型下载、远端 runner、真实 host 未实现/未验收。

范围：

1. Instance placement：`local | { kind: 'ssh', hostId, root }`；远端实例只能选同 host 设备；
2. 远端部署：复用设备管理器的 host，按 commit 建 mirror/worktree，建 venv，
   检查/下载远端模型缓存（不自动上传本机 27 GB）；
3. 远端生成走 Clover runner；不再启动 Gradio/SSH 隧道；
4. 结果回传：不修改上游；远端输出目录观察器 + scp/rsync 拉回本地画廊；
5. 诊断：host key、权限、端口占用、CUDA/磁盘/模型缺失都进入现有诊断；
6. Home 设备选择只显示与实例 placement 兼容的设备。

验收：

- fake ssh 下完成远端 Instance 部署（历史 Gradio 隧道验证保留，不再作为目标）；
- 停止时隧道和远端进程一起结束，无孤儿（fake ssh 已验证 Job=canceled、隧道关闭）；
- 远端结果出现在本地画廊/终端，远端文件不被静默删除（runner 输出同步；真实 host 未验收）；
- 真实 host 验收前保持 🟡，不写成 ✅。

## 2. P0 · 真实 CUDA 训练与训练收尾

**目标**：在 NVIDIA 机器上跑一次真实 LoRA 训练，闭合训练窗口。

范围：

1. 安装 trainer 环境（CUDA torch、kohakumoss、kogine）；
2. 用小数据集跑通 config → cache → train → checkpoint；
3. 验证 step/loss 解析、失败诊断、取消；
4. 导出/采样真实执行（不是命令预览）；
5. loss 曲线/关键指标展示（不要求完整 TensorBoard）；
6. 训练完成后登记输出目录/适配器（与模型库交接）。

验收：

- 真实训练至少跑到 checkpoint；
- 日志、loss、退出状态与真实进程一致；
- 导出产物可被下游读取；
- 失败（OOM/依赖/数据格式）有诊断卡片与原始日志。

## 3. P1 · Clover 常驻后端（代码基座完成）

**当前进度**：utilityProcess HTTP/WS + token + RPC 已接；Creator 已通过 `/api/jobs`
提交 Supervisor；health/WS/simulate Job 验证。真实权重生成未验收。

**目标**：创作窗口不再只是表单，能真正生成并进入 Job/画廊。

范围：

1. 本地常驻 HTTP/WS 服务（进程生命周期、端口、健康检查）；
2. 创作窗口连接服务，提交 prompt/layout/尺寸/seed；
3. Job 进入现有 Supervisor/终端/画廊；
4. 服务日志进终端；
5. 失败与取消走现有诊断。

验收：

- 创作窗口“开始生成”不再提示下一轮；
- 结果进画廊并带元数据；
- 终端可看服务与生成日志；
- 服务异常退出有诊断和重启策略。

## 4. P1 · Project 持久化与图层（基座完成）

**当前进度**：`projects/<id>/project.json` + assets、自动保存、visible/lock/opacity
已接；Project 保存/读取场景通过。完整 UI 回放/资产重链未验收。

**目标**：Project 与 Case 解耦；创作可保存/重开。

范围：

1. Project 文档格式（画布、图层、区域、提示词、资产引用）；
2. 本地持久化与版本兼容；
3. 图层增删/排序/显隐/锁定；
4. Project 与 Case/模型的引用关系；
5. 画廊资产交接。

验收：

- 关闭应用后 Project 可恢复；
- Project 不因 Case 删除而丢失；
- 图层操作可撤销/重做（至少基础）。

## 5. P1 · 启动器加固

范围：

1. 队列落盘完整验收：queued/running 跨重启行为、渲染层自动重排；
2. 设备维护验收：启用/禁用/重命名/显存预算；
3. 强制并发/显存配额（显式高级选项）；
4. MossStudio 真实权重生成验收（27 GB 权重）；
5. 实例更新/回滚 UI；
6. 大文件下载中断/镜像切换压测；
7. Windows 实机验证：按 [Windows 开发与验收手册](windows-validation-guide.md) 记录环境、scenario 和真实硬件证据。

验收：

- 重启后队列不静默丢任务；
- 真实权重启动 MossStudio runner 成功；
- 队列/设备行为有测试或可重复脚本。

## 6. P2 · 更新收尾

已具备：`release.md` 发布源、公告/模型表镜像、版本比较、主动检查（启动、45 min 定时、
窗口聚焦补查）、更新弹窗、标题栏版本胶囊、通知中心未读角标、sha256 下载与打开安装包。

范围：

1. 真实 GitHub Release latest/beta 资产验收（1.0.1 已发布，1.0.2 待发布）；
2. 签名/公证安装包与 Windows NSIS；
3. electron-updater 静默安装/重启；
4. 下载缓存清理/断点续传（可选）。

验收：

- `release.md` 版本变化触发弹窗，同版本“稍后”不再自动弹；
- sha256 不匹配的安装包被拒绝；
- 签名安装包可安装并重启到新版本；
- stable/beta 不混淆，beta 不污染 latest。

> Clover Creator 不做浏览器 WebUI / served UI（ADR-0004）；如果未来要做纯队列/日志
> 监控页，另立 ADR，不把 Creator 的 Electron 架构改成双通道。

## 7. P2 · 打包与 Beta

- macOS 签名、公证、dmg/zip；
- Windows NSIS、长路径、Defender 说明；
- 崩溃恢复、日志轮转、诊断包脱敏；
- 干净机器首次安装到出图验收；
- 设备矩阵：M1/M3/M4、16/32/64 GB。

## 8. V2 · 自研推理引擎（未排期）

复用 [future-inference-engine.md](future-inference-engine.md)：MNN 为主、
MPS 仅 oracle、MLX 条件触发。通过 `RuntimeAdapter` 接入，UI/协议不变。
在启动器积累真实设备日志、用户明确抱怨性能之前不启动。

## 9. 依赖关系

```
SSH 远端执行 ──> 远端真实 CUDA 验收 ──> 导出/采样执行
Clover 常驻后端 ──> Project/图层
release.md/下载校验 ──> 签名安装/electron-updater
队列落盘/设备维护 ──> 打包/设备矩阵
MossStudio 真机 + 27 GB 验收 ──> Beta
```

## 10. 明确不做

- V1 自研推理引擎；
- 训练内核/vendor KohakuMossTrainer；
- img2img/edit（官方未发布）；
- 移动端原生；
- 账号/云同步/模型市场后端；
- 遥测。

## 11. 与旧里程碑的关系

M0–M6 是早期按“推理启动器”排的里程碑，其中 M1–M4 已基本完成；
UI v0.2–v0.4 与 Trainer v0.4 是后续插入的交付批次。旧 M0–M6 不再作为
当前排期表，只保留为历史映射；当前顺序以本文 P0/P1/P2 为准。
