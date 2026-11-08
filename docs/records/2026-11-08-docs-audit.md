---
status: record
date: 2026-11-08
---

# Documentation audit, 2026-11-08

Every doc under `docs/` checked against the code at `ce189a1`, before the docs reorganisation. Paths are the old ones; the reorganisation that followed moved, rewrote or archived each doc listed here, as [docs/archive/README.md](../archive/README.md) records.

Only `docs/design/ui-rules.md`, `docs/release.md` and ADR-0010 are fully current. Nothing documents the 2.0 node board or the Vulkan/AMD engines. `docs/.omc/` is untracked agent state; gitignore it.

| path | lines | lang | kind | audience | currency (evidence) | overlap | suggestion |
|---|---|---|---|---|---|---|---|
| README.md (docs) | 78 | zh | index | all | partly stale (see below) | CONTRIBUTING | rewrite as a short reading map |
| agent-and-prompt.md | 56 | zh | feature design | contrib | partly stale: L59 says Agent tool calls aren't built, but `lib/agentTools.ts` is used by StudioPage; the 分段 (prompt-split) feature L31 no longer exists | root README | rewrite short, or merge into a features doc |
| architecture.md | 200 | zh | reference | contrib | partly stale: L19/L78-87 list bottom pages and `/engines`, but routes.ts has `/library` with redirects; L65 cites `pages/Engine.tsx`, which doesn't exist; L9 says NVIDIA only, but `shared/cliEngine.ts` adds Vulkan and HIP engines; §3 lists files that no longer exist (updates.ts, updateWatcher.ts, pages/Engine.tsx, shared/release.ts) | status, migration, ADR-0009 | rewrite; this should be the main contributor reference |
| backend-and-project.md | 117 | zh | reference | contrib/integrator | partly stale: L108 lists only layout/result kinds; `types.ts:1123` also has image/style, plus `upscale`; `/api/studio/import-image` and `/save-mask` are missing | multi-canvas §7 | keep, update |
| benchmarks/v2-mnn-spike.md | 84 | zh | research template | none | historical: the tables were never filled in | ADR-0001, future-engine | archive |
| decisions/0001 | 104 | zh | ADR | maint | superseded by 0009 (MNN on macOS) | 0003 | add a "superseded" line, archive |
| decisions/0002 | 128 | zh | ADR | maint | mostly current (external Trainer, `trainingEnabled`) | toolchain §5 | keep |
| decisions/0003 | 58 | zh | ADR | maint | superseded by 0009 (Python runner as the engine) | 0001 | mark superseded |
| decisions/0004 | 295 | zh | ADR | maint | superseded by 0007 (WebUI), 0008 (windows) and 0009 (Instances) | roadmap | mark superseded, archive |
| decisions/0005 | 271 | zh | ADR | maint | superseded by 0010 (already marked, L4) | archive/release-and-updates | archive |
| decisions/0006 | 231 | zh | ADR | maint | stale: L3 "未实现" (not implemented), yet `managedPython.ts` and `gitHealth.ts` exist; its instance/Gradio scope ended with 0009 | toolchain | mark partly superseded |
| decisions/0007 | 155 | zh | ADR | maint | partly current: Gradio is retired, but the WebUI is a separate `web/LayoutEditor`, not the shared components L54 promises | status | update status line |
| decisions/0008 | 35 | zh | ADR | maint | superseded: bottom tabs and canvas tabs (L13/L16) gave way to the titlebar menu (8b18255), then Rail + board. No ADR records this | product-design | mark superseded, new ADR |
| decisions/0009 | 21 | zh | ADR | maint | current, but L2 says NVIDIA only; Vulkan/HIP have no ADR | architecture | amend with a new ADR |
| decisions/0010 | 31 | en | ADR | maint | current | release.md | keep |
| design/gpu-device-management.md | 288 | zh | feature design | contrib | partly stale: NVIDIA only; the "引擎页/OOBE" UI it describes (L204/L196) is gone; no AMD/Vulkan | status, multi-canvas | trim to as-built |
| design/lora-support.md | 122 | zh | feature design | contrib | partly stale: L14/L45 "左栏 LoRA 行" (left-panel LoRA row); style-node LoRA merge not covered | backend | merge into a Studio doc |
| design/model-directories.md | 111 | zh | feature design | contrib | partly stale: L3 says file binding is still to do, but `mossInfer.ts:517` sends `dit_file` | model-management, status:30 | merge into model-management |
| design/multi-canvas-studio.md | 329 | zh | design + as-built | contrib | superseded by the 2.0 node board: rounds 2-3 are patched in at L29-30, but the body still describes the two-kind board with no inputs/control/mask | product-design, layout-schema | rewrite as a "Studio node board" doc |
| design/ui-rules.md | 102 | en | reference | contrib | current (all cited paths exist) | CONTRIBUTING, CLAUDE | keep |
| future-inference-engine.md | 245 | zh | future proposal | none | historical (written before MossInfer) | ADR-0001/0003 | archive |
| gbc-integration.md | 69 | zh | feature | contrib | stale: L25 describes a Studio「GBC 解析」panel; the renderer has no GBC UI, only IPC in `channels.ts:92-99` | status:32 | archive, or one line in architecture |
| issue-audit-2026-10-21.md | 59 | zh | audit (dated) | none | historical: PyTorch `torchBackend` from the Instance era | none | archive |
| layout-schema.md | 130 | zh | reference | integrator | §1-4 current (`lib/layout.ts`); §5 L117-120 is stale: the UI strings 编译布局 Prompt, 插入到 Prompt and 布局总览 no longer exist | product-design | keep, drop §5 |
| model-management.md | 52 | zh | reference | contrib | partly stale: Gradio and `instances:model-binding` (L5/L33/L37); L44 test file doesn't exist | model-directories | rewrite + merge |
| model-notes.md | 238 | zh | reference | integrator | current (facts; `tools/dev/budget.py` exists); the §9.3 diffusers/ComfyUI how-to is off-topic | none | keep, trim §9 |
| mossinfer-migration.md | 83 | zh | status | contrib | historical: L36 `/engines`; L66-73 "next stage" list, while `instances.ts` and `runtimes.ts` still exist | architecture §5 | move protocol notes into architecture, archive the rest |
| mossinfer-performance.md | 62 | zh | benchmark | user | current as a dated report | root README L73-95 | keep; README should link, not copy |
| product-design.md | 121 | zh | design (IA) | contrib | superseded: 3-column left/right layout L30-50; L97 says 8 settings sections, `sections.ts` has 7; L61 插入到 Prompt | multi-canvas, ADR-0008 | rewrite for 2.0 |
| release.md | 80 | en | how-to | maint | current (matches release.yml/nightly.yml; `PRODUCTION_UPDATE_KEYS` empty, as stated) | ADR-0010 | keep (L32 example says 1.0.3) |
| research/upstream-2026-10-20.md | 55 | zh | research | none | historical (Gradio/runner era) | survey | archive |
| research/upstream-survey.md | 75 | zh | research | none | historical | ADR-0001 | archive |
| roadmap.md | 281 | zh | roadmap | maint | historical: L19 "五窗口" (five windows); L9 puts electron-updater in P2 | status, ADR-0004 | archive; replace with a short list or GitHub issues |
| status.md | 89 | zh | status | maint | stale: L3-4 say 1.0.3 / 2026-11-03; L28 marks the installer ✅ but L36 marks it ⬜; L86 "发布 1.0.2" (publish 1.0.2); no node board, no Vulkan | README, architecture | rewrite |
| toolchain-and-onboarding.md | 85 | zh | how-to/feature | user | stale: L16-20 "底部「引擎」" (bottom tabs) and a floating checklist; the app now has a full-page `/setup` (`App.tsx:107`) | gpu-device | rewrite as a setup guide |
| windows-validation-guide.md | 102 | zh | how-to (QA) | maint | partly stale: L3/L12 say there is no installer; L7 bottom pages | status, release | rewrite as a release QA checklist |

## Problems in the docs/README.md index
- **Missing:** `roadmap.md`, `model-management.md`, `model-notes.md`, `issue-audit-2026-10-21.md`. The ADRs aren't listed one by one, only 0009 and 0010 are named.
- **Wrong:**
  - The "source of truth" list puts `mossinfer-migration.md` as #5, but it is a historical migration log.
  - `multi-canvas-studio` is labelled "已实现" (implemented), but the node board replaced it.
  - `model-directories` is labelled "1.0.3 设计" (1.0.3 design), but most of it is built.
  - `assets/` is called "不再代表当前 UI" (no longer the current UI), yet the root README uses two of those files.
  - The old-screenshot list names `creator`, which doesn't exist.
  - The test-machine table says "Linux 未验收" (Linux not verified), while CI now installs on 4 platforms.
- **Not followed:** maintenance rule 4 (update README, architecture and product-design when windows or pages change) was not applied for 2.0. Rule 1 (update `status.md` first) wasn't either.

## How the ADRs were superseded
- 0001 (MNN on macOS) → deferred by 0003 → replaced by **0009**, which says macOS has no local inference.
- 0003 (Python runner as the engine) → **0009**.
- 0004 has three successors: its "no WebUI" rule → **0007**; its windows and device manager → **0008**; its Instances → **0009**.
- 0005 → **0010**. This is the only supersession written down on both sides.
- 0006: its inference-toolchain scope was voided by 0009, and its status line still says "未实现" (not implemented) although the Trainer Python/Git checks exist.
- 0008 has been overtaken twice (titlebar menu, then Rail + node board) with no new ADR.
- Vulkan/HIP engines amend 0009, also with no ADR.
- 0001 still reads "已接受，V2 执行" (accepted, for V2).

## Asset usage
- Only two files in `docs/assets/` are referenced, both by the root README: `mossstudio-logo.svg` (README.md:2, current) and `screenshot-studio.png` (README.md:30, from 2026-11-01, shows the pre-2.0 multi-canvas workbench, so the front page is out of date).
- Nothing references `logo.jpg` or the 11 `.webp` files. Their names show UIs that no longer exist (home, instances, oobe, terminal, trainer, training, diagnostics, gallery, studio, settings). All 12 can go to `archive/` or be deleted.
- The release notes reference no assets.

## Root-level docs
- **README.md:** L36 says 1.0.1 is out and 1.0.2 is pending, while the app is 2.0.0. The CUDA badge says 12.x, but the default engine is CUDA 13. The platform badge leaves out macOS. L99 says an NVIDIA card is required, though Vulkan/AMD engines now exist. Step 1 of the quick start sends users to an 「引擎」 page that is now under 设置 › 设备与引擎. L164-165 is an empty code block. L73-95 copies `mossinfer-performance.md`.
- **CONTRIBUTING.md and CLAUDE.md:** current and accurate.
- **`release/README.md`:** the 1.0.3 release text; it still says installation happens on the 「引擎」 page.

## The 5 biggest problems for a human reader
1. **2.0 isn't documented at all.** Not the node board (filmstrip, 风格 (style) and 放大 (upscale) nodes, image/control/mask inputs, recipes), the Rail navigation, `/setup`, `/library` or the Activity panel.
2. **The engine story is wrong everywhere.** Every current doc, plus the README and ADR-0009, says NVIDIA/CUDA only. The code ships Vulkan (兼容模式) and AMD HIP (AMD 原生) engines (`shared/cliEngine.ts`, `engineChoice.ts`).
3. **The "source of truth" docs contradict themselves and the code.** `status.md` dates from 1.0.3 and marks the installer both ✅ and ⬜. `architecture.md` lists pages and files that don't exist. `roadmap.md` describes five windows.
4. **About a third of `docs/` is historical but sits beside current docs.** Superseded ADRs carry no "superseded by" line.
5. **Mixed language and heavy duplication.** The same facts appear in 3-5 places, and the copies have drifted apart (MossInfer packages; Project schema; model directories; performance numbers).
