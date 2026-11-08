---
status: current
last-verified: 2026-11-08 (c3dc0ee)
code: apps/desktop/src/renderer/src/lib/layout.ts, apps/desktop/src/renderer/src/pages/studio/prompt.ts, apps/desktop/src/renderer/src/pages/studio/RegionLayer.tsx, apps/desktop/src/renderer/src/pages/studio/canvases.ts, apps/desktop/test/renderer/lib/layout.test.ts
---

# Layout JSON and the compiler

A 画面 (`kind: 'layout'`) with regions (区域) is sent to the engine as MOSS-Image layout JSON, compiled by `lib/layout.ts`. The draft the editor works on and the JSON the model reads use different coordinate systems; this doc is the contract between them and the rules the compiler checks. Paths are relative to `apps/desktop/src/renderer/src/`.

The format is MOSS-Image's. Its definition lives in the [MOSS-Image repository](https://github.com/OpenMOSS/MOSS-Image): `USERGUIDE.md` (Layout Prompts), `README.md` (Layout-to-image generation), and the prompt-enhancer skill's `references/layout.md` and `scripts/compile_prompt.py`. This doc describes what MossStudio does with it, not the format's semantics.

## 1. Two forms

Do not mix the coordinate systems. Everything a person edits is a draft; only the compiler produces model input.

| Form | `bbox_coord_space` | `bbox_format` | Origin | Carries `width`/`height` | Type |
| --- | --- | --- | --- | --- | --- |
| Draft (editor, project file) | `abs` | `xyxy` | Top-left corner, pixels | Yes | `LayoutDraft`; `ProjectLayer` in `shared/types.ts` |
| Compiled (model input) | `abs_centralized` | `yxyx` | Picture centre, pixels | No | The `prompt` string of `CompileResult` |

The compiled JSON is the whole prompt. The engine receives it as the `prompt` field of a generation request ([project-and-backend.md](/docs/reference/project-and-backend.md#3-the-generation-request)) and passes it to the model unchanged.

## 2. Draft fields

`LayoutDraft` in `lib/layout.ts`:

```json
{
  "width": 1024,
  "height": 1024,
  "summary": { "caption": "整体画面描述", "meta": ["poster"], "canvas": "single" },
  "items": [
    { "id": "item-text", "label": "text", "caption": "深蓝色大号标题，居中", "text": "EXPLORE", "bbox": [128, 96, 896, 224] },
    { "id": "item-mountain", "label": "object", "caption": "蓝色扁平山体插画，位于下方中央", "bbox": [224, 320, 800, 896] }
  ]
}
```

| Field | Rule |
| --- | --- |
| `width`, `height` | Positive integers, multiples of 16; the size of the finished picture |
| `summary.caption` | Non-empty: the whole scene, style and composition |
| `summary.meta` | Optional tags; blank entries are dropped and the key is left out when none remain |
| `summary.canvas` | `single`, `multi_panel` or `collage` (`LayoutCanvas`) |
| `items` | Non-empty flat array, one entry per region |
| `items[].label` | `object`, `character` or `text` (`LayoutLabel`; the UI says 物体, 人物, 文字) |
| `items[].caption` | Non-empty: what is visible in the box. For a text item, the lettering (font, colour, layout) |
| `items[].text` | Required for `label: 'text'`: the exact characters to draw, `\n` for a line break |
| `items[].bbox` | `[x1, y1, x2, y2]` in pixels from the top-left corner; `0 ≤ x1 < x2 ≤ width`, `0 ≤ y1 < y2 ≤ height` |
| `items[].id`, `visible`, `locked`, `opacity` | Editor fields; never compiled. A hidden item (`visible: false`) is left out of validation and output |

`draftJson(draft)` writes a draft as JSON with `bbox_coord_space: 'abs'`, `bbox_format: 'xyxy'` and no `id`s; `parseDraft(text)` reads one back, requiring `width`, `height` and an `items` array, filling a missing `summary` with defaults, clamping every box into the picture and giving each item a fresh `import-<n>-…` id. `clampBox(box, width, height)` normalises reversed corners, rounds to whole pixels and keeps at least a 1 px box inside the picture; every box the Studio stores has passed through it.

## 3. Compile rules

`compileLayout(draft)` validates (section 4), then for each visible item turns `[x1, y1, x2, y2]` into centred `[y1', x1', y2', x2']`:

```text
y1' = round(y1) - floor(height / 2)
x1' = round(x1) - floor(width / 2)
y2' = round(y2) - floor(height / 2)
x2' = round(x2) - floor(width / 2)
```

(`centeredBox`; upstream takes `floor` of the minimum corner and `ceil` of the maximum, which gives the same result for whole-pixel input, and the Studio's boxes are always whole pixels.) The output is:

```json
{
  "summary": { "caption": "...", "meta": ["poster"], "canvas": "single" },
  "items": [{ "label": "text", "caption": "...", "bbox": [-416, -384, -288, 384], "text": "EXPLORE" }],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

Each compiled item has `label`, `caption` and `bbox`, plus `text` for a text item, and nothing else: `width`, `height`, `id`, `visible`, `locked`, `opacity` and any field `parseDraft` carried through are dropped, because the upstream compiler rejects unknown fields. Captions and `meta` are trimmed. `CompileResult.prompt` is the compact JSON that is sent; `preview` is the same object pretty-printed, for the read-only 查看最终提示词 view.

Worked example, from the upstream guide and checked by `test/renderer/lib/layout.test.ts` on a 1024 × 1024 draft:

| Draft `bbox` (`xyxy`) | Compiled `bbox` (`yxyx`) |
| --- | --- |
| `[128, 96, 896, 224]` | `[-416, -384, -288, 384]` |
| `[224, 320, 800, 896]` | `[-192, -288, 384, 288]` |

## 4. Validation

`compileLayout` collects every problem before giving up, so the UI can show them all. The messages are the ones the Studio shows as 生成 blockers (`pages/studio/readiness.ts`):

| Check | Message |
| --- | --- |
| `width` is a positive integer multiple of 16 | 画面宽度需要是 16 的倍数 |
| `height` likewise | 画面高度需要是 16 的倍数 |
| `summary.caption` is not blank | 先写一句整体描述 |
| At least one item | 至少需要一个区域 |
| Each visible item has a caption | 区域 N 还没有描述 (1-based) |
| Each visible text item has `text` | 文字区域 N 还没有填写要显示的文字 |
| Each visible box is inside the picture with positive width and height | 区域 N 超出了画面 |

Not checked by the compiler: overlap (regions may overlap, for example a character over a background) and whether a text box is large enough for its words. The Studio adds its own checks before compiling (section 5).

## 5. How the Studio uses it

"The layout is the prompt" (`pages/studio/prompt.ts`). What the engine receives for a 画面 is always derived from the card, with no hand-written prompt that silently wins and no insert step:

- `compileCanvasPrompt(canvas)` counts the visible regions. With none, the prompt is the plain description (`source: 'text'`); an empty description is the blocker 先写一句描述. With regions, the canvas becomes a `LayoutDraft` (`canvasToDraft`: `layers` map one to one onto `items`, `ProjectLayer.kind` is the `label`) and `compileLayout` runs (`source: 'layout'`).
- The description lives in both `ProjectCanvas.prompt` and `summary.caption` (`withDescription`); `canvasDescription` reads the one the run actually uses, so older projects that filled only one still compile.
- With 高清修复 the regions are laid out on the first-pass size (`baseSize`), not the finished picture (`pages/studio/useGenerate.ts`).
- Regions are drawn on the selected 画面's face by dragging (`RegionLayer.tsx`, `useRegionDraw`, mounted by `CanvasCard.tsx`). A drag shorter than `MIN_REGION` (12 px on the picture) is a click, not a box (`canvases.ts`, `regionFromDrag`). A new box opens `RegionEditor` under it: for a 文字 region the words first (框里的文字), then the description (框里的描述), then the kind as a button group (框的类型: 物体, 人物, 文字). Moving, resizing, editing and resizing the 画面 all go through `clampBox`, so a stored box is always whole pixels inside the picture. Assistant tools add regions through the same `addRegion`, giving boxes as fractions of the picture (`RegionInput.bbox: { x, y, w, h }`) that are converted to pixels and clamped. The rest of the region UI is in [studio-node-board.md](/docs/reference/studio-node-board.md#12-regions).
- The LAN page's 画面布局 editor (`web/LayoutEditor.tsx`) works on a `LayoutDraft` directly, with the same three kinds and a 布局数据 dialog that exports and imports the draft form through `draftJson` and `parseDraft`.
