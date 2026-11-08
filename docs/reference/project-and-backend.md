---
status: current
last-verified: 2026-11-08 (c3dc0ee)
code: apps/desktop/src/backend/index.ts, apps/desktop/src/main/services/backend.ts, apps/desktop/src/main/services/engineJobStart.ts, apps/desktop/src/main/services/projects.ts, apps/desktop/src/main/services/studioAssets.ts, apps/desktop/src/shared/types.ts, apps/desktop/src/shared/backend.ts, apps/desktop/src/renderer/src/web/main.tsx
---

# The backend and the project file

The backend is a small utility process that turns HTTP and WebSocket requests from the Studio and the LAN page into RPC calls to the main process. This doc is its contract: the routes it serves, the generation request, the events it broadcasts, and the on-disk form of a project (`ProjectDocument`, `schemaVersion: 3`). Paths are relative to `apps/desktop/src/`.

## 1. The process

`backend/index.ts` runs as an Electron utility process. `main/services/backend.ts` forks it at start (`startBackend`, `utilityProcess.fork`) and passes everything it needs in the environment:

| Variable | Value | From |
| --- | --- | --- |
| `CLOVER_BACKEND_TOKEN` | 24 random bytes, hex | generated per start |
| `CLOVER_BACKEND_HOST` | `0.0.0.0` when `Settings.lanWebEnabled`, else `127.0.0.1` | `shared/types.ts` (`Settings`) |
| `CLOVER_BACKEND_PORT` | `Settings.lanWebPort`, or `0` for an ephemeral port | same |
| `CLOVER_WEB_ROOT` | `out/renderer` of the app, the folder with `web.html` | `app.getAppPath()` |

The backend holds no state. Every API request becomes one `rpc(method, params)` message over `parentPort`; `handleRpc` in `main/services/backend.ts` dispatches the method to a main service and posts the result back. An RPC that does not answer within 120 seconds fails the request. Main pushes every `emit()` (`main/lib/events.ts`) to the backend, which rebroadcasts it to WebSocket clients (section 4).

Requests must carry the token as `Authorization: Bearer <token>` or `?token=<token>`. `/health` and the static files are the only exceptions; everything else answers `401 { "error": "unauthorized" }` without it. Responses carry `Access-Control-Allow-Origin: *`. A JSON body is limited to 2,000,000 characters; a picture or mask upload to 80 MB (`MAX_UPLOAD_BYTES`).

Errors are `{ "error": string, "code"?: string }`. `code` is the `E_*` code main raised (`main/lib/codedError.ts`). `E_INPUT*`, `E_IMAGE*` and `E_NOT_SUPPORTED` answer 400; any other failure 500; an unknown route 404.

Three clients use it:

| Client | Uses | Code |
| --- | --- | --- |
| The desktop Studio | `POST /api/engine-jobs` only. Projects go through IPC (`projects:*`, `electronStudioClient`), not HTTP. | `renderer/src/pages/studio/useGenerate.ts`, `renderer/src/lib/studioClient.ts` |
| The LAN page | Bootstrap, projects, jobs, gallery; see the known gap in section 2 | `renderer/src/web/main.tsx` |
| Self-test scenarios | `--scenario=backend-http`, `backend-renderer`, `backend-job` | `main/index.ts` |

## 2. HTTP routes

Every route the backend serves at c3dc0ee, in `handleRequest` order:

| Method and path | Token | RPC → main | Answer |
| --- | --- | --- | --- |
| `GET /`, `/web.html`, `/assets/*`, `/favicon*` | no | none (static from `CLOVER_WEB_ROOT`) | The LAN page |
| `GET /health` | no | none | `{ ok: true, service: 'clover-backend', version: 1 }` |
| `GET /api/jobs` | yes | `listJobs` → `supervisor.listJobs` | `JobRecord[]` |
| `GET /api/studio/bootstrap` | yes | `listProjects`, `listModels`, `listGallery { limit: 12 }` | `{ projects, instances: [], models, gallery }` |
| `GET /api/projects` | yes | `listProjects` → `projects.listProjects` | `ProjectSummary[]`, newest first |
| `POST /api/projects` | yes | `saveProject` → `projects.saveProject`, then `pruneProjectMasks` | The saved `ProjectDocument` |
| `GET /api/projects/<id>` | yes | `getProject` | `ProjectDocument` or `null` |
| `DELETE /api/projects/<id>` | yes | `deleteProject` | `true` |
| `GET /api/models` | yes | `listModels` → `models.getCatalog` | `Catalog` |
| `GET /api/gallery?cursor&limit&query&root` | yes | `listGallery` → `gallery.listGallery` | `GalleryPage`; `limit` defaults to 48 |
| `GET /api/jobs/<id>` | yes | `getJob` | `JobRecord` |
| `POST /api/studio/import-image?projectId=` | yes | `importImage` → `studioAssets.importImageBytes` | `{ path, width, height }`; body is the raw picture (PNG, JPEG or WebP) |
| `POST /api/studio/save-mask?projectId=&canvasId=` | yes | `saveMask` → `studioAssets.saveMask` | `{ path }`; body is the raw PNG, white = repaint |
| `POST /api/engine-jobs` | yes | `startEngineJob` → `engineJobStart.startRequestedEngineJob` | `JobRecord` (section 3) |
| `POST /api/jobs/<id>/cancel` | yes | `cancelJob` → `supervisor.cancelJob` | The cancelled `JobRecord`, or `null` for an unknown id |
| `GET /api/gallery/file?path=` | yes | `galleryFile` → `gallery.readGalleryFile` | The picture bytes with their MIME type |

`import-image` and `save-mask` exist for the LAN page, which has picture bytes and no local path; the desktop Studio imports through IPC (`studioAssets.importImageFile`). Both store the file in the project's `assets/` folder (section 5).

Routes from the runner era are gone: `POST /api/jobs` (submit a job to an instance) and `/api/instances` are not served and answer 404. `bootstrap.instances` is always `[]`.

Known gap: the LAN page still posts to `POST /api/jobs` (`renderer/src/web/main.tsx`, `generate`), and its save sends the pre-3 flat shape (`layers`, `width`, `height`, no `canvases`), which `saveProject` cannot read. So at c3dc0ee a generation from the LAN page fails before it is sent (no instance to pick) and would get 404 if it were sent, and saving a draft from the LAN page fails with 500. Reading projects, the gallery and the layout editor work. The `backend-renderer` and `backend-job` self-test scenarios in `main/index.ts` also post to `POST /api/jobs` and pick a runner instance; they are from the runner era too.

## 3. The generation request

`POST /api/engine-jobs` takes a JSON body in the shape of `StartEngineJobInput` (`main/services/supervisor.ts`) plus the picture inputs of `JobParams` (`shared/types.ts`). The exact field list is the type; the groups are:

| Group | Fields | Notes |
| --- | --- | --- |
| Where the job shows | `projectId`, `canvasId`, `canvasTitle`, `canvasLineage` | `canvasLineage` starts at the source 画面 (`kind: 'layout'`); one active job per canvas branch, a second is refused |
| Model | `modelBinding` (`ModelBinding`: `bundleId`, `dit`, `textEncoder`, `vae`), `modelName` | Local jobs resolve the bundle's files from the binding |
| Device | `deviceUuid` (local), or `hostId` + `remoteModelPath` + `deviceId` (远程主机) | A remote job needs both `hostId` and `remoteModelPath` |
| Picture | `prompt`, `negativePrompt`, `width`, `height`, `steps`, `cfg`, `seed`, `profile: 'base' \| 'dmd8'` | `prompt` must be non-empty; `profile` defaults to `base` |
| LoRA | `adapters: CanvasAdapter[]` (`id`, `strength`) | Ids are resolved to files in main (`adapterResolution.ts`); refused with `hostId` |
| Inputs | `initImage`, `mask`, `control`, `references`, `sampling` | `JobInitImage`, `JobMask`, `JobControl`, `JobReferences`, `JobSampling` in `shared/types.ts` |

`startRequestedEngineJob` is the one path from a request to a queued job, for HTTP and IPC alike:

1. `assertGenerationAllowed` (`main/update/gate.ts`): refused while the update feed's `minimumVersion` is above this build.
2. LoRA ids become files (`resolveCanvasAdapters`).
3. If the request has pictures or LoRA, the target engine's `EngineFeatures` are read; LoRA on an engine without `lora` is `E_NOT_SUPPORTED`.
4. Picture paths are validated against the allowed roots: the Library roots plus the project's `assets/` folder (`validateJobInputs`, `main/services/jobInputs.ts`).
5. `supervisor.startEngineJob` queues the job on its device; the answer is the `JobRecord` in state `queued` or `starting`.

What `prompt` contains is decided by the Studio, not the backend (`renderer/src/pages/studio/prompt.ts`, `compileCanvasPrompt`): a 画面 with visible regions sends the compiled layout JSON described in [layout-schema.md](/docs/reference/layout-schema.md); a 画面 without regions sends its description as plain text. Main passes the string to the engine as is.

Outputs: a local job writes to `<data root>/outputs/` (`paths.outputs()`); a remote job writes to the host's `outputRoot` (default `~/.mossstudio/outputs`) and main copies the picture back into the same local folder. The Library reads that folder; the data root is described in [architecture.md](/docs/reference/architecture.md#the-data-root).

## 4. WebSocket

`GET /ws?token=<token>` upgrades to a WebSocket; a missing or wrong token destroys the socket. The server sends `{ type: 'hello', service: 'clover-backend', version: 1 }` once, then `{ type: 'event', channel, payload }` for every event main emits. Channel names are the `Events` constants in `shared/channels.ts` (`event:job`, `event:job-log`, `event:gallery-changed`, `event:models-changed`, `event:settings-changed`, …); payloads are what the renderer receives over IPC for the same channel. The backend reads nothing from the client.

## 5. The project file

A project is a folder under the data root:

```text
<data root>/projects/<project-id>/
  project.json          the ProjectDocument
  assets/               pictures the project owns (section 5, Assets)
```

Ids match `PROJECT_ID_PATTERN` (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/`, `main/services/projects.ts`); new ones are `project-<8 hex>`. Anything else never reaches the filesystem.

### Schema

The schema is the type [`ProjectDocument`](/apps/desktop/src/shared/types.ts) in `shared/types.ts`, with `ProjectCanvas`, `ProjectLayer`, `CanvasInputs` and `CanvasUpscale` next to it. The Zod form used for IPC is `schemas.projectSave` in `shared/schemas.ts`. What a reader needs to know to recognise a file:

| Field | Meaning |
| --- | --- |
| `schemaVersion: 3` | The only version read (below) |
| `id`, `name`, `createdAt`, `updatedAt` | Set by main on save; `name` falls back to 未命名 Project |
| `canvases: ProjectCanvas[]` | One record per card on the board; everything a card needs (description, regions, inputs, sampling, model, device, job state, outputs) is on the canvas, nothing at the project level |
| `selectedCanvasId` | The card the Studio reopens on |
| `seriesId`, `page` | Group projects into a series of pages. Set from the LAN page's 系列 field; the Studio carries them through on save (`useStudioProject.ts`) |

`ProjectCanvas.kind` is one of:

| `kind` | UI | What the record holds |
| --- | --- | --- |
| `layout` | 画面 | The editable node: description (`prompt` and `summary.caption`, kept equal by `prompt.ts`), regions, `inputs`, `sampling`, `adapters`, `seed`. With `upscale: { scale }` it is a 放大 node, which redraws its 起始图 larger. |
| `result` | | A generated picture; `sourceCanvasId` points at its 画面, `generated` records the description and LoRA it was really run with, `pinned` keeps it as its own card, else it lives in the filmstrip |
| `image` | 原图 | A picture brought in from a file: `imagePath` into `assets/`, `imageSize` its real pixels (`width` and `height` are the card size) |
| `style` | 风格 | A description and LoRA that every 画面 wired to it through `inputs.styles` generates with |

Regions (区域) are `layers: ProjectLayer[]` on a canvas; their coordinate rules are in [layout-schema.md](/docs/reference/layout-schema.md). `x` and `y` are board pixels, written back by dragging. What each kind does on the board is in [studio-node-board.md](/docs/reference/studio-node-board.md).

### Versioning and compatibility

- `readProject` accepts a file only when `schemaVersion === 3` and `canvases` is an array. Any other file returns `null`: the folder stays on disk and the project is not listed. There is no migration from versions 1 and 2, the grid board's formats.
- Within version 3, new fields are added as optional and readers tolerate their absence. `ProjectCanvas` has grown this way (`inputs`, `upscale`, `generated`, `pinned`, `shownOutput`, `baseSize`, `seedLocked`). A change that gives an existing field a new meaning, or that old readers would misread, needs a new `schemaVersion` and a decision about reading the old one.
- `prompt` and `summary.caption` are both kept and both read: new canvases write the description to both, older ones used `prompt` for plain runs and `summary.caption` for region runs (`prompt.ts`, `canvasDescription`).

### Saving

`saveProject(SaveProjectInput)` takes `{ id?, name, canvases, selectedCanvasId?, seriesId?, page? }` and nothing else; main owns `id`, `createdAt`, `updatedAt` and the fallbacks for `name` and `selectedCanvasId`. The file is written to `project.json.tmp` and renamed into place. A `backgroundPath` outside `assets/` is copied in on save. After a save, mask files no canvas references are deleted, unless a queued or running job still reads them (`pruneProjectMasks`, `activeJobInputPaths`). Over IPC the input is validated by `schemas.projectSave` (at most 1000 canvases); over HTTP it is passed to `saveProject` unvalidated.

### Assets

`main/services/studioAssets.ts` writes two kinds of file into `assets/`, both named by a 24-hex-digit SHA-256 prefix of their bytes, so the same picture is stored once and no name can leave the folder:

| File | Written by | Rules |
| --- | --- | --- |
| `<hash>.png` or `<hash>.jpg` | `importImageBytes`, `importImageFile` | PNG, JPEG or WebP in; WebP is re-encoded to PNG because the engine reads PNG and JPEG only. At most 80 MB and 16384 px on a side. |
| `mask-<canvasId>-<hash>.png` | `saveMask` | PNG only, at most 32 MB. Referenced from `inputs.mask.path`. Deleted when unreferenced (`releaseMask`, `pruneProjectMasks`). |

### Summaries

`ProjectSummary` (`GET /api/projects`, `projects:list`) is derived on read: `width` and `height` of the first `layout` canvas (else the first canvas, else 1024), `layerCount` summed over every canvas, and the project's `seriesId`, `page` and `updatedAt`.

## 6. Data boundaries

- A project refers to models by `modelBundleId` and to devices by `deviceUuid` or `deviceId`. Model files are never copied into a project.
- Generated pictures live in `outputs/` and are referenced from `ProjectCanvas.outputs` by path. Deleting a project removes its folder, `assets/` included, and nothing in `outputs/`; the Library (作品) owns those.
- Training data lives under `trainer/` and never enters a project.
- A job's picture inputs may only come from the Library roots or the project's own `assets/` (section 3, step 4).
