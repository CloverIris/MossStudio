# 后端与 Project

## 1. 进程

`src/backend/index.ts` 是 Electron utility process：

- 本机 HTTP/WS，供 Studio/LAN WebUI 使用
- 通过 RPC 调用主进程服务
- token 校验；token 由主进程生成

## 2. HTTP API（当前）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/jobs` | 任务列表 |
| GET | `/api/jobs/:id` | 单个任务 |
| POST | `/api/engine-jobs` | 提交 MossInfer 任务 |
| POST | `/api/jobs/:id/cancel` | 取消 |
| GET | `/api/projects` | Project 列表 |
| POST | `/api/projects` | 保存 Project（`ProjectSaveInput`） |
| GET/DELETE | `/api/projects/:id` | 读取/删除 |
| GET | `/api/models` | 模型 catalog |
| GET | `/api/gallery` | 画廊分页 |
| GET | `/api/gallery/file` | 画廊文件 |
| GET | `/api/studio/bootstrap` | Studio 启动数据 |

旧 `/api/jobs` 提交、`/api/instances` 已移除。

## 3. Engine Job

```json
{
  "modelBinding": { "bundleId": "...", "dit": "...", "textEncoder": "...", "vae": "..." },
  "modelName": "MOSS-Image SFT",
  "deviceId": "cuda:0",
  "prompt": "{\"summary\":{...},\"items\":[...]}",
  "negativePrompt": "...",
  "width": 1024,
  "height": 1024,
  "steps": 8,
  "cfg": 3,
  "seed": 42,
  "profile": "dmd8",
  "projectId": "...",
  "canvasId": "...",
  "hostId": "ssh-...",
  "remoteModelPath": "~/.mossstudio/models/..."
}
```

`prompt` 的语义：

- Canvas 上**有可见区域**时，渲染层把布局编译成一段 JSON（`summary` + 每个区域的 `label/caption/bbox`），直接作为 `prompt` 发送。
- **没有区域**时使用左栏手写提示词（纯文本）。

本地：`modelBinding` → bundle 路径。
远端：`hostId + remoteModelPath`；本地模型绑定可省略。
输出：本地 `<userData>/outputs/`；远端回传后落到同一目录。

## 4. WebSocket

`/ws?token=...` 广播任务/日志事件，用于 WebUI 状态同步。

## 5. Project

```text
projects/<project-id>/
  project.json
  assets/<background>
```

`project.json`（`schemaVersion: 3`）：

```json
{
  "schemaVersion": 3,
  "id": "project-...",
  "name": "未命名 Project",
  "seriesId": "series-...",
  "page": 1,
  "selectedCanvasId": "canvas-...",
  "canvases": [
    {
      "id": "canvas-...",
      "kind": "layout",
      "title": "Canvas 1",
      "x": 0, "y": 0,
      "width": 1024, "height": 1024,
      "summary": { "caption": "...", "meta": ["poster"], "canvas": "single" },
      "layers": [
        { "id": "...", "kind": "character", "caption": "...", "bbox": [x1,y1,x2,y2], "visible": true, "locked": false, "opacity": 1 }
      ],
      "prompt": "...", "negative": "...",
      "seed": 42, "steps": 8, "cfg": 3,
      "modelBundleId": "...", "deviceId": "...",
      "jobId": "...", "jobState": "succeeded",
      "outputs": ["outputs/job-...-1.png"]
    }
  ],
  "createdAt": "...", "updatedAt": "..."
}
```

要点：

- **一张 Canvas 一条记录**：提示词、采样参数、模型/设备、任务状态和输出都在 Canvas 上，Project 层不再有快照字段。
- **`x/y` 是画布板坐标**（board pixels），由拖动写回；不再有 `row/column` 网格。
- `kind: "layout"` 可编辑；`kind: "result"` 只读，通过 `sourceCanvasId` 指回来源。
- 保存入口只接受 `canvases / selectedCanvasId / seriesId / page`，其余字段由主进程维护。
- **不兼容旧版本**：`schemaVersion !== 3` 的文件直接视为不可读（返回 `null`），旧工程目录保留在磁盘上但不显示。

## 6. 数据边界

- Project 只引用模型/设备/引擎，不引用 Instance。
- 模型文件不复制进 Project。
- 训练数据在 `trainer/`，不进入 Project。
- 删除 Project 不删除模型/输出（输出由画廊管理）。
