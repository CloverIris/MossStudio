# 引擎协议 v0.1（V2 自研引擎，V1 不使用）

> V1 启动器与外部 Python 运行时之间使用 [runner-protocol.md](runner-protocol.md)；
> 本文是未来 `clover-engine` 的 HTTP 契约，保留以免重复设计。

启动器（桌面/WebUI）与引擎之间的唯一契约。引擎可以嵌入进程内（桌面壳直连 C ABI），
也可以独立进程（headless），两者行为一致。

## 1. 传输

- 默认：HTTP/1.1，`127.0.0.1`，随机端口，`Authorization: Bearer <token>`；
- 事件：`text/event-stream`（SSE），断线后从 `Last-Event-ID` 续传；
- 备选：`stdio` 模式，每行一个 JSON 对象（请求/响应/事件同一通道），用于嵌入与测试；
- 编码：UTF-8，JSON，不允许 NaN/Infinity。

版本前缀 `/v1`。破坏性变更升 `/v2`，不原地改语义。

## 2. 资源

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | `{status, version, backend, device}` |
| GET | `/v1/system` | 内存、磁盘、后端能力、已加载组件 |
| GET | `/v1/models` | 本地模型包列表（含清单摘要与校验状态） |
| POST | `/v1/models/install` | 从 HF/ModelScope 安装（异步任务） |
| POST | `/v1/models/{id}/load` | 预热（加载 TE/DiT/VAE 到指定档位） |
| POST | `/v1/models/{id}/unload` | 释放 |
| GET | `/v1/adapters` | 适配器列表 |
| POST | `/v1/jobs` | 创建生成任务 |
| GET | `/v1/jobs/{id}` | 任务快照 |
| DELETE | `/v1/jobs/{id}` | 取消（幂等） |
| GET | `/v1/events` | SSE 事件流（可按 `job` 过滤） |
| GET | `/v1/outputs/{id}` | 结果文件（PNG） |

## 3. 任务状态机

```
queued ──> running ──> succeeded
   │          │
   │          ├──> failed
   └──────────┴──> canceled
```

- 并发：同一时刻只跑 1 个 GPU 任务；其余 `queued`，按 `priority` + FIFO 排序；
- 取消：`DELETE` 置位取消标志，引擎在 block 边界检查，≤100 ms 生效；
- 失败可重试：`POST /v1/jobs` 带 `retry_of` 字段（预留，v0.1 不实现）。

## 4. 事件

所有事件带 `seq`（单调递增）、`job`、`ts`。SSE `id` = `seq`。

| type | 载荷 | 说明 |
| --- | --- | --- |
| `job.queued` | `{position}` | 入队 |
| `job.started` | `{model, profile, width, height, steps}` | 开始 |
| `stage` | `{name: "text_encode"\|"denoise"\|"decode"}` | 阶段切换 |
| `progress` | `{step, total, elapsed_ms, eta_ms}` | 去噪进度 |
| `preview` | `{step, image_b64}` | 可选低分辨率预览 |
| `memory` | `{rss_mb, backend_mb, peak_mb}` | 每 10 步采样 |
| `log` | `{level, message}` | 结构化日志 |
| `job.succeeded` | `{outputs: [{path, seed, width, height}], timings}` | 成功 |
| `job.failed` | `{code, message, details}` | 失败 |
| `job.canceled` | `{at_stage}` | 已取消 |
| `degraded` | `{from, to, reason}` | 自动降档（分辨率/精度/profile） |

`timings` 至少包含 `text_encode_ms`、`denoise_ms`、`decode_ms`、`total_ms`。

## 5. 错误

```json
{"error": {"code": "OOM", "message": "...", "details": {"stage": "decode"}}}
```

| code | HTTP | 含义 |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | schema 校验失败 |
| `NOT_FOUND` | 404 | 模型/任务不存在 |
| `CONFLICT` | 409 | 模型正在加载 / GPU 被训练占用 |
| `UNSUPPORTED` | 422 | 后端不支持（如 img2img） |
| `OOM` | 507 | 显存/内存不足，且降档后仍失败 |
| `CANCELED` | 499 | 客户端取消 |
| `INTERNAL` | 500 | 未分类错误（带 trace id） |

## 6. 确定性

同一 `model` + `prompt` + `seed` + `width/height` + `steps` + `profile` + `adapters`
在同一后端版本上应逐像素一致。跨后端只保证 LPIPS ≤ 0.05，并在结果元数据里记录
`backend` 与 `engine_version`。

## 7. 安全

- 仅监听 loopback；`/v1/models/install` 只接受允许列表域名；
- token 每次启动随机生成，写入 `0600` 的运行时文件；
- 不执行模型包内的代码；路径参数必须是 `models_root` 下的相对路径；
- CORS 默认关闭，WebUI 由引擎自己托管。

## 8. 兼容性

- 引擎与启动器各自携带 `protocol` 版本；启动器要求 `major` 相同；
- 未知字段必须忽略（向前兼容）；未知事件类型必须忽略；
- `clover.json` 用 `schema_version` 独立演进。
