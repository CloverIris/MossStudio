# V2 · MNN 可行性微基准（模板）

> **已延期到 V2**：V1 不做自有推理引擎（[ADR-0003](../decisions/0003-launcher-first.md)）。
> 本文保留为引擎阶段的验证模板。

> 目标：用最小代价回答"MNN 在 M3 上跑 5B DiT 到底多快"。
> 填完这张表再决定是否维持 ADR-0001。

## 环境

| 项 | 值 |
| --- | --- |
| 机器 | Apple M3，10 核 GPU，16 GB |
| macOS | 15.7.7 |
| MNN | 3.6.1（或实际 tag） |
| 编译选项 | `-DMNN_METAL=ON -DMNN_BUILD_DIFFUSION=ON -DMNN_SUPPORT_TRANSFORMER_FUSE=ON` |
| 构建工具 | cmake 4.1.1 / ninja / Apple clang 17 |

## 用例

### A. 官方 Sana demo（ sanity）

| 分辨率 | 步数 | 单步 ms | 峰值内存 | 备注 |
| --- | --- | ---: | ---: | --- |
| 512² | 20 | | | |
| 1024² | 20 | | | |

### B. 单个 MOSS DiT block（核心）

配置：dim 3072、FFN 8192、24 头、head_dim 128、qk-norm、4 轴 RoPE、SiTU。

| 序列长度 | 权重精度 | 单次 ms | 有效 TFLOP/s | 峰值内存 |
| --- | --- | ---: | ---: | ---: |
| 1280（512²） | bf16 | | | |
| 1280（512²） | int8 | | | |
| 4352（1024²） | bf16 | | | |
| 4352（1024²） | int8 | | | |

有效 TFLOP/s 计算：

```
FLOPs(block) ≈ 2 * 113e6 * T + 4 * T^2 * 3072
TFLOP/s = FLOPs / time
```

（113 M = 单 block 参数：q/k/v/o 4×3072² + ffn_up_gate 2×3072×8192 + ffn_down 8192×3072）

### C. 同 block PyTorch MPS 对照

| 序列长度 | dtype | 单次 ms | 有效 TFLOP/s |
| --- | --- | ---: | ---: |
| 1280 | bf16 | | |
| 4352 | bf16 | | |

### D. 整模型外推

- 42 block × 单 block 时间 + attention/调度开销；
- 与 `tools/dev/budget.py` 的预算对比；
- 给出 512²/50 步、512²/8 步、1024²/8 步的预计时间。

## 判定

| 指标 | 阈值 | 实测 | 结论 |
| --- | --- | --- | --- |
| block 有效算力（512²） | ≥ 1.5 TFLOP/s | | |
| block 有效算力（1024²） | ≥ 1.2 TFLOP/s | | |
| 512²/50 步外推 | ≤ 12 min | | |
| 峰值内存（1024²） | ≤ 14 GB | | |

**结论**：维持 MNN / 启用 MLX 快路径（二选一，写明理由）。

## 复现步骤

```bash
# 1. 编译 MNN（Metal + diffusion）
git clone --depth 1 --branch 3.6.1 https://github.com/alibaba/MNN.git third_party/mnn
cmake -S third_party/mnn -B build/mnn -G Ninja \
  -DMNN_METAL=ON -DMNN_BUILD_DIFFUSION=ON -DMNN_SUPPORT_TRANSFORMER_FUSE=ON \
  -DMNN_BUILD_CONVERTER=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build/mnn -j

# 2. 导出单 block（tools/convert 待实现）
# 3. 跑 bench
```
