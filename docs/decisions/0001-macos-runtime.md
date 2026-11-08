---
status: superseded
date: 2026-10-19
superseded-by: ADR-0009
---

# ADR-0001：macOS 首个运行时选 MNN，而不是 MPS

- 决策者：项目发起人 + 引擎负责人

## 1. 背景

产品要求"脱离 PyTorch 的高性能推理引擎"，且仓库定位是"移动设备 & 桌面设备"。
首个平台是 macOS（Apple Silicon）。候选运行时：

| 候选 | 跨平台 | 脱离 torch | 移动端 | Apple GPU 性能 | 工程量 |
| --- | --- | --- | --- | --- | --- |
| PyTorch MPS | 仅 Apple | ❌ | ❌ | 中 | **最低** |
| **MNN** | ✅ 全平台 | ✅ | ✅ | 中高（Metal） | 中高 |
| MLX | 仅 Apple | ✅ | ❌ | **最高** | 中 |
| CoreML | 仅 Apple | ✅ | iOS | 低（5B 不适合 ANE） | 高 |
| ONNX Runtime | ✅ | ✅ | 弱 | 低（CoreML EP） | 中 |
| ggml/llama.cpp | ✅ | ✅ | 弱 | 中 | 高（DiT 支持少） |

## 2. 关键证据

### 2.1 MNN 已经具备我们需要的基础设施

- **Qwen3.5 支持**：MNN README 2026-03-05 宣布支持 Qwen3.5 系列；代码里有
  `MetalLinearAttention.mm`、`linear_attn_gated_delta_rule_{prefill,decode}.comp`
  （Vulkan/OpenCL），正好覆盖 MOSS 文本编码器的 24 层线性注意力。
- **DiT 运行时**：`transformers/diffusion` 已包含 SD3.5、Sana、Wan 的 DiT 实现，
  说明"文本编码器 + DiT + VAE"的编排、`transformerFuse`、Metal/OpenCL 后端是现成的。
- **移动端落地**：MNN Chat（iOS/Android）已内置扩散模型，证明部署链路完整。
- **量化与低内存**：MNN-LLM 的 HQQ/AWQ、weight-only int4、mmap 权重、低内存模式，
  与"16 GB Mac / 8 GB 手机"的目标直接对应。

### 2.2 MPS 路线的硬伤

- **不是"脱离 torch"**：MPS 就是 PyTorch 的一个后端，Python 进程 + 27 GB 依赖，
  与产品定位冲突；
- **能力缺口**：MPS 没有 int4/int8 权重算子、没有权重流式、没有 flash attention 的
  完整覆盖；5B DiT 在 16 GB 机器上仍然要自己做 staging，而 PyTorch 的 allocator
  不给这个控制力；
- **打包**：Python 运行时 + torch wheel ≈ 2–3 GB，启动器体积和签名/公证都变复杂；
- **性能不是优势**：Apple GPU 上 MLX 通常快于 MPS，MNN 的融合算子也不差，
  MPS 的唯一优势是"能直接跑参考实现"。

**结论**：MPS 只保留两个用途——**数值 oracle**（跑上游代码生成测试夹具）和
**开发期兜底**（MNN 后端未就绪时验证 UI/流程）。不作为发布运行时。

### 2.3 为什么不是 MLX（至少现在不是）

MLX 在 Apple Silicon 上确实最快，而且已有两个可参考的 MOSS 实现：

- `xocialize/moss-image-swift`（MIT，Swift/MLX）；
- `ddalcu/mlx-serve` PR #908（MIT，Zig/MLX）：M4 Max 128 GB，1024²/50 步/CFG3，
  bf16 **358 s**、8-bit **403 s**，峰值 32.9 / 21.0 GB。

但 MLX **只有 Apple 平台**，没有 iOS/Android 部署路径，也没有 Windows/Linux。
把它作为主引擎，等于放弃"跨平台"；作为第二后端，则要维护两套 5B 图实现。
现阶段团队规模不支持。

**保留为可选快路径**，触发条件（任一）：

1. MNN 在 M3 上 512²/50 步 > 12 min（即有效算力 < 1.5 TFLOP/s）；
2. MNN 的 DiT 吞吐低于同机 MLX 的 60%；
3. 需要 1024² 交互而 MNN 内存/性能不达标。

届时通过 `Backend` 接口插入，不改启动器与协议。

## 3. 决策

1. **产品运行时 = MNN**，后端抽象为 `Backend` 接口；M1 先实现 `ref`（CPU 正确性）
   与 `mnn`（Metal）两个后端。
2. **MPS = oracle**：只在 `tools/oracle` 与 CI 里出现，不进入发布产物。
3. **MLX = 预留**：接口与权重转换格式不绑定 MNN，留出插入点。
4. 首个性能验收以 **M3 10c / 16 GB** 为基线（见 roadmap M1）。

## 4. 后果

**正面**

- 一套 C++ 引擎覆盖 macOS/iOS/Android/Windows/Linux；
- 复用 MNN 的 Qwen3.5、量化、Metal/Vulkan kernel 与移动端部署经验；
- 发布产物无 Python、无 torch，安装包可控制在几十 MB + 权重。

**负面 / 风险**

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| MNN Metal 上 5B DiT 吞吐未知 | 可能达不到 512²/50 步 10 min | M0 做 block 级微基准；不达标则启用 MLX 快路径 |
| MOSS DiT 是自定义结构 | 需要自己写 block 图与调度 | 结构简单（Linear/RMSNorm/SiTU/RoPE/SDPA），42 层同构 |
| Qwen3.5 隐状态导出 | MNN-LLM 面向生成，不直接给 hidden states | 给 MNN 提 PR 增加 encoder 模式；或单独导出 encoder-only 图 |
| MNN 的 Metal attention 不一定是 flash | 1024² 性能/内存 | block 图内用分解 attention，或写自定义 Metal kernel |
| 上游 MNN 迭代快 | API/行为漂移 | submodule 固定 tag，月度升级 |

## 5. 验证计划（M0，3–5 天）

1. 编译 MNN（Metal，`MNN_BUILD_DIFFUSION=ON`），在 M3 上跑官方 Sana demo，
   记录 512²/1024² 的 step 时间与峰值内存；
2. 导出**单个 DiT block**（113 M 参数）为 ONNX → MNN，跑 1280/4352 token 两档，
   测有效 TFLOP/s；
3. 用同一 block 跑 PyTorch MPS 对照；
4. 判定：block 有效算力 ≥ 1.5 TFLOP/s 且峰值内存可控 → 维持 MNN 决策；
   否则回到本 ADR，启用 MLX 快路径。

> 验收数字写进 `docs/archive/v2-mnn-spike.md`，不达标就改决策，不硬撑。
