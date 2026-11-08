---
status: current
last-verified: 2026-11-08 (fec4fe3)
code: apps/desktop/src/main/index.ts, apps/desktop/src/main/windows.ts, apps/desktop/src/main/ipc.ts, apps/desktop/src/main/lib/paths.ts, apps/desktop/src/main/install/, apps/desktop/src/main/update/, apps/desktop/src/preload/index.ts, apps/desktop/src/renderer/src/App.tsx, apps/desktop/src/renderer/src/components/shell/routes.ts, apps/desktop/src/renderer/src/pages/settings/sections.ts, apps/desktop/src/shared/channels.ts, apps/desktop/src/shared/agent/, apps/desktop/src/backend/index.ts, apps/desktop/src/main/services/backend.ts
---

# Architecture

MossStudio is an Electron app: a main process that owns engines, models, jobs and files; a sandboxed React renderer with two windows; and a small utility process that serves HTTP and WebSocket for the Studio's generation requests and the LAN web page. This is the contributor's map: where each piece lives and how the pieces talk. Details live in the docs it links.

Paths in this doc are relative to `apps/desktop/src/` unless they start with `apps/` or `docs/`. The repository layout and the commands are in [CONTRIBUTING.md](/CONTRIBUTING.md).

## Processes

| Process | Entry | Role |
| --- | --- | --- |
| Main | `main/index.ts` | Boot, run modes, windows, IPC, every service: engines, models, jobs, projects, SSH, updater, installer. The only process that touches the file system, the network and child processes. |
| Preload | `preload/index.ts` | Exposes `window.clover` to the renderer: `invoke(channel, payload)`, `on(channel, cb)`, `pathForFile(file)`, plus `platform`, `version`, `windowKind` and `channel`. Windows are created with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (`main/windows.ts`). |
| Renderer | `renderer/src/main.tsx`, `App.tsx` | React with a `HashRouter`. One bundle serves both windows; `window.clover.windowKind` picks the shell. |
| Backend | `backend/index.ts` | A Node utility process (`utilityProcess.fork` in `main/services/backend.ts`) with an HTTP and WebSocket server. It holds no state: every request becomes an RPC message to main over `parentPort`. See [The backend and the LAN web UI](#the-backend-and-the-lan-web-ui). |
| Launcher | `apps/launcher/main.go` | A Go binary outside Electron on Windows and Linux: setup stub, launcher that picks the version to start, and uninstall finisher. See [Install, update and run modes](#install-update-and-run-modes). |

The build (`apps/desktop/electron.vite.config.ts`) has two main entries, `index` and `backend`, and two renderer pages, `renderer/index.html` for the app and `renderer/web.html` for the LAN page. `@shared` resolves to `shared/`, the types and contracts both sides import.

## Windows and run modes

`main/windows.ts` knows two `BrowserWindow`s (`WindowKind`):

| Kind | Route | Size | Title |
| --- | --- | --- | --- |
| `studio` | `/studio` | 1600 × 1000, minimum 1024 × 640 | MossStudio |
| `trainer` | `/trainer` | 1280 × 840, minimum 960 × 600 | Kohaku Trainer |

The studio window opens at start; the trainer window opens from 训练 through `window:open`. On Linux the window is frameless and the renderer draws the title bar (`components/shell/Titlebar.tsx`, `window:control`, `event:window-state`); Windows uses a hidden title bar with an overlay, macOS `hiddenInset`. Two more windows exist outside the app proper: the setup and uninstall windows (`createInstallWindow` in `main/install/app.ts`) load the same renderer at `/install` and `/uninstall`, which `App.tsx` renders standalone without settings, models or jobs.

How the process was started decides paths and behaviour (`RunMode` in `main/install/runContext.ts`):

| Mode | When | Data root |
| --- | --- | --- |
| `dev` | Not packaged (`pnpm dev`) | `.dev-data/` at the repository root (`main/index.ts` sets `userData`) |
| `setup` | `--moss-setup=<payload>` from the setup stub, `--moss-silent`, or a macOS bundle run from a DMG | A throwaway temp folder; setup never touches user data |
| `uninstall` | `--moss-uninstall`, passed on by the launcher | The install's |
| `installed` | Under an install root R with `install.json` | `install.json` `dataRoot`, by default `R/data` |
| `portable` | `portable.json` in R | `R/data` |
| `loose` | Packaged but none of the above | Electron `userData` |

`main/install/dataRoot.ts` gives the full order; `MOSSSTUDIO_DATA` overrides everything. Setup and uninstall take over the process before anything else runs (`runInstallMode`), then the normal app takes the single-instance lock (`main/install/singleInstance.ts`): a second start hands its arguments to the running app, which focuses its window. Test switches: `--smoke` prints an environment summary and exits, `--screenshot` writes `screenshot-*.png` into the user data folder, `--scenario=<name>` runs one of the hermetic scenarios in `main/index.ts` against a fake engine.

Start order in `main/index.ts` (`whenReady`): install mode, lock, data folders, engine install recovery, legacy archive, the `clover://` protocol that serves pictures to the renderer (`main/services/gallery.ts`), `registerIpc` (which also starts engine auto-update and the startup engine plan), the backend, on macOS a pending app update (`installPendingAtStart`, which hands off and quits), then the studio window, GPU inventory and telemetry, and the updater. `before-quit` closes SSH terminals, the updater, the backend and every engine process.

## Routes

The Rail (`components/shell/Rail.tsx`) lists `PRIMARY_ROUTES` from `components/shell/routes.ts`; 活动 and 设置 sit at its bottom. Pages stay mounted once visited (`PageHost` in `App.tsx`); unknown paths show `/studio`.

| Route | Page | Shown |
| --- | --- | --- |
| `/studio` | 创作, `pages/Studio.tsx` → `pages/studio/StudioPage.tsx` | Always; the default |
| `/library` | 作品, `pages/Library.tsx` | Always |
| `/models` | 模型, `pages/Models.tsx` | Always |
| `/training` | 训练, `pages/Training.tsx` | When `Settings.trainingEnabled` |
| `/settings/<section>` | 设置, `pages/Settings.tsx` | From the Rail's bottom button |
| `/setup` | 准备开始创作, `pages/Setup.tsx`, full page without the Rail | While `Settings.onboardingState` is `pending` the app redirects here. 开始下载 installs the engine plan and the recommended model as one preparation (`lib/preparation.ts`); the Studio's 生成 button shows the same progress while it runs (`lib/usePreparation.ts`) |

Settings sections (`pages/settings/sections.ts`): `general` 通用, `devices` 设备与引擎, `storage` 存储, `network` 网络, `features` 功能, `updates` 通知与更新, `about` 关于. Bare `/settings` and unknown names open 通用; older names (`engine`, `engines`, `remote`, `hosts`, `lan`, `alerts`, `notifications`, `diagnostics`, `appearance`) map to the current section (`ALIASES`).

Old routes redirect (`LEGACY_REDIRECTS`): `/gallery` → `/library`; `/engines`, `/devices`, `/instances` → `/settings/devices`; `/diagnostics` → `/studio` and opens the Activity panel's 问题 tab. The Activity panel (`components/shell/ActivityPanel.tsx`, state in `lib/shell.ts`) has the tabs `jobs`, `notifications` and `problems`. The trainer window ignores the route and renders `pages/TrainerWindow.tsx`. The Studio itself is described in [studio-node-board.md](/docs/reference/studio-node-board.md); the navigation decision is [ADR-0011](/docs/decisions/0011-rail-navigation-and-node-board.md).

## Renderer folders

| Folder | Holds |
| --- | --- |
| `renderer/src/components/ui.tsx`, `components/common/`, `components/form.tsx` | The shared primitives every page uses ([ui-rules.md](/docs/reference/ui-rules.md)) |
| `components/shell/` | Rail, Titlebar, ActivityPanel, routes |
| `components/update/` | The update chip and its model |
| `pages/studio/` | The node board: cards, wires, ports, runs, recipes, assistant |
| `pages/library/`, `pages/models/`, `pages/settings/`, `pages/setup/`, `pages/training/`, `pages/install/` | One folder per page; `pages/<Name>.tsx` is the page's entry |
| `pages/Terminal.tsx` | The SSH terminal sheet opened from 远程主机 |
| `lib/api.ts` | `call(channel, payload)` and `onEvent(channel, cb)` over `window.clover` |
| `lib/` | Page-independent logic: `shell.ts` (Activity state and the assistant's plan preview), `features.ts` (optional features), `preparation.ts` (first-run progress), `studioClient.ts`, `layout.ts`, `format.ts` |
| `lib/agent/` | The assistant's tool executor: `executor.ts` runs each tool from `shared/agent/registry.ts` against the live Studio (`StudioToolApi` in `types.ts`); `lib/agentTools.ts` is the bridge the Studio registers itself with |
| `store.ts` | App-wide state: settings, notifications, diagnostics |
| `web/` | The LAN web page, a separate small app |

## Main process services

`main/services/` is flat; this is how the files group.

| Area | Files |
| --- | --- |
| Engines | `engineMachine.ts`, `enginePlan.ts`, `engineInstalls.ts`, `engineReadiness.ts`, `engineFeatures.ts`, `engineAutoUpdate.ts`, `engines.ts`, `mossInferDownload.ts`, `cudaWheels.ts`, `systemCuda.ts`, `mossInfer.ts`, `cliEngine.ts`, `weightPrecision.ts`; `main/lib/engineStore.ts`, `engineActivation.ts`, `engineAssets.ts`, `probeEngine.ts`, `cliProtocol.ts`, `vulkanDevices.ts`, `amdGpus.ts`, `gpuInventory.ts` |
| Jobs | `supervisor.ts` (job records, slots, queues, dispatch), `engineJobStart.ts` (the one entry for generation requests), `jobInputs.ts`, `generateParams.ts`, `jobPreview.ts`, `adapterResolution.ts` |
| Devices | `devices.ts` (nvidia-smi inventory), `gpuTelemetry.ts` |
| Models | `models.ts`, `modelFiles.ts`, `modelBundles.ts`, `modelScan.ts`, `modelImports.ts`, `modelReadiness.ts`, `controlAdapters.ts`, `hfCredentials.ts`, `hfNetwork.ts` ([models.md](/docs/reference/models.md)) |
| Projects and pictures | `projects.ts`, `studioAssets.ts`, `gallery.ts`, `galleryMeta.ts`, `imageHeaders.ts` ([project-and-backend.md](/docs/reference/project-and-backend.md)) |
| Remote hosts and SSH | `ssh.ts`, `sshSessions.ts`, `sshCredentials.ts`, `sshHostKeys.ts`, `sshTools.ts`, `trainingHosts.ts`, `remoteEngine.ts`, `remoteEngineInstall.ts`, `remoteCuda.ts`, `remoteModels.ts`, `remoteDownloads.ts`, `remoteModelDelete.ts`, `remoteResources.ts`, `remoteTrainer.ts` |
| Trainer | `trainers.ts`, `trainerEnv.ts`, `trainerGit.ts`, `trainerArtifacts.ts`, `managedPython.ts`, `gitHealth.ts`, `git.ts` |
| App | `settings.ts`, `diagnostics.ts`, `desktopNotifications.ts`, `network.ts`, `env.ts`, `onboarding.ts`, `ai.ts` (assistant providers and chat), `gbc.ts`, `gbcGit.ts`, `githubCredentials.ts`, `backend.ts` |
| Leftovers from the runner era | `instances.ts`, `remoteInstances.ts`, `runtimes.ts`, `cases.ts`, `launchQueue.ts`, `legacyMigration.ts`. Their pages are gone; some IPC handlers remain. |

## IPC and events

Channel names live in `shared/channels.ts`: `Ipc` for request and response (`area:action`, for example `engine:plan`, `projects:save`) and `Events` for pushes from main (`event:job`, `event:settings-changed`, …). `main/ipc.ts` registers every handler through `handle(channel, schema, fn)`: the payload is validated with the Zod schema of the same name in `shared/schemas.ts` (`null` for channels without input), and the answer is an `IpcResult<T>`, `{ ok: true, data }` or `{ ok: false, error: { code, message } }`, so a renderer never sees a thrown exception. A Zod failure becomes `BAD_REQUEST`; services throw `codedError('E_…')` (`main/lib/codedError.ts`) for codes the UI acts on. The renderer calls `call<T>(channel, payload)` (`lib/api.ts`), which throws `ApiError` with that code. At fec4fe3 `registerIpc` registers 146 handlers; the install and uninstall channels are registered separately by `main/install/app.ts`.

The assistant's tools cross this boundary the other way. `shared/agent/` is the tool rack: `schemas.ts` holds one Zod schema per tool (`TOOL_SCHEMAS`, the only place a tool's arguments are written down), `registry.ts` lists every tool with its pack, risk and summary (`AGENT_TOOLS`, `resolveToolset`, `toolDefinitions`, which generates the provider's JSON Schema), and `cards.ts` defines the cards a tool can put in the chat (`choice`, `plan`, `confirm`) and their answers. `main/services/ai.ts` runs the chat with a provider and relays each tool call to the window that asked (`event:ai-tool-call`, with the conversation's `mode`, `auto` or `advanced`); the renderer executes it (`lib/agent/executor.ts`) and answers over `ai:tool-result`; a card's answer comes back over `ai:card-answer`. In `advanced` mode writes are held back and main gathers them into one plan card for the user to confirm. Constants from the retired instance and runtime pages (`instances:*`, `runtime:*`, `cases:*`, `git:*`, `jobs:start`) are still declared and have no handler.

Events go through `emit(channel, payload)` in `main/lib/events.ts`, which sends to every open window and to `onEmit` listeners; the backend subscribes and rebroadcasts over WebSocket. The renderer listens with `onEvent(channel, cb)`.

## The backend and the LAN web UI

`main/services/backend.ts` forks `backend/index.ts` at start with a random bearer token, the host (`127.0.0.1`, or `0.0.0.0` when `Settings.lanWebEnabled`), the port (`Settings.lanWebPort`, else ephemeral) and the renderer output folder as web root. Every request needs `Authorization: Bearer <token>` or `?token=`, except `/health` and the static files. The backend answers by RPC to main (`handleRpc`); main pushes every event to it and the backend broadcasts them on `/ws?token=` as `{ type: 'event', channel, payload }`.

| Route | Does |
| --- | --- |
| `GET /health` | `{ ok, service: 'clover-backend', version: 1 }` |
| `POST /api/engine-jobs` | Start a generation (`startRequestedEngineJob`). The desktop Studio uses this too (`pages/studio/useGenerate.ts`), not IPC. |
| `GET /api/jobs`, `GET /api/jobs/<id>`, `POST /api/jobs/<id>/cancel` | Jobs |
| `GET /api/projects`, `POST /api/projects`, `GET` and `DELETE /api/projects/<id>` | Projects |
| `POST /api/studio/import-image?projectId=`, `POST /api/studio/save-mask?projectId=&canvasId=` | Picture bytes into a project's assets |
| `GET /api/models`, `GET /api/gallery`, `GET /api/gallery/file?path=` | Catalog and Library |
| `GET /api/studio/bootstrap` | Projects, models and the first gallery page for the web page |
| `GET /` → `/web.html` and static assets | The LAN page |

The LAN page (`renderer/src/web/main.tsx` with `web/LayoutEditor.tsx`) is a separate small app for a phone or another computer on the same network, turned on in 设置 › 功能 › 局域网访问, which shows the URLs and access code (`web:access-info`). It shares `components/ui` and `lib/layout` with the desktop and nothing else. At fec4fe3 its generate button posts to `POST /api/jobs`, a route the backend no longer serves, and the bootstrap's `instances` list is always empty, so generating from the LAN page fails; projects, pictures and the layout editor work. The HTTP contract is in [project-and-backend.md](/docs/reference/project-and-backend.md).

## The data root

`main/lib/paths.ts` builds every path from the data root (see [run modes](#windows-and-run-modes)). What lives there:

| Path | Content | Owner |
| --- | --- | --- |
| `settings.json` | `Settings` (`shared/types.ts`) | `services/settings.ts` |
| `hosts.json` | Remote hosts (`TrainingHost[]`) | `services/trainingHosts.ts` |
| `announcements.json`, `diagnostics.json`, `control-adapters.json`, `engine-auto-update.json`, `remote-downloads.json` | Small state files, one per service | the service of that name |
| `*-credentials.json`, `ssh/` | Saved tokens and passwords (SSH passwords through Electron `safeStorage`) and SSH host keys | `services/*Credentials.ts`, `sshHostKeys.ts` |
| `projects/<id>/` | One folder per project with `assets/` for imported pictures and masks | `services/projects.ts`, `studioAssets.ts` |
| `jobs/jobs.json`, `jobs/<id>.jsonl` | Job records and one log per job | `services/supervisor.ts` |
| `outputs/` | Generated pictures with their JSON sidecars; the Library reads them | `services/gallery.ts` |
| `models/` | Default models root; a custom `Settings.modelsRoot` replaces it ([models.md](/docs/reference/models.md)) | `services/models.ts` |
| `mossinfer/` | Engine root: one folder per installed package, `.staging`, `.backup`, `.probe`, `machine.json`, `external.json`, `last-attempt.json` ([engines.md](/docs/reference/engines.md)) | engine services |
| `cache/` | `mossinfer/` (the engine's cache), `previews/` (live previews), `trainer-artifacts/` | various |
| `trainer/` | Trainer git mirror, versions and runtimes ([ADR-0002](/docs/decisions/0002-trainer-backend.md)) | trainer services |
| `ai/agent.json`, `gbc/` | Assistant providers and conversations; GBC runs | `services/ai.ts`, `gbc.ts` |
| `logs/`, `downloads/` | Logs and in-flight downloads | |
| `git/`, `instances/`, `runtimes/`, `launch-queue.json`, `cases.json` | Runner era; archived on first start by `services/legacyMigration.ts` | leftovers |

## Install, update and run modes

[ADR-0010](/docs/decisions/0010-own-installer-and-signed-updates.md) made the app its own installer and updater. An install root R holds the launcher, one `app-<version>/` folder per version, `data/` and `install.json` (`installRecordSchema` in `shared/install.ts`: `root`, `dataRoot`, `portable`, `channel`, `current`, `previous`, `pending`, `failed`, `confirmed`); on macOS R holds `MossStudio.app` and hidden previous bundles. `main/install/` is the setup state machine (`controller.ts`), its Electron glue and windows (`app.ts`), the layout rules per OS (`layout.ts`), the record IO (`record.ts`), the registry on Windows (`registry.ts`) and the uninstall (`uninstall.ts`). The setup and uninstall UI is `pages/install/` with the types in `shared/setup.ts`.

`main/update/` is the updater: it reads the Ed25519-signed feed `update-<channel>.json` (`feed.ts`, `verify.ts`; keys in `shared/updateKeys.ts`), checks on start, every six hours and on window focus (`schedule.ts`), downloads with resume (`download.ts`), materialises `app-<v>` (`materialize.ts`), writes `pending` into `install.json`, and restarts through the launcher when nothing is busy (`busy.ts`: inference, training, model and engine downloads, git clones). The launcher switches `pending` to `current` and rolls back when the new version fails its health check (`health.ts`); on macOS, which has no launcher, `installPendingAtStart` runs the same swap helper at the next start, from a confirmed version only. The UI is `components/update/` and 设置 › 通知与更新; the state type is `UpdaterState` in `shared/update.ts`. How releases are built and signed is in [how-to/release.md](/docs/how-to/release.md).

Updates are quiet by default. With 自动更新 on (`Settings.autoDownloadUpdates`), a new version downloads in the background and installs at the next start without a word; the title-bar chip (`components/update/updateModel.ts`, `chipView`) shows only 必须更新 (this version may no longer generate, `minimumVersion`), 新版本没能启动 (a rolled-back version), a restart the user asked for, and a quiet 重启以更新 once a downloaded update has waited three days (`READY_NUDGE_MS`, from `UpdaterState.readyAt`). The first start of a newer version says 已更新到 <version> once, with a link to its release notes (`UpdaterState.updatedFrom`, from `Settings.lastRunVersion`). With 自动更新 off, every step shows, since the user installs by hand.

## Engines

Generation runs in MossInfer, a native engine installed per GPU: a long-lived `moss-server` per NVIDIA GPU, or the one-shot `moss-infer-vulkan` (兼容模式) and `moss-infer-hip` (AMD 原生) programs for other GPUs, text to image only. The main process detects the machine, chooses and installs a package per GPU, keeps one job slot per GPU and per remote host, and settles the tier from the model's weights. All of that, including remote SSH hosts, is in [engines.md](/docs/reference/engines.md); the protocol belongs to the [MossInfer repository](https://github.com/mossimage-cpp/mossimage.cpp).

## GBC

KohakuGBC is an optional external tool reachable only through IPC (`gbc:*` in `shared/channels.ts`, `shared/gbc.ts`, `main/services/gbc.ts`); no renderer code calls it at fec4fe3.

## Leftovers

- The runner-era services, channels and data folders listed above still exist without a UI.
- `--screenshot` captures `/instances`, `/devices`, `/gallery` and `/diagnostics`, which now redirect, so some of its pictures duplicate others.
- The LAN page cannot start a generation (see [the backend](#the-backend-and-the-lan-web-ui)).
