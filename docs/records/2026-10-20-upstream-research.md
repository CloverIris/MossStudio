# 上游复查 · 2026-10-20

- 目的：为 MossStudio 单一 UI + 局域网 WebUI 改造确认上游兼容性
- 仓库：`OpenMOSS/MOSS-Image`、`KohakuBlueleaf/KohakuMossTrainer`
- 本地参考：`.upstream/MOSS-Image`、`.upstream/KohakuMossTrainer`（不提交）

## 1. MOSS-Image

| 项 | 值 |
| --- | --- |
| 当前推荐 commit | `c1355e6` |
| 最新 main | `95559c9`（2026-10-19） |
| 最新 tag | 无 |
| 差异 | README/README_ZH、资源链接、技术报告、展示图、layout 标题框素材 |
| 推理代码 | `gradio_app.py`、`inference_runtime.py`、`pyproject.toml` **无变化** |
| 模型接口 | 无变化 |
| 结论 | 可把 `recommended_commit` 前移到 `95559c93`；不需要适配代码 |

最新 main 的重要变化只有文档/展示：

- 增加 arXiv 技术报告与引用；
- 更新 Discord/ModelScope/飞书链接；
- `fix: fit layout title boxes to text bounds` 只改展示素材，不改 layout JSON schema；
- 新增 `skills/moss-image-prompt-enhancer` 文档/脚本，和我们的 Studio layout 编译无直接依赖。

## 2. KohakuMossTrainer

| 项 | 值 |
| --- | --- |
| 最新稳定 tag | `v0.1.0` / `5bb1a81`（2026-10-18） |
| main | `5223637`（领先 tag 大量增量 commit） |
| 我们当前调用 | `kohakumoss-doctor`、`kohakumoss-config new train|sample`、`kogine run`、`--set` |
| 兼容性 | 调用参数仍存在；输出目录布局未变；新增能力是增量的 |
| 结论 | 不需要重写训练链路；UI 可逐步暴露新能力 |

`v0.1.0` 之后的 main 增量（与我们的 UI 相关）：

- `--weights` 现在同时接受 **ComfyUI models 目录**（`diffusion_models/`、`text_encoders/`、`vae/`）和 HF 目录（`transformer/`、`text_encoder/`、`vae/`）；
- 新增 fp16 修复/量化、ComfyUI 格式导出、预量化 text encoder；
- 新增 VRAM/精度/多卡参数（`--vram`、`--precision`、`--gpus` 等）；
- 训练输出仍是 `runs/moss/<RUN_NAME>/`，checkpoint 仍是 `checkpoints/step_XXXXXXXX/trainable.safetensors`，导出仍是 `export/`；
- `kohakumoss-config new train` 的 `--algo`、`--steps`、`--source`、`--name` 仍在。

## 3. 对我们的影响

1. **MossStudio 仍走 Clover runner/backend**：上游 Gradio 不再作为产品入口，但上游 `inference_runtime.py` 的 pipeline 加载、offload、layout 语义仍是我们 runner 的参考。
2. **训练器不需要 vendor**：继续按 commit/worktree 外部接入；默认稳定 tag 可作为 UI 的 stable 标记，main 仍可选。
3. **训练 UI 需要补的增量**：ComfyUI 权重目录提示、`--vram`/`--precision` 可选字段、ComfyUI 导出格式说明；这些是 P1，不阻塞 MossStudio 改造。
4. **MOSS 推荐 commit**：更新 `release/manifest.json` 的 `recommended_commit` 为 `95559c93`。

## 4. 来源

- https://github.com/OpenMOSS/MOSS-Image
- https://github.com/KohakuBlueleaf/KohakuMossTrainer
- https://github.com/KohakuBlueleaf/KohakuMossTrainer/releases/tag/v0.1.0
