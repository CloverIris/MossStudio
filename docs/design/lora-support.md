# LoRA 支持设计

- 状态：开发中
- 范围：本机 MossInfer 的 LoRA 选择、强度与生成链路（远端留到后续）

## 1. 现状

| 层 | 状态 | 说明 |
| --- | --- | --- |
| `moss-server` 协议 | ✅ | `generate` 参数支持 `loras: [{ path, strength }]`，非空才发送 |
| 模型目录 | ✅ | `AdapterEntry.kind = 'lora' \| 'lycoris' \| 'dmd'`，可下载/校验 |
| 生成调用 | ❌ | `supervisor.ts`、`main/index.ts` 两处硬编码 `loras: []` |
| Project/Canvas | ❌ | 没有 `adapters` 字段 |
| 创作页 UI | ❌ | 没有选择入口 |

目标：让用户在布局 Canvas 上选择若干 LoRA、分别设置强度，并随生成请求下发。

## 2. 数据模型

```ts
// shared/types.ts
export interface CanvasAdapter {
  /** 适配器在模型库中的 id。 */
  id: string
  /** 0 – 2，默认 1。 */
  strength: number
  /** 下载时记录的绝对路径；生成前会重新解析并校验。 */
  path?: string
}

export interface ProjectCanvas {
  // …
  adapters?: CanvasAdapter[]
}
```

要点：

- **只存 id + strength**，`path` 是缓存字段。生成前按 id 到模型库重新解析，避免项目文件指向已被删除/移动的文件。
- schemaVersion 保持 3：`adapters` 可选，缺省 = 不使用 LoRA，旧工程照常可读。
- 远端 Canvas 的 `path` 指向**引擎主机**，本机路径对远端无意义；远端的解析策略见 §6。

## 3. 界面

左栏「生成参数」增加一行：

```
LoRA    [+ 选择]  [风格A · 0.8 ×]
```

- 「选择」打开适配器多选（来自模型库 `kind: 'adapter'` 的条目），选中后出现在行内
- 每个条目带强度输入（0–2，步进 0.05）和移除按钮
- 未安装的适配器显示为 `未安装`，不参与生成并给出提示
- 行内显示条数，超过 4 条折叠为 `+N`

## 4. 生成链路

```
Canvas.adapters
  → resolveAdapters()   // id → 模型库条目 → 绝对路径
      ├─ 过滤未安装 / 路径不存在
      ├─ 路径必须在模型根目录内（isInside 校验，防任意路径注入）
      └─ strength 夹到 [0, 2]
  → startEngineJob({ loras: [{ path, strength }] })
  → moss-server generate { loras }
```

改动点：

| 文件 | 改动 |
| --- | --- |
| `shared/types.ts` | 新增 `CanvasAdapter`，`ProjectCanvas.adapters?` |
| `shared/schemas.ts` | `projectCanvasSchema` 增加 `adapters` |
| `main/services/supervisor.ts` | `loras: []` → 由 job 参数传入 |
| `main/index.ts` | 两处 `loras: []` 同步 |
| `renderer/pages/Studio.tsx` | 左栏 LoRA 行 + 选择弹窗 |
| `renderer/lib/studioClient.ts` | 无改动（随 Canvas 一起保存） |

## 5. 校验与错误

| 情况 | 行为 |
| --- | --- |
| 适配器未安装 | 生成前提示 `LoRA「X」未安装`，允许移除后继续 |
| 文件被删除 | 同上（按 id 解析失败） |
| 路径越界 | 拒绝，报 `LoRA 路径不在模型目录内` |
| strength 非法 | 夹到 `[0, 2]`，不阻断生成 |
| 引擎不支持 | `moss-server` 返回错误时原样透传到诊断卡片 |

## 6. 远端（后续）

远端 `generate` 里的 `path` 是**引擎主机上的路径**。两种策略：

1. 远端模型库镜像：把 LoRA 传到 `remoteModelPath` 同级目录，生成时用远端路径（推荐）
2. 拒绝远端 + LoRA：明确提示"远端引擎暂不支持 LoRA"，避免用户以为生效了

在 §1 的范围内先实现本机；远端 Canvas 上有 adapters 时给出明确提示，不静默忽略。

## 7. 测试

- 单元：`resolveAdapters` 的 id→path、越界、缺失、strength 夹取
- 场景：`mossinfer-engine-job` 的 fake sidecar 记录收到的 `loras`，断言数量/强度
- UI：选择 → 保存 → 重新打开项目 → 选择仍在
- 真实：本机一张 LoRA（用户提供）出图，对比不加 LoRA 的差异

## 8. 不做

- LoRA 训练
- 多个 LoRA 的权重合并/冲突检测（引擎按顺序叠加，效果由用户判断）
- LoRA 预览图生成
