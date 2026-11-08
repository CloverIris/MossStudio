---
status: accepted
date: 2026-10-19
---

# ADR-0002：KohakuMossTrainer 不作为 git submodule，而是外部训练后端

- 结论：**不嵌入、不 vendor、不作为 submodule**；以"外部进程 + 契约"方式可选接入。

## 0. 修订：运行时部署 + 独立训练窗口（2026-10-19）

产品决定增加“训练”主线。修订后的边界：

- **仍然不 vendor、不作为 submodule、安装包不包含上游代码**；
- 允许启动器在用户配置的 `trainerRoot` 里 **runtime clone** 上游仓库，建 bare mirror + per-commit worktree；
- 训练器以 **独立的 Kohaku Trainer（External）窗口** 出现，主产品仍叫 MossStudio；
- 环境按 lock hash 管理，但只安装到 trainerRoot 下；推理与训练环境隔离；
- 本机 CUDA 训练通过 `startTrainingJob` 进入共享终端，解析 step/loss；
- SSH 训练主机代码路径已接入，真实 host 验收在下一阶段；同一 host 模型。

这不改变“训练内核不进入主仓库”的核心结论；它只是把“用户手动 clone”变成“启动器代为 clone + 管理版本/环境”。

## 1. 背景

[KohakuBlueleaf/KohakuMossTrainer](https://github.com/KohakuBlueleaf/KohakuMossTrainer)
是目前最完整的 MOSS-Image 训练框架：

- LyCORIS 全系列（LoRA/LoCon/LoHa/LoKr/DoRA/OFT/BOFT/GLoRA/IA3/DyLoRA/T-LoRA）；
- fp8/MXFP8/int8、TileLang（sm70/75）与 Triton（sm80+/Arc）内核；
- 6–24 GB 显存档位、block swap、DDP/FSDP/pipeline；
- 自带 MOSS 实现、ComfyUI 格式导出、采样脚本。

问题：它值不值得作为 git submodule 嵌入，成为我们的训练器后端？

## 2. 事实核查

| 维度 | 事实 | 来源 |
| --- | --- | --- |
| 许可 | **KohakuMoss License 1.0 = Apache-2.0 + 第 10 条命名要求** | `LICENSE` |
| 命名要求 | 任何"incorporates / built upon / substantially derived"的产品、包、服务，**必须在产品名、包名或主品牌中包含 "Kohaku"** | `LICENSE` §10 |
| 平台 | Windows / Linux；CUDA 12.6+ 或 Intel Arc；**无 macOS/MPS** | README、`docs/guides/install.md` |
| 依赖 | `torch>=2.13,<2.15` 硬钉；TileLang/Triton；KohakuEngine；LyCORIS | `pyproject.toml` |
| 形态 | 完整应用/框架：`configs/`、`scripts/`、kogine 脚本、CLI，**不是稳定库 API** | 仓库结构 |
| 成熟度 | v0.1.0，2026-10 发布，48 stars，日更 | GitHub API |
| 分发 | 已有 PyPI 包 `kohakumoss` | `pyproject.toml` |

## 3. 选项

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A. git submodule | 版本锁定、改代码方便 | 许可传染、torch/CUDA 依赖进主仓库、日更合并税 | ❌ |
| B. pip 依赖 | 升级简单 | 仍需 Python 运行时；许可仍适用；与"无 torch 引擎"冲突 | ❌（仅桥接器可选） |
| C. 外部进程 + 契约 | 隔离依赖/故障/许可；GPU 独占清晰；用户自选版本 | 需要定义协议、做环境发现 | ✅ |
| D. 自研训练器 | 完全可控 | 工作量巨大，重复造轮子 | ❌（M6 前不做） |

## 4. 决策：C

### 4.1 为什么 submodule 是错的

1. **许可**：第 10 条不是"署名"而是"改名"——只要我们的产品"incorporates"它，
   就必须在**产品名/包名/主品牌**里出现 "Kohaku"。本仓库是 MIT、品牌是
   MossStudio，submodule 会把这条义务带进整个发布物，且未来作者可改许可。
   即使只作为可选功能，也需要法务确认"incorporate"的边界。
2. **平台**：它没有 macOS 后端。作为 submodule，每个 macOS 开发者 clone 后都会
   拉到几 GB 的 CUDA 训练代码与配置，却一行都跑不了。
3. **依赖**：`torch>=2.13,<2.15` 是硬钉，和"引擎不依赖 torch"的核心卖点直接冲突；
   CI、打包、公证都会被 torch wheel 拖累。
4. **稳定性**：v0.1.0、日更、kogine 配置即 API。submodule 固定 commit 后，
   我们既要跟上游修 bug，又要维护自己的 patch，合并成本高于收益。
5. **形态**：它是应用而非库。应用的正确集成边界是**进程**，不是源码树。

### 4.2 桥接怎么做（修订）

训练器现在由启动器的 Trainer 服务管理：

```
训练页 → trainerRoot/git/kohaku-trainer.git（bare mirror）
       → versions/<commit>（worktree）
       → runtimes/<lockHash>（独立 venv）
训练窗口 → form / config preview / doctor / run
共享终端 → inference + training 两种 Case
```

- 仍然通过 **外部 Python 进程** 运行上游 `kogine`，不 import 上游代码；
- SSH host 的执行仍通过系统 `ssh`，远端维护自己的 mirror/worktree/venv；
- 许可：窗口明确标为 `Kohaku Trainer · External`，展示 KohakuMoss License 1.0 链接。

### 4.2.1 原桥接设计（未实现，已被 4.2 取代）

```
launcher ── 发现/体检 ──> 用户自备环境（uv/conda/venv）
        ── job.json ───> clovermoss_trainer_bridge（我们维护的薄适配器）
        <── NDJSON ───── {"event":"step","step":120,"loss":0.031,"lr":...}
```

- **发现**：依次检查 `~/.clovermoss/trainer.json`、`KOHAKUMOSS_PYTHON`、
  `uv tool`、`which kohakumoss-doctor`；找到后执行 `kohakumoss-doctor` 体检；
- **启动**：用用户指定的解释器 `python -m clovermoss_bridge --job job.json`，
  `cwd` 指向用户 run 目录，stdout 只走 NDJSON，日志走 stderr；
- **GPU 独占**：训练期间引擎拒绝新生成任务（同一队列互斥）；
- **产物**：监听 `runs/moss/<RUN>/export/*.safetensors`，完成后登记到适配器库；
- **取消**：SIGINT + 宽限 10 s + SIGKILL；断点由上游 checkpoint 负责。

桥接器本身（`trainer-bridge/`，MIT）只做参数映射与事件解析，**不含**上游代码。

### 4.3 品牌与分发

- UI 里该功能标注为 **"Kohaku Trainer · External"**，并链接上游仓库与许可；
- 安装包**不捆绑** kohakumoss 源码或 Python 依赖；
- 首次使用由启动器在用户配置的 `trainerRoot` 里 clone 上游源码并创建独立环境，
  这是**运行时部署**，不是随安装包分发；
- 若未来要随包分发或做独立安装器，需重新评估 KohakuMoss License 1.0 第 10 条，
  必要时把该功能独立命名（含 "Kohaku"）。

## 5. 我们仍然复用什么

- **知识**：模型结构、checkpoint 键位、SiTU/调制/CFG 数值约定、采样器细节
  （已在 `docs/reference/model-notes.md` 中引用）；
- **格式兼容**：ComfyUI 适配器键位、KohakuMoss 单文件权重可直接被引擎读取；
- **对照**：用它的推理输出作为引擎 parity 的第二个参考（第一个是官方 diffusers）。

**不复用其代码**（许可不同），只做行为兼容。

## 6. 重新评估的触发条件

1. 许可改为纯 Apache-2.0 / MIT，或作者给出书面例外；
2. 增加 macOS（MPS/MLX）后端，或拆出稳定的库 API；
3. 我们决定发布"训练版"独立产品，并接受命名条款；
4. 上游出现破坏性变更，桥接成本高于 fork。

满足任一条件时重开本 ADR，而不是现在预先耦合。
