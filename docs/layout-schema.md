# MOSS-Image Layout JSON：格式与编译器

> 调研来源（官方仓库）：
> - `USERGUIDE.md` → *Layout Prompts (Experimental)*
> - `README.md` → *Layout-to-image generation*
> - `skills/moss-image-prompt-enhancer/references/layout.md`
> - `skills/moss-image-prompt-enhancer/scripts/compile_prompt.py`
>
> 启动器里的编译器实现：`apps/desktop/src/renderer/src/lib/layout.ts`。

## 1. 两种形态

MOSS 的 layout 有“可编辑草稿”和“模型输入”两种形态。**不要混淆坐标系**。

| 形态 | `bbox_coord_space` | `bbox_format` | 坐标原点 | 是否带 width/height |
| --- | --- | --- | --- | --- |
| 草稿（人/编辑器） | `abs` | `xyxy` | 左上角 | 是 |
| 编译结果（模型） | `abs_centralized` | `yxyx` | 画布中心 | 否 |

编译后的 JSON 直接粘贴进 Prompt 输入框即可；官方 Gradio 不做额外解析。

## 2. 草稿字段

```json
{
  "width": 1024,
  "height": 1024,
  "bbox_coord_space": "abs",
  "bbox_format": "xyxy",
  "summary": {
    "meta": ["poster"],
    "canvas": "single",
    "caption": "整体画面描述"
  },
  "items": [
    {
      "label": "text",
      "caption": "深蓝色大号标题，居中，无底框",
      "text": "EXPLORE",
      "bbox": [128, 96, 896, 224]
    },
    {
      "label": "object",
      "caption": "蓝色扁平山体插画，位于下方中央",
      "bbox": [224, 320, 800, 896]
    }
  ]
}
```

- `width` / `height`：16 的正整数倍，等于最终出图尺寸；
- `summary.caption`：非空，整体场景/风格/构图；
- `summary.meta`：可选标签数组；`summary.canvas`：`single | multi_panel | collage`；
- `items`：非空扁平数组；
- `label`：`object | character | text`；
- `caption`：非空，描述该区域可见外观；文字项还要描述字体、颜色、排版；
- `text`：文字项必填，原样字符，换行用 `\n`；
- `bbox`：`[x1, y1, x2, y2]`，左上原点，像素，必须 `0 ≤ x1 < x2 ≤ width`、`0 ≤ y1 < y2 ≤ height`；
- 可选 `tags` / `palette`（item 级）；`palette` 也支持在 summary 级。

## 3. 编译规则

对每个 bbox：

```
y_min' = floor(y1) - height/2
x_min' = floor(x1) - width/2
y_max' = ceil(y2)  - height/2
x_max' = ceil(x2)  - width/2
```

输出顺序为 `[y_min', x_min', y_max', x_max']`，并带上：

```json
"bbox_coord_space": "abs_centralized",
"bbox_format": "yxyx"
```

编译结果**去掉** `width` / `height` / `id` 等编辑器字段；官方编译器会拒绝未知字段，所以不要塞 `children`、`parent`、`scene.elements` 之类。

### 官方示例对拍

草稿（1024×1024）：

```json
{"label":"text","bbox":[128,96,896,224],"text":"EXPLORE"}
{"label":"object","bbox":[224,320,800,896]}
```

编译后：

```json
{"label":"text","bbox":[-416,-384,-288,384],"text":"EXPLORE"}
{"label":"object","bbox":[-192,-288,384,288]}
```

启动器编译器对同一草稿的输出与官方 `compile_prompt.py` **逐字段一致**（已实测）。

## 4. 校验清单（编辑器已实现）

- 画布宽高必须是 16 的倍数；
- 至少一个区域；每个区域 caption 非空；
- `text` 标签必须有文字；
- bbox 在画布内、宽高为正；
- 编译时四舍五入后仍要有正面积；
- 文字长度与框大小要匹配：短标题和整段文字需要不同的框；
- 多个区域允许重叠（例如人物与背景）。

## 5. 启动器里的对应 UI

`/studio` 页面：

1. 选择画布尺寸（512² / 768² / 1024² / 1024×768 / 768×1024，或自定义 16 倍数）；
2. 选中画面后直接在画面上拖出区域，框下立刻出现输入框：填写 caption，类型在同一处选 `物体 / 人物 / 文字`（默认物体）；
3. 文字区域再填 `text`；双击框可再次编辑，右键可改类型或删除，左栏“区域”列表负责排序、隐藏和锁定；
4. 填 `summary.caption`、`meta`、`canvas`；
5. 点“编译布局 Prompt” → 预览编译后的 JSON → “插入到 Prompt”；
6. 生成入口已接独立 Clover 后端；缺权重/运行时仍会在提交前预检拦截。

底部“布局总览”会显示 `abs · xyxy`，编译弹窗会显示 `abs_centralized · yxyx`，避免用户在两个坐标系之间猜。

## 6. 常见错误

| 错误 | 后果 |
| --- | --- |
| 把 `xyxy` 编译成 `abs_centralized` 时忘了减中心 | 框整体偏移，人物/文字跑到画布外 |
| 文字项只写 caption 不写 `text` | 官方编译器直接拒绝 |
| 用百分比坐标 | 官方只接受绝对像素 |
| 画布尺寸不是 16 的倍数 | 校验失败 |
| 把编辑器 `id` 一起塞进模型 JSON | 官方编译器拒绝未知字段 |
