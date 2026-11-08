# 前置条件与首次运行

## 1. MossStudio 本机

- Windows/Linux x86_64 + NVIDIA
- 驱动可用
- `moss-server`（引擎页安装或手动机路径）
- MOSS-Image 权重（模型页）

macOS 可运行 UI/项目/Trainer 管理，但**不能运行本机 MossInfer**。

## 2. 首次运行

首次进入会询问是否需要配置引导。选择「开始引导」后显示准备清单；点击任一「前往配置」，弹窗会平滑停靠到右下角，并打开对应页面。点击右下角清单的整块标题栏即可展开或向下收起；也可通过箭头或应用标题栏的清单按钮切换。刷新和详情按钮独立操作。

1. 底部「引擎」：安装 MossInfer
   - 默认检查系统 cuBLASLt
   - 缺库时选择 bundled 或 system + NVIDIA wheel
2. 底部「模型」：准备 MOSS-Image
3. 底部「创作」：选择模型/引擎/设备，生成

准备清单按所选本机或 SSH 主机检查：

- NVIDIA 推理设备
- MossInfer 引擎
- 模型（合并展示主模型、文本编码器、VAE、Pipeline 与采样器配置的准备状态）

已安装的组件会自动勾选；完整的现有模型组合可以直接满足模型要求。本机模型不会计入远端清单。跳过、进行中和完成状态会保存，重启后不会重复询问；进行中的清单会在右下角恢复。动效遵循界面设置和系统「减少动态效果」偏好。

清单底部按钮显示 `0/3` 等已完成项目统计，未全部就绪时不可点击；三项全部就绪后变为「完成」，点击保存完成状态并进入创作页。各项目的「配置」入口保持可用。

Python、Instance、Trainer 和 GBC 的完整运行环境不属于准备清单；未安装 Python 不影响清单完成。清单不增加 Git 安装项。

进入待配置的页面时，35% 不透明度的暗色遮罩会突出可操作的控件，用主题发光边框和提示说明下一步。发光描边直接附着在原控件上，随控件滚动、缩放和动画同步移动。准备清单不显示外边框；仅查看清单时不显示遮罩。点击高亮区域内的操作按钮后，自动隐藏高亮、遮罩和提示，清单保持展开；弹出的 CUDA 方案、下载确认或 SSH 配置窗口不继续叠加引导。提示上的关闭按钮也只隐藏页面引导；再次点击清单的「配置」可恢复高亮。收起清单或结束引导也会清除控件描边、遮罩和提示。

MossInfer 引擎步骤仅高亮下载或安装按钮。操作提示通过浏览器原生锚点定位绑定到目标控件，紧跟滚动；空间不足时自动换边，目标滚出可视区域时一起隐藏。

本地模型库将「推荐组合」整块和「MOSS 模型 / Qwen 编码器 / VAE」等组件分页标签分别高亮，各自显示说明。推荐组合可一键补齐完整运行所需组件；分页列表用于单独挑选和下载，已有编码器与 VAE 可复用。切换分页或点击补齐按钮后同样自动关闭页面引导。

## 3. 引擎包

| 变体 | 说明 |
| --- | --- |
| system-cuda | 小；依赖系统 cuBLASLt |
| bundled | +700MB；自带 CUDA 库 |

- 系统预检：Linux `ldconfig`/find；Windows CUDA Toolkit/System32/PATH。
- 缺库不会静默 pip 安装。
- 原生 wheel：`cudaWheels.ts` 下载 nvidia-cublas/nvidia-cuda-runtime wheel，用 JS 解压 DLL/so。

## 4. 远端 Linux

要求：

- Linux x86_64 + NVIDIA
- SSH
- `curl`、`tar`
- `engineRoot`（默认 `~/.mossstudio/engine`）
- `outputRoot`（默认 `~/.mossstudio/outputs`）

引擎页：

- 检测
- 安装 bundled 引擎
- 准备默认 HF 模型

## 5. Trainer

Trainer 保留自己的前置条件：

- Python 3.10+
- Git
- 训练器版本/环境

这些检测只在 Trainer 范围内使用，不属于 MossStudio 推理启动。

内置 Python 安装服务保留，使用 [Astral Python Build Standalone](https://github.com/astral-sh/python-build-standalone) 的 Python 3.12 安装包，按本机系统和架构选择，下载后校验 SHA256，再验证解释器、venv、ensurepip 和 SSL。安装不依赖已有 Python，完成后将应用解释器指向应用数据目录 `runtimes/python/` 中的内置版本，不修改系统 PATH；该服务不在首次引导中展示。

## 6. GBC

可选：

- 外部 `gbc`
- 独立 Python 环境
- 缺失只影响 GBC 解析，不影响创作/生成
