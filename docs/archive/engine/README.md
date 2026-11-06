# engine/（已延期）

**V1 不自研推理引擎。** 启动器通过外部 Python 运行时（官方 Gradio 或薄 runner）工作，
见 [ADR-0003](../../decisions/0003-launcher-first.md)。

本目录保留给 V2：

- 设计输入：[future-inference-engine.md](../../future-inference-engine.md)
- 运行时选型：[ADR-0001](../../decisions/0001-macos-runtime.md)
- 模型事实与预算：[model-notes.md](../../model-notes.md)、[tools/dev/budget.py](../../../tools/dev/budget.py)

## V2 的接入方式

启动器不直接依赖引擎实现，而是通过 `RuntimeAdapter` 接口：

```ts
interface RuntimeAdapter {
  id: 'runner' | 'gradio' | 'clover-engine'
  prepare(instance): Promise<PreparedLaunch>
  readiness: { event: string; timeoutMs: number } | { regex: RegExp }
  capabilities: { progress: 'ndjson' | 'tqdm' | 'none'; preview: boolean; stdin: boolean }
}
```

未来引擎只需提供与 runner 相同的 NDJSON 事件，即可零改动接入 UI、队列、诊断与画廊。

## V2 的技术结论（已调研，待验证）

- 首选 MNN（Metal/Vulkan/OpenCL），覆盖 macOS/iOS/Android/Windows/Linux；
- 文本编码器复用 MNN-LLM 的 Qwen3.5 实现；
- DiT 按 block 导出/调度，支持 8–16 GB 设备流式加载；
- MPS 仅作数值 oracle；MLX 为条件触发的 Apple 快路径；
- 验收：M3 上 block 有效算力 ≥ 1.5 TFLOP/s，512²/50 步 ≤ 12 min。

未验证前不写代码，避免把产品绑在未证明的吞吐上。
