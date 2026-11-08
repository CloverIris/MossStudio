# UI rules

How MossStudio screens are built, so the same kind of content and the same action look the same everywhere. Every rule here can be checked in code review. Paths are relative to `apps/desktop/src/renderer/src`.

The visual system is fixed: flat and quiet, areas told apart by lighter and darker surfaces (`frame → board → panel → surface → raised`), never by borders or lines; one accent for selection, focus and progress; light and dark themes from the same tokens (`styles.css`). The E2E visual audit (`apps/desktop/e2e/support/audit.browser.js`) fails on borders, `<hr>`, colours that are not tokens, and low-contrast text.

## 1. Use the primitive, not Tailwind by hand

| Need | Use | File |
| --- | --- | --- |
| Page title + description + page actions | `PageHeader` | `components/ui.tsx` |
| A titled block of a page | `Section` (`title`, `description`, `actions`) | `components/ui.tsx` |
| Settings-style list | `Group` + `Row` | `components/ui.tsx` |
| Things the app can decide itself | `Advanced` | `components/ui.tsx` |
| Labelled input | `Field` + `Input` / `Select` / `Textarea` / `Switch` | `components/form.tsx` |
| Something to know / watch / that will be lost | `Notice` (`info` / `warn` / `danger`) | `components/common/Notice.tsx` |
| A prompt (描述, 不想出现的内容) | `PromptBlock`, one per prompt | `components/common/PromptBlock.tsx` |
| A read-only folder, file or URL | `PathValue` (`copy` when people need to paste it; `copyLabel` when several sit together) | `components/common/PathValue.tsx` |
| A field or block label with an optional value on the right | `FieldLabel` (`as="h3"`/`"h2"` when it heads a block) | `components/ui.tsx` |
| A slider with its label and value (strength, opacity, CFG) | `SliderField` | `pages/studio/InputControls.tsx` |
| Progress | `ProgressBar`; `value={null}` when the amount is unknown | `components/ui.tsx` |
| Loading | `LoadingRow` (spinner + "正在读取…" or a label) | `components/ui.tsx` |
| Nothing here yet | `EmptyState` (`size="page"` or `"section"`) | `components/ui.tsx` |
| Status label | `Pill` | `components/ui.tsx` |
| Menus and pickers | `Popover` + `MenuItem` | `components/common/Popover.tsx` |
| Confirming a destructive action | `ConfirmDialog` | `components/ui.tsx` |
| Joining classes | `cn` (tailwind-merge: a later class wins) | `components/cn.ts` |

Checks: no hand-built warning boxes (`bg-warn-soft` / `bg-danger-soft` outside `Notice` and `Pill`); no `ProgressBar value={100}` standing in for "busy"; no `h-[NNpx]` / `h-6` / `h-7` overrides on `Button` (use a size).

## 2. Headings

Use only these levels. Do not hand-build a heading with `text-* font-*`.

| Level | Look | Comes from |
| --- | --- | --- |
| Screen title | `text-title` semibold ink (`text-display` only on first-run setup) | `PageHeader` |
| Dialog / sheet / popover title | `text-section` semibold ink | `Modal`, `Sheet` |
| Section | `text-ui` semibold ink-2 | `Section` |
| Label of a field or block | `text-caption` medium ink-2 | `FieldLabel`, `Field`, `PromptBlock` |
| Row title | `text-control` ink, normal weight; also the title of any list item (Activity, popovers, setup steps) | `Row` |

`Advanced` is a disclosure, not a heading: it must not be louder than the section titles around it.

## 3. Actions

`Button` tones (`components/ui.tsx`):

| Tone | For | Rule |
| --- | --- | --- |
| `primary` | The one main action of a view | At most one per view. Never on a disabled action that has no way to become enabled; hide it and promote the action that works. |
| `secondary` | Other actions | Default. |
| `ghost` | Quiet actions: cancel, skip, close, show in folder | Close and cancel are never `primary`. |
| `ghost-danger` | Starting something destructive from a row or panel (删除, 卸载…) | Opens a confirm, or the action can be undone. |
| `danger` | The confirm button of a destructive step | Solid red; only inside the confirm (dialog footer, uninstall screen). |

Sizes: `xs` 26px (inline in dense panels and rows), `sm` 30px (default), `md` 34px (dialog footers), `lg` 44px (the main action of a screen). `IconButton` is 32px; `className="size-7"` for dense rows.

Recurring actions:

- **Delete** = `Trash2` icon or the word 删除, `ghost-danger`, followed by `ConfirmDialog` (or an undo toast). Say where it goes ("移到回收站") or that it is permanent.
- **X** = remove from a list or unlink (移除). It never deletes files.
- **Refresh / redetect / test** = an `IconButton` with `RefreshCw` in the `Section` actions, or a labelled `secondary` when it is the way out of an error.
- **Retry** = `secondary` 重试 next to the error; `primary` only when it is the only thing left to do on the screen.
- **Copy** = `IconButton` with `Copy` next to the value (as in `PromptBlock` and `PathValue`); toast "已复制…".
- **External link** = `ghost` with `ExternalLink` after the label.

## 4. Loading, empty, error

- Loading: `LoadingRow`; the label ends with "…" ("正在读取…"). A spinner without words only inside a button.
- Empty: `EmptyState` with a title that says what is missing and, when there is one, the action that fills it. `size="section"` inside a page, `size="page"` for a whole page or panel.
- Error: `Notice tone="danger"` with what went wrong in plain words and an xs/sm action (重试 or the place to fix it). Do not show only red text.
- Unknown progress: `ProgressBar value={null}` (a moving segment). A full bar means done.

## 5. Status

- `Pill` tones: `neutral` (default, no state), `accent` (selected / in use), `ok` (ready), `warn` (needs attention, partly done), `danger` (failed, blocked). Use these names, not the aliases `blue` / `amber` / `red`.
- Same state, same form: a list shows a state either as a `Pill` or as a `StatusDot` with text, the same way on every row.
- In progress is `accent` (a `ProgressBar` or an accent Pill), for downloads, installs, generation and training alike.

## 6. Words and numbers

Format through `lib/format.ts`, never inline:

| Value | Function | Reads |
| --- | --- | --- |
| Date | `date` | 2026 年 11 月 4 日 |
| Date and time | `dateTime` | 2026 年 11 月 4 日 14:32 |
| Recent moment | `relative` | 刚刚 / 5 分钟前 / 3 小时前 / 2 天前, then the date |
| Size on disk | `bytes` | 858 MB |
| Picture size | `dimensions` | 1024 × 1024 |
| Version | `version` | 1.2.0 (no "v") |
| Strength 0–1 | `strength(v, 'share')` | 60% |
| Weight (LoRA, control) | `strength(v, 'weight')` | 0.8; unset is 默认 |
| Time left / taken | `eta` / `duration` | 约 6 秒 / 2 分 5 秒 |
| Job state, stage, title, summary | `jobStateLabel`, `stageLabel`, `jobProgressDetail`, `jobTitle`, `jobSummary` | 排队中, 准备中, 生成中, 完成, 失败, 已取消 |

Text is Chinese, plain and friendly, for people who are not technical. Name the thing the person knows (显卡, 引擎, 模型), not the implementation.

## 7. Icons

`lucide-react` with `strokeWidth={1.6}`; `size-4` in buttons and rows, `size-3.5` in xs buttons and dense rows. Icons sit before the label.
