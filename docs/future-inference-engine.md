# （未来）自研推理引擎架构

> 注：本文 §2 的桌面壳与 §4 的启动器设计写于“引擎优先”阶段，已被
> [architecture.md](architecture.md)（Electron 启动器）取代；仅保留引擎侧的设计输入。

> **已延期**。V1 不做自有推理后端，见 [ADR-0003](decisions/0003-launcher-first.md)。
> 本文保留为 V2 引擎的设计输入；其中的 block 调度、量化、分阶段加载结论仍然有效。
> 当前产品架构见 [architecture.md](architecture.md)。

> 状态：M0 草案。目标是把"模型能不能跑"与"启动器好不好用"解耦，任何一层都可以单独替换。

## 1. 目标与非目标

**目标**

- 同一套 C++ 引擎在 macOS / iOS / Android / Windows / Linux 上跑 MOSS-Image；
- 16 GB 统一内存设备可交互（分阶段加载 + int4/int8 + 逐 block 流式）；
- 启动器与 WebUI 共用一套前端，桌面端是薄壳；
- 数值可验证：每个组件都有对 PyTorch 参考实现的 parity 测试；
- 训练器作为**外部可选后端**接入，不污染引擎与主仓库。

**非目标（至少 M1–M4）**

- 不做训练内核；不复刻 KohakuMoss 的 LyCORIS/fp8/offload 体系；
- 不在引擎里内嵌 Python；
- 不做云端推理服务（但 headless 模式可被远程调用）；
- 不做 img2img / edit（上游暂未发布，接口预留 400）。

## 2. 分层

```
┌─────────────────────────────────────────────────────────────────────┐
│ apps/desktop (Tauri 2, Rust)   apps/web (React, 同一份前端)          │
│   job queue · gallery · model manager · presets · trainer console    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTP + SSE（本地 127.0.0.1，随机端口）
┌───────────────────────────────▼─────────────────────────────────────┐
│ engine/src/api        请求校验、任务生命周期、进度事件、取消           │
│ engine/src/pipeline   组件编排：TE → DiT×steps → VAE，显存 staging     │
│ engine/src/model      manifest、safetensors mmap、权重布局、量化计划    │
│ engine/src/dit        42-block 调度、CFG、skip、DMD、LoRA             │
│ engine/src/text       Qwen3.5 tokenizer + 编码器封装（MNN-LLM）        │
│ engine/src/vae        分块解码、BN 反归一化、2×2 unpatch              │
│ engine/src/backend    Backend 接口：mnn / ref(CPU) / future: mlx      │
└─────────────────────────────────────────────────────────────────────┘
```

**关键边界**

- `pipeline` 只认识"组件"和"张量契约"，不认识 MNN；
- `backend` 只认识"图/算子"，不认识 MOSS 的模块名；
- 启动器只认识 HTTP 契约，不认识模型结构。

这样 M1 可以先做 `ref` 后端（纯 CPU、慢但正确）跑通端到端，再接 MNN；
也可以在 M3 后插入 MLX 后端而不改上层。

## 3. 引擎设计

### 3.1 模型包（model bundle）

一个模型目录 = 上游 diffusers 布局 + 我们生成的 `clover.json` 清单：

```
models/moss-image-sft-int8/
  transformer/           # 或按 block 拆分的 *.mnn
  text_encoder/          # MNN-LLM 导出目录（llm.mnn, tokenizer.mtok, ...）
  vae/
  scheduler/
  tokenizer/
  clover.json            # 组件哈希、量化档位、block 布局、推荐 profile
```

`clover.json` 由 `tools/convert` 生成，启动器只信清单里的哈希：
下载后先校验再标记可用，损坏则重新下载（见 `docs/archive/contracts/model-manifest.schema.json`）。

### 3.2 逐 block 执行，而不是一张 5B 大图

DiT 是 42 个同构 block。我们**按 block 导出 MNN 图**，由 host 循环调度：

```
x = embed(vae_latent, text_embeds, t)
for i in 0..41:
    if skip(i): continue            # CFG 负分支跳过 block 22
    x = block[i](x, rope, mod, lora[i])
x = head(x)
```

好处：

- **低内存**：同一时刻只常驻 1 个 block 的权重（fp16 226 MB / int8 113 MB）；
- **可流式**：8 GB 设备把 block 权重放磁盘 mmap，按需换入；
- **LoRA 天然**：adapter 按 block 绑定，不需要合并进 5B 权重；
- **可裁剪**：CFG skip、DMD 的 prefix、未来 layer pruning 都是 host 逻辑；
- **转换友好**：单 block ONNX 只有 ~113 M 参数，16 GB 开发机也能导出。

代价：每个 block 一次图调度。按 42 次/前向、每次 <0.1 ms 估算，开销可忽略；
真正要盯的是 attention 与 GEMM 的融合，而不是 dispatch。

> 备选：整图导出（转换机器 ≥ 48 GB 内存）。保留为 `profile=monolithic`，
> 用于对比吞吐；默认走 block 模式。

### 3.3 张量契约（block 输入输出）

| 名称 | 形状 | dtype | 说明 |
| --- | --- | --- | --- |
| `x` | `[1, T, 3072]` | fp16/bf16 | T = image tokens + text tokens |
| `rope` | `[1, T, 128]` | fp16 | 4 轴 (r,f,h,w) 预计算，host 生成 |
| `mod` | `[1, 6, 3072]` | fp32 | AdaLN 调制，host 用 fp32 小 MLP 算 |
| `lora` | 每 block 一组 `A/B` | fp16 | 可选，host 侧 apply 或引擎融合 |

调制与时间步在 **host 侧用 fp32** 计算（上游对数值敏感，见
[model-notes](model-notes.md#数值约定)），再喂给 block——这样每步只算一次，
且 block 图可以完全静态。

### 3.4 文本编码器

Qwen3.5-9B（32 层，24 层线性注意力 + 8 层 full attention，head_dim 256，
24 个 KV 头 4 组）。两条路线：

- **A（首选）**：复用 MNN-LLM 的 Qwen3.5 图与 Metal/Vulkan kernel，只取
  `last_hidden_state`（不采样、不算 lm_head）。需要给 MNN 加一个"prefill 后取隐状态"的
  入口（小改动，向上游提 PR）。
- **B（兜底）**：单独导出 encoder-only 图（无 KV cache），文本长度按
  256/512/1024 分桶。好处是完全可控，坏处是放弃 MNN-LLM 的量化与调度。

文本长度**分桶**而不是动态 shape：MNN 的 Metal 图在固定 shape 下才能稳定拿到
`transformerFuse` 的收益；桶外长度向上取整 + mask。

### 3.5 VAE

FLUX.2 VAE，decode 前要做两步上游特有处理：

1. BN 反归一化：`z = z * sqrt(running_var + eps) + running_mean`；
2. 2×2 unpatch：`[B,128,H,W] → [B,32,2H,2W]`（`reshape/permute`）。

1024² 解码必须**分块**：参考实现（mlx-serve）在未分块时中间激活达 25.5 GiB。
策略：按 latent 行带切 tile（重叠 8–16 px 防接缝），逐块解码后拼接；
峰值与 tile 数线性相关，与整图无关。

### 3.6 量化

| 组件 | 默认 | 低内存 | 说明 |
| --- | --- | --- | --- |
| DiT linear | int8 per-channel | int4 group=64 | block 级，可逐 block 混精 |
| 文本编码器 | int4 group=64 | int4 | MNN-LLM 原生 HQQ/AWQ 导出 |
| VAE | int8 | int8 | 卷积对量化敏感，先 int8 |
| time/modulation | **fp32** | fp32 | 上游明确要求，不量化 |

权重量化不减少 FLOPs，只减少带宽与常驻；在 Apple GPU 上收益主要来自
"少读 2–4 倍权重"，对 5B 模型是 2–4× 的带宽节省，但算力仍是上限。
因此**量化解决"能不能装下"，few-step 解决"要等多久"**。

### 3.7 采样器

- `base`：Euler + shift-5 sigma 网格（1000 步训练网格吸附），CFG 3，
  负分支跳过 block 22；50 步为官方推荐。
- `dmd8`：data-space DMD，8 次前向、无 CFG、latent mix `Q`、专用
  `time_embedding`（fp32）。**不是普通 LoRA**，必须实现独立采样循环。
- `custom`：用户给 sigmas / steps / cfg，用于社区蒸馏适配器。

采样循环在 host 侧，block 图与步数解耦；`x0`/`v` 的 fp32 累加在 host 做，
避免 fp16 累积误差（上游同样用 fp32 合并 CFG）。

### 3.8 适配器

- 格式：kohya/ComfyUI key（`diffusion_model.layers.N.proj.q.lora_down.weight` 等）、
  LyCORIS（LoHa/LoKr/DoRA/OFT）在 M2 先支持 LoRA，LyCORIS 在 M3。
- 应用点：block 图内的 linear 旁路，`y = Wx + scale * up(down(x))`；
  若后端支持，编译期把 LoRA 融进 block 图（每换一次 strength 重编译一次）。
- 8 步 DMD 的 `time_embedding.safetensors` 是**替换**而非旁路，走独立 profile。

### 3.9 失败与降级

- 显存不足：自动降档（int8→int4、1024→768、block 流式），并把决策写进任务事件；
- 后端不支持某算子：回落到 `ref` CPU（慢但正确），任务标记 `degraded`；
- 取消：host 在每个 block 边界检查取消标志，保证 100 ms 内响应。

## 4. 启动器设计

**桌面壳**：Tauri 2（Rust）。理由：二进制小、能直接链接 C++ 静态库/动态库、
进程与文件权限模型清晰、三平台一致；Electron 体积与内存不合适，Qt 前端复用差。

**前端**：React + TypeScript，`apps/web` 与桌面共用；桌面端通过 `tauri://` 加载同一 bundle。

**本地服务**：引擎内置 `http` 模式（或由 Rust 壳代理），只监听 `127.0.0.1` 随机端口，
带一次性 token，防止本机其它进程调用。WebUI 远程模式显式开启并绑定局域网地址。

**核心页面**

1. 模型库：下载/校验/量化档位/磁盘占用；首次运行向导按内存推荐 profile；
2. 生成：prompt、负面词、分辨率、步数档（50/20/8）、CFG、seed、批量、布局 JSON 编辑器；
3. 队列：并发 1（GPU 独占），可暂停/取消/重排；进度含 stage 与 step；
4. 画廊：PNG + 内嵌元数据（prompt/seed/model/adapter），可复现；
5. 适配器：LoRA 列表、strength、触发词；
6. 训练（可选）：检测外部环境、编辑配置、启动、看 loss/样例。

**不做**：云端账号、模型市场后端、遥测（默认关闭）。

## 5. 训练器桥接

```
launcher ──spawn──> python -m clovermoss_trainer_bridge --job job.json
        <──NDJSON── {"event":"step","step":120,"loss":0.031,...}
```

- 启动器只依赖**进程契约**：`job.json` 进，NDJSON 事件出，退出码表状态；
- 训练环境由用户自备（venv/conda），启动器负责发现、体检、传参；
- 不在本仓库放训练器源码，不分发其权重/内核（见 ADR-0002）；
- 如果未来要深度集成，单独开 `clovermoss-trainer-kohaku` 仓库，独立许可。

## 6. 磁盘布局

```
~/Library/Application Support/MossStudio/     # macOS
  models/<bundle-id>/...
  adapters/
  outputs/
  logs/
  settings.json
```

模型可放外置盘：设置里改 `models_root`，用绝对路径 + 哈希校验，不复制。

## 7. 性能策略（按收益排序）

1. **few-step**（8 步 DMD）：10× 以上，先做；
2. **分辨率档位**：512² 是 1024² 的 1/4 计算；
3. **CFG 优化**：负分支 block skip 已内置；进一步可做 CFG 缓存/蒸馏；
4. **int8 权重 + 融合 attention**：1.5–2× 带宽收益；
5. **block 流式**：让 8 GB 设备可跑，不直接提速；
6. **批处理**：队列内同参数合并，但对 16 GB 设备意义有限；
7. **预览**：每 N 步出低分辨率 latent 预览（VAE 轻量解码），提升交互感。

## 8. 可观测性

- 每个任务落 `logs/<job>.jsonl`：stage、step、耗时、峰值内存、降档记录；
- `--bench` 模式：固定 prompt/seed，输出 tokens/s、TFLOPS、峰值 RSS；
- 数值 parity：`tests/parity` 保存 PyTorch 参考的张量夹具（小 shape），CI 里逐层比对。

## 9. 安全与合规

- 模型下载只允许 HTTPS + 允许列表域名（huggingface.co / modelscope.cn）；
- 权重文件先写临时文件、校验哈希、再原子 rename；
- 不执行模型包里的任意 Python（只读 safetensors/MNN）；
- 上游许可证与 NOTICE 随安装包分发；训练器不打包。
