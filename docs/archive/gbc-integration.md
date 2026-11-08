# KohakuGBC 集成

- 上游：[KohakuBlueleaf/KohakuGBC](https://github.com/KohakuBlueleaf/KohakuGBC)
- 引擎：[KohakuBlueleaf/Togeari](https://github.com/KohakuBlueleaf/Togeari)
- 许可：Apache-2.0
- 状态：桥接与导入面板已接，真实 GPU/API 跑图未验收

## 1. 它提供什么

GBC 把一张图解析成一个 DAG：

- image / entity / composition / relation 顶点；
- 每个实体有 bbox 和短/长描述；
- 父子边是父 caption 中的短语，子框在父框内；
- relation/composition 描述物体间组合、包含和交互。

Togeari 把多张图的顺序 GBC 程序拆成可并行引擎调用：VLM、detector、embedder、CPU lanes。
官方参考：OWLv2 + EmbeddingGemma + Qwen3.5 4B，RTX 4090 上 30 张约 43 秒。

## 2. MossStudio 的接入方式

MossStudio **不 vendor** GBC/Togeari，也不把模型下载进 Electron：

```
Studio「GBC 解析」面板
  → 选择图片目录 + VLM Provider + OWLv2/SAM3
  → 主进程生成临时 GBC machine.py
  → 调 `gbc run machine.py`
  → 读 graphs.jsonl
  → 把第一个 graph 的 entity bbox/描述导入画布
```

- 图片目录可以由用户选择；第一版只导入第一个 graph（多图批处理随后加图选择器）。
- VLM 复用 Agent 的 OpenAI-compatible / Anthropic Provider；API key 只放进子进程 env。
- detector/embedder 优先 `cuda:0`，没有 NVIDIA 时退回 CPU。
- 导入的 bbox 归一化坐标会转成当前画布像素坐标；描述写入区域的 caption。
- 父/子边和 relation 目前保留在 `GbcRunResult`，尚未变成 UI 的层级连线；下一版加 graph 面板。

## 3. 安装/运行前提

GBC 装在用户自己的 Python 运行时里：

```bash
pip install "kohakugbc[torch]"
# 可选 local Qwen engine:
pip install -e examples/qwen35
gbc doctor
```

- 可以使用独立 Python 环境的 `gbc`，通过 `CLOVER_GBC_BIN` 指定路径。
- VLM Provider 必须是 OpenAI-compatible 或 Anthropic，且已配置 API Key。
- 首次运行会下载 OWLv2/EmbeddingGemma；SAM3 更大更慢。
- 真实速度取决于 GPU/API、图片数量和 detector。

## 4. 当前限制

- 没有把 GBC 的 edges 画成画布连线；
- 没有多图选择/批量导入；
- 没有在 UI 内安装 `kohakugbc` 或下载模型；
- `gbc-status` 只有 CLI 检测，真实 4090/API 运行未验收；
- `graphs.failures.jsonl` 只作为错误文本，不逐图展示。

## 5. 冒烟

```bash
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=gbc-status
```

当前机器未安装 `gbc` 时，应输出 `available:false` 和安装提示，而不是崩溃。
