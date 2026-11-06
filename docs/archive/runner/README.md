# MossStudio runner

薄编排层，不是推理引擎。它读取 `job.json`，加载**实例目录里的官方 MOSS-Image 代码**，
跑一次生成，把阶段、进度、结果和错误写成 NDJSON。

```bash
python runner.py --job /path/to/job.json
python runner.py --job /path/to/job.json --simulate   # 不加载权重
```

## 事件

每行以 `@@CLOVER@@ ` 开头，后接 JSON：

```json
{"type":"hello","protocol":1}
{"type":"ready","device":"mps","dtype":"torch.float16"}
{"type":"stage","name":"text"}
{"type":"progress","stage":"denoise","current":5,"total":8,"percent":62.5}
{"type":"result","images":[{"path":"outputs/0001.png","width":1024,"height":1024,"seed":42}]}
{"type":"error","code":"E_OOM","message":"...","traceback":"...","fatal":true}
{"type":"bye","exit_code":0}
```

非前缀行原样进控制台；Supervisor 同时用 tqdm/下载条规则兜底。

## 取消

stdin 接收：

```json
@@CLOVER@@ {"cmd":"cancel"}
```

runner 在下一个 step 检查标记并抛出取消；Supervisor 5 秒后仍未退出则强杀进程组。

## 模拟模式

`--simulate` 只走事件流、写一张 512² 的蓝色测试 PNG，用于验证：

- Supervisor 的 readiness / 进度 / 结果 / 日志；
- 取消链路；
- 任务/终端、画廊、诊断页。

真实模式需要实例运行时 + 约 27 GB SFT 权重；本机未下载，所以未做真机验收。

## 限制

- DMD 8 步 profile 目前只透传，仍走官方 pipeline；
- 本地实例支持模型组件绑定，使用 runner 的精度适配层；见 [模型组件管理](../../model-management.md)；
- 官方 Gradio 已从产品路径退役（ADR-0007），runner 不再包含 Gradio 启动脚本。
