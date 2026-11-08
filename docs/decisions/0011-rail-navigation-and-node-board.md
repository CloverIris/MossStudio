---
status: proposed
date: 2026-11-08
supersedes: ADR-0008
amends: ADR-0007
---

# ADR-0011: Rail navigation and the node board replace the dock layout

## Context and problem statement

ADR-0008 (2026-10-22) gave MossStudio one Studio window with page tabs along the bottom, a three-column creation page with dockable panels, canvas tabs above the canvas and a terminal drawer. Between then and 2.0 the shell was rebuilt twice without a decision record. On 2026-10-26 the bottom tabs moved into a title-bar menu (commit 8b18255, `components/PageNavigation.tsx`). On 2026-11-04 the whole frame was replaced by a left rail, an Activity panel and a full-page first-run setup (commit 6ebea87, PR #25). PR #43 (2026-11-08) then replaced the creation page itself with a node board. The question: what navigation and creation layout does 2.0 ship, and what from ADR-0007 and ADR-0008 still holds?

## Decision drivers

- The app is for people who have never used a generation tool; management screens must not compete with the work. ADR-0008 already asked for "启动即进入创作".
- Panels that can be dragged, docked and resized gave each user a different screen, which made the UI hard to document, test and support. ADR-0008 never persisted their state.
- Canvas tabs hid results: a run's output went to the gallery, and comparing runs meant switching tabs.
- Jobs, notifications and diagnostics each had their own surface: a terminal drawer, a flyout and a Diagnostics page.
- Optional features (training, remote hosts, LAN access) should disappear from the UI when they are off.

## Considered options

1. Keep the ADR-0008 layout (bottom page tabs, dockable panels, canvas tabs) and refine it.
2. Move the page tabs into the title bar and keep everything else. This is what commit 8b18255 did.
3. A left rail with a few work destinations, one Activity panel, settings as a page, and the Studio as a free-form board with one board per project.
4. A full node graph in the ComfyUI style, where every processing step is a node the user wires.

## Decision outcome

Chosen option: 3. Option 1 kept management on screen all the time and left the layout per user and unpersisted. Option 2 shipped for nine days and only moved the problem: the menu still listed seven management pages (引擎, 模型, 设备, 训练, 画廊, 诊断, 设置) beside 创作. Option 4 contradicts the goal PR #43 states, a beginner-friendly board: cards show pictures and a few typed inputs, and the engine's steps are never exposed as nodes.

As built at f727e95:

- **Rail.** `apps/desktop/src/renderer/src/components/shell/Rail.tsx` lists the routes of `components/shell/routes.ts`: `/studio` 创作, `/library` 作品, `/models` 模型 and `/training` 训练, the last one only when `settings.trainingEnabled` is on. 活动 and 设置 sit at the bottom of the rail. `/settings/*` has seven sections (`pages/settings/sections.ts`: 通用, 设备与引擎, 存储, 网络, 功能, 通知与更新, 关于). Old routes redirect through `LEGACY_REDIRECTS`: `/gallery`, `/engines`, `/devices`, `/instances`, `/diagnostics`.
- **Activity panel.** `components/shell/ActivityPanel.tsx` has three tabs, `jobs`, `notifications` and `problems` (`lib/shell.ts`). It replaces the terminal drawer, the notifications flyout and the Diagnostics page. The old `openWindow('terminal')` intent opens the jobs tab (`App.tsx`, `useWindowIntents`).
- **Setup.** `/setup` renders as a full page without the rail (`App.tsx`, `StudioShell`), and `onboardingState: 'pending'` sends the app there until the computer is prepared.
- **Title bar.** `components/shell/Titlebar.tsx` draws the window controls on frameless platforms, a GPU performance monitor and the page's own context; the Studio puts its project switcher there (`pages/studio/ProjectSwitcher.tsx`).
- **One board per project.** `pages/studio/Board.tsx` draws a `ProjectDocument` (`apps/desktop/src/shared/types.ts`) as cards on a free-form board: canvases of kind `layout`, `result`, `image` and `style`, wired through typed ports (`pages/studio/ports.ts`, `links.ts`). Runs of a 画面 collect in its filmstrip (`runs.ts`) until pinned. There are no canvas tabs, no dockable panels and no project manager page. Settings for the selected card live in fixed panels (`ParamsPanel.tsx`, `InspectorPanel.tsx`).
- **Windows.** `apps/desktop/src/main/windows.ts` still knows two `BrowserWindow`s, `studio` and `trainer`. That part of ADR-0008 stands.
- **Web UI.** The LAN page is a separate small app, `renderer/src/web/main.tsx` with `web/LayoutEditor.tsx`, served by `src/backend/index.ts` as `/web.html`. It shares only `components/ui` and `lib/layout` with the desktop; the Studio pages are never loaded there. ADR-0007 section 2.3 planned one feature layer behind a `StudioClient` transport for both; that plan was not built and is withdrawn by this ADR. The rest of ADR-0007 (one end-user UI, the official Gradio retired) stands.

### Consequences

- Good: a new user sees four destinations and a board; management is one click away and never in the way. Every user sees the same layout, so screenshots, E2E specs (`apps/desktop/e2e/specs/shell.e2e.ts`, `board.e2e.ts`) and support answers match what is on screen.
- Good: runs stay next to the 画面 that made them; comparing and reusing them is a drag on the board.
- Bad: people who liked arranging panels lose that freedom. Panel positions are not a setting.
- Bad: a board needs more room than a form. PR #43 made windows smaller than 1280 × 760 fit, but nothing collapses.
- Bad: the web UI and the desktop Studio drift, since they share only primitives.

## More information

- PR #25 (merge de337c4, 2026-11-04): the rail, Activity panel, Setup and Settings restructure.
- PR #43 (merge f727e95, 2026-11-08): the node board.
- Commit 8b18255 (2026-10-26): the title-bar menu, removed again in 6ebea87.
- `docs/design/multi-canvas-studio.md`: the board's design history and as-built notes before 2.0.
- Supersedes [ADR-0008](0008-studio-window-and-dock.md). Amends [ADR-0007](0007-mossstudio-single-ui-and-web.md), section 2.3.
