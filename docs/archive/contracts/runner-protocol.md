# Runner 协议 v1

薄 runner 是启动器随应用分发的 Python 入口（`runner/runner.py`），负责调用官方
pipeline 并把进度翻译成结构化事件。它**不是**推理后端：不实现模型、不改数值。

## 1. 传输

- 进程：`<python> runner.py --job <job.json>`，`cwd` = 实例目录；
- runner 启动时把实例目录插入 `sys.path`，以便 import 官方仓库里的模块；
- 事件：stdout，每行一个对象，前缀固定 `@@CLOVER@@ `；
- 非前缀行：原样作为日志，由控制台显示（仍会走 tqdm 兜底解析）；
- stderr：只放诊断信息，按日志处理；
- 编码：UTF-8；每行 ≤ 64 KB；必须 `flush()`。

```
@@CLOVER@@ {"type":"ready","protocol":1,"capabilities":["progress","preview","cancel"]}
```

## 2. 生命周期

```
spawn ──> hello ──> ready ──> stage* ──> progress* ──> result ──> bye ──> exit 0
                                   │
                                   ├──> error (fatal=true) ──> exit != 0
                                   └──> canceled ──> bye ──> exit 130
```

- `ready` 必须在 180 s 内出现，否则启动器判定超时（`E_TIMEOUT`）；
- `ready` 之前不显示进度条，只显示“加载中”；
- 每个 job 只允许一个 `result`；
- 取消：启动器向 stdin 写 `@@CLOVER@@ {"cmd":"cancel"}`，runner 在下一个 step 边界退出。

## 3. 事件

| type | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `protocol`, `runner_version` | 首行 |
| `ready` | `capabilities`, `device`, `dtype` | pipeline 加载完成 |
| `stage` | `name: load\|text\|denoise\|decode\|save` | 阶段切换 |
| `progress` | `stage`, `current`, `total`, `percent`, `eta_ms?`, `rate?`, `message?` | 去噪/下载 |
| `preview` | `step`, `image_b64`, `width`, `height` | 可选，≤ 256px JPEG |
| `log` | `level: debug\|info\|warn\|error`, `message` | 结构化日志 |
| `result` | `images[]`, `timings`, `peak_memory_mb?` | 成功 |
| `error` | `code`, `message`, `fatal`, `traceback?`（≤ 8 KB） | 失败 |
| `canceled` | `at_stage` | 已取消 |
| `bye` | `exit_code` | 最后一行 |

`images[]`：`{path, width, height, seed}`；路径相对实例根目录。

`timings`：`{load_ms, text_encode_ms, denoise_ms, decode_ms, total_ms}`。

## 4. 命令（stdin）

| cmd | 载荷 | 行为 |
| --- | --- | --- |
| `cancel` | — | 当前 step 结束后停止，发 `canceled` |
| `ping` | `id` | 回 `pong`（用于健康检查） |
| `shutdown` | — | 立即清理并退出 |

## 5. job.json

```json
{
  "job_id": "01J...",
  "instance_id": "moss-main-c1355e6",
  "model": {
    "dit": "models/transformer",
    "text_encoder": "models/text_encoder",
    "vae": "models/vae",
    "tokenizer": "models/tokenizer",
    "scheduler": "models/scheduler"
  },
  "prompt": "a rainy night watch repair shop, ...",
  "negative_prompt": "",
  "width": 768,
  "height": 768,
  "steps": 8,
  "guidance_scale": 1.0,
  "seed": 42,
  "batch": 1,
  "profile": "dmd8",
  "adapters": [{ "path": "adapters/xxx.safetensors", "strength": 0.8 }],
  "output_dir": "outputs",
  "device": "mps",
  "dtype": "float16",
  "options": { "vae_tiling": true, "attention_slicing": false }
}
```

- `model.*` 可以是本地目录，也可以是 HF repo id（由启动器决定并注入 `HF_HOME`）；
- `profile` 决定采样器：`base`（50 步 CFG3 + block-22 skip）或 `dmd8`（data-space DMD）；
- runner 必须校验宽度/高度为 16 的倍数。

## 6. 示例会话

```
@@CLOVER@@ {"type":"hello","protocol":1,"runner_version":"0.1.0"}
@@CLOVER@@ {"type":"ready","device":"mps","dtype":"float16","capabilities":["progress","cancel"]}
@@CLOVER@@ {"type":"stage","name":"text"}
@@CLOVER@@ {"type":"stage","name":"denoise"}
@@CLOVER@@ {"type":"progress","stage":"denoise","current":1,"total":8,"percent":12.5}
@@CLOVER@@ {"type":"progress","stage":"denoise","current":5,"total":8,"percent":62.5,"eta_ms":18000}
@@CLOVER@@ {"type":"stage","name":"decode"}
@@CLOVER@@ {"type":"result","images":[{"path":"outputs/0001.png","width":768,"height":768,"seed":42}],"timings":{"load_ms":8200,"text_encode_ms":1200,"denoise_ms":31000,"decode_ms":5200,"total_ms":45600}}
@@CLOVER@@ {"type":"bye","exit_code":0}
```

## 7. 错误码

| code | 含义 |
| --- | --- |
| `E_LOAD` | pipeline/权重加载失败 |
| `E_OOM` | 设备内存不足 |
| `E_DTYPE` | dtype/设备不支持 |
| `E_INPUT` | 参数非法 |
| `E_NET` | 下载/鉴权失败 |
| `E_INTERNAL` | 未分类 |

启动器会把 `E_*` 映射到诊断规则；`traceback` 只进日志与“原始输出”，不进 toast。

## 8. 兼容性

- `protocol` 主版本不同 → 启动器拒绝启动并提示更新；
- 未知事件类型忽略；未知字段忽略；
- runner 版本随应用版本走，实例不单独安装 runner。
