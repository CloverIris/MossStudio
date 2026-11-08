---
status: current
last-verified: 2026-11-08 (d0883df)
code: apps/desktop/src/, apps/desktop/test/, apps/desktop/e2e/, apps/launcher/
---

# Coding standards

Rules a reviewer checks by reading the diff, because no tool checks them. Anything ESLint, Prettier or `tsc` can enforce is not here; see [What lint already checks](#what-lint-already-checks). UI rules are in [ui-rules.md](ui-rules.md) and are not repeated.

Paths are relative to the repository root. Each rule names the reason in a few words and, where it helps, one file that does it right.

## 1. Process boundaries

| Folder | Holds | Example |
| --- | --- | --- |
| `apps/desktop/src/main/` | Electron main: windows, IPC handlers, services, child processes, files | `src/main/services/supervisor.ts` |
| `apps/desktop/src/renderer/src/` | React UI. Talks to main only through `window.clover` | `src/renderer/src/lib/api.ts` |
| `apps/desktop/src/shared/` | Types, channels, zod schemas, pure helpers used by more than one process | `src/shared/engineProtocol.ts` |
| `apps/desktop/src/preload/` | The `contextBridge` surface (`invoke`, `on`, `pathForFile`, platform facts) and nothing else | `src/preload/index.ts` |
| `apps/desktop/src/backend/` | The LAN HTTP/WebSocket utility process; relays to main over `parentPort` | `src/backend/index.ts` |

- A new IPC call adds a channel to `Ipc` in `src/shared/channels.ts` and a handler in `src/main/ipc.ts` through `handle(Ipc.x, schema, fn)`. One registry, one place to read what the renderer can ask for. (The setup window has its own small `handle` in `src/main/install/app.ts`; do not add a third.)
- A channel that takes a payload has a schema in `src/shared/schemas.ts`, passed to `handle`. Today 94 channels validate and the 50 with `null` read no input; keep it that way. Reason: the payload comes from a web page.
- Main pushes to the renderer through `emit(Events.x, payload)` in `src/main/lib/events.ts`, never `webContents.send` directly. Every window and the backend relay get the event.
- `src/shared` imports nothing from `electron`, `node:*` or another process folder. It is bundled into the renderer.
- A type that crosses IPC lives in `src/shared/types.ts` (or a topic file such as `src/shared/update.ts`) and its schema in `schemas.ts`. When you change one, change the other in the same commit; they are written by hand, not inferred.
- Renderer code calls `call<T>(Ipc.x, payload)` from `src/renderer/src/lib/api.ts` and gets a typed result or an `ApiError` with the `E_*` code. Do not call `window.clover.invoke` elsewhere.

## 2. Errors the user sees

- Throw with `codedError('E_SOMETHING', message)` from `src/main/lib/codedError.ts` when the renderer or the backend may need to react to the kind of failure. `src/main/install/install.ts` is the model. Do not put the code in the message text (`new Error('E_DEVICE: …')`); it never reaches `error.code`.
- The message says what happened and what to do next, in plain Chinese, naming the thing the person knows (显卡, 引擎, 模型): `'缺少安装文件。请重新运行安装程序。'`. Raw detail (exit codes, paths, stderr) goes to the log or the `detail` field, not the sentence.
- A thrown message that only a developer will ever read (smoke tests, internal invariants) may be English. If it can reach a toast, a `Notice` or the setup error page, it is Chinese.
- A swallowed error carries a one-line reason in the `catch`: `catch { // missing or unreadable: no remote hosts configured }` (`src/main/services/settings.ts`). All 69 comment-only catches in `src/main` do this; an empty `catch {}` is a review finding.
- A background failure that the user does not see is still logged: `console.warn('[engine-plan]', message)`. The `[module]` prefix is the convention.

## 3. Child processes and the engine

- Every spawned process has one owner that ends it: a module-level map or runtime record with a `kill`, and a hook in `app.on('before-quit')` in `src/main/index.ts` (`shutdownMossInfer`, `shutdownCliEngines`, `closeAllSshTerminals`, `stopBackend`). A new long-lived process joins that list in the same PR.
- A process started for one job is closed when the job ends, in every exit path (done, failed, canceled). `runRemoteEngineJob` in `src/main/services/remoteEngine.ts` sends `shutdown`, closes stdin, and kills the SSH session after `REMOTE_SHUTDOWN_TIMEOUT_MS`. The remote-session leak fixed in `fix(engine): close remote sessions after each job` is what this rule prevents.
- Every request to a process has a timeout and a timer that is cleared on reply. `run()` and `runStream()` in `src/main/lib/run.ts` default to 15 s and 1 h; `request()` in `mossInfer.ts` and `requestEngineOnce()` in `src/main/lib/probeEngine.ts` take `timeoutMs`. A `new Promise` around a child with no timer is a review finding.
- Short commands go through `run()` / `sshExec()`, not a bare `spawn`. They capture output, cap it, set `windowsHide`, and survive a closed stdin.
- Kill the tree, not the pid: `killTree` in `supervisor.ts` (`taskkill /T` on Windows, the process group elsewhere). A Python trainer or `moss-server` has children.
- Ask the engine what it supports; do not encode GPU or version rules. `hello` gives protocol, capabilities and the device verdict (`judgeEngineSupport` in `src/shared/engineProtocol.ts`: "supported 是唯一兼容性权威"); `inspect` gives a file's weight precision (`src/main/services/weightPrecision.ts`). The old tier-by-compute-capability rule, which made the engine refuse INT8 models on older GPUs, is the counter-example.
- Where a hardware fact is unavoidable (`gpuLacks8BitAttention`, `archRunsOn`), it lives in `src/shared` with a comment that names the engine fact it mirrors, and nowhere else.
- Protocol constants are shared and named: `ENGINE_PROTOCOL_VERSION`, `REMOTE_CANCEL_TIMEOUT_MS`. Tests import them instead of repeating the number.

## 4. Files and settings

- A file that is read back later is written atomically: temp file next to the target, then `rename`. Use `atomicWriteJson` (`src/main/services/settings.ts`) for JSON, `writeJsonAtomic` (`src/main/install/record.ts`) where an fsync matters, or the UUID-suffixed temp in `src/main/services/studioAssets.ts` for large files. A plain `writeFileSync` on a file the app reads at startup is a review finding.
- Every path under the data root comes from `paths` in `src/main/lib/paths.ts`. Add an entry there instead of joining `root()` yourself, so the layout stays in one file and `ensureDirs` can create it.
- Build paths with `join`/`resolve`; compare with `isInside`. Temp files use `tmpdir()`, never a literal `/tmp`. The one literal `/tmp` in `src/main/install/location.ts` is a deny-list of places not to install into.
- A settings field is added in four places: `Settings` in `src/shared/types.ts`, `DEFAULT_SETTINGS` and the read path in `settings.ts`, `settingsUpdate` in `schemas.ts`, and the mock fixture in `apps/desktop/test/mocks/backend/fixtures.ts` (its test asserts they agree).
- A renamed or removed settings field keeps a migration in `getSettings()` with a comment saying what the old shape was and why it changed (`migrateLegacyEngineSettings`, the `'auto'` tier). Old `settings.json` files stay valid forever.
- User-owned folders (a models root they pointed at) are never created or written eagerly. `ensureDirs` filters to `isInside(root(), dir)` for that reason.

## 5. Comments

- Comment why, not what: reasons, constraints, ordering, surprising behaviour, the engine or protocol fact a line depends on. Never narrate the next statement.
- Exported functions and types that are not obvious from their name get a short JSDoc (`/** … */`), one to three lines. `src/main/lib/paths.ts` and `src/shared/channels.ts` show the size.
- If a block needs a paragraph to be understood, rename or split it. A long comment is a signal, not a solution; the exceptions are migrations and protocol notes, where the history is the point (`migrateLegacyEngineSettings`).
- No `TODO`, `FIXME` or commented-out code. There are none today; a missing piece is an issue or a line in the PR's "Notes for the reviewer".
- Comments are in English. The code base is 93% English today; the remaining Chinese comments are fine to leave, but new ones are English so every contributor can read them. UI strings in comments stay as written (`「内置 CUDA」`).

## 6. Naming and layout

- Files are `camelCase.ts`; React component files are `PascalCase.tsx` (233 vs 0, 80 vs 7 today). The seven lower-case `.tsx` files are primitive collections (`ui.tsx`, `form.tsx`, `fields.tsx`, `parts.tsx`, `motion.tsx`) and the two entry points.
- Hooks are `useThing.ts` and export `useThing`. 19 files follow this.
- Named exports only. There is no `export default` in `src`; keep it so names match across files and refactors are greppable.
- A screen is `pages/thing/ThingPage.tsx` plus a two-line `pages/Thing.tsx` that re-exports it for the router (`src/renderer/src/pages/Settings.tsx`). Page logic that can be tested without React goes in `pages/thing/logic.ts` or `thingModel.ts` with a test under `apps/desktop/test/renderer/`.
- Main services are modules of functions with module-level state, not classes (3 classes in 74 service files, all small parsers or queues). Follow the module shape.
- Object shapes are `interface`; `type` is for unions and aliases (`src/shared/types.ts`: 87 vs 24). No `enum`: string unions, so values cross IPC and JSON as themselves.
- A name says what the thing is for the user, not the implementation, in code that the UI reflects (`EngineTier`, `remoteHostsEnabled`).

## 7. Tests

- A test title is a sentence about behaviour, not a function name: `it('keeps a deliberate rollback: a managed pin older than another install of its package stays')`. Use `it`, as the 2,200 existing tests do.
- A bug fix comes with a test that fails without the fix, in the same PR. Eight of the last nine `fix:` commits on `main` touch tests; the ninth changed a release script.
- Never weaken an assertion to make it pass. If it changed, find out why, and say so in the PR.
- A UI change updates the mock backend (`apps/desktop/test/mocks/backend/`) and the E2E spec that shows the screen (`apps/desktop/e2e/specs/`). The mock is the renderer's only main process in tests; a channel it does not know answers `E_MOCK_UNHANDLED`.
- Unit tests never reach the network, a real GPU or a real engine. `test/setup/main.ts` replaces `fetch` with `guardedFetch` (loopback only); engines and SSH are `vi.mock`ed (`test/main/services/supervisor.engineJobs.test.ts`). Do not loosen the guard; stub the call.
- Tests never write outside a temp folder: `useTempDir()` / `useTempDataRoot()` from `test/helpers/tempDir.ts`, and `MOSSSTUDIO_TEST_USERDATA` for anything that slips past. The developer's profile is never the data root.
- E2E and the install test run headless. On Linux, `pnpm test:e2e` and `pnpm test:install` wrap themselves in `xvfb-run`, also from a desktop session; `E2E_HEADED=1` and `MOSS_IT_HEADED=1` are for debugging only. Nothing in a test opens a window on someone's screen.
- An E2E spec opens a scenario, not a hand-built state: `app.open({ scenario: 'remoteHost', route: '/settings/devices' })`. New states are new scenarios in `test/mocks/backend/scenarios.ts`.
- No `.only`, `.skip` or placeholder tests. CI does not grep for them; the reviewer does.
- `apps/desktop/src/main/*.test.ts` are not Vitest files: they run inside Electron for `--smoke`. New unit tests go under `apps/desktop/test/`.

## 8. Dependencies

- A new dependency needs a sentence in the PR: what it does that 30 lines of our own code would not, and that it is maintained. The desktop app has seven runtime dependencies today.
- Runtime code that main needs at run time goes in `dependencies` of `apps/desktop/package.json`; everything the bundler inlines (React, zustand, lucide, tailwind) is a `devDependency`. The packager ships `dependencies` only (`tools/release/package-app.mjs`), so the split is the ship list.
- Versions are caret ranges, and `pnpm-lock.yaml` pins them. Pin exactly only where behaviour must not move under a lock refresh: `vitest`, `happy-dom` and `playwright-core` are pinned today. A new exact pin says why in the PR.
- `packageManager` in the root `package.json` is the pnpm version; Node 22 and Go 1.27 are stated in `CONTRIBUTING.md`. Change them in a PR of their own.

## 9. Go launcher (`apps/launcher`)

- Standard library only (`go.mod` has no `require`). A dependency here changes the size and trust of every installer; propose it in an issue first.
- Code that differs by OS in shape (window, registry, process group) lives in `_windows.go` / `_unix.go` / `_linux.go` files behind an interface in the plain file (`internal/proc/proc.go` + `proc_windows.go`, `proc_unix.go`). A one-line `runtime.GOOS` check for a path or rename quirk is fine (14 today); a whole function body per OS is not.
- Anything that touches the system sits behind a small interface the tests replace (`proc.Runner`, `launch.Clock`). 81 tests, 46 of them on `t.TempDir()`, none start a real process.
- Every exported identifier and every package has a doc comment (138 of 138 functions, 9 of 9 packages). Keep the score.
- Files the next run reads go through `fsutil.WriteFileAtomic` (temp, fsync, rename). Direct `os.WriteFile` is for build tools under `cmd/`.
- Errors shown to the user go through `ui.Error(title, message, detail)`: `message` is plain Chinese, `detail` is the raw error. Everything else goes to `<dataRoot>/logs/launcher.log` through the logger in `main.go`.
- Wrap errors with context on the way up: `fmt.Errorf("…: %w", err)`. Use `%w`, not `%v`, so callers can `errors.As`.

## What lint already checks

Do not restate these in review; point at the tool.

| Tool | Checks |
| --- | --- |
| `tsc` (`strict`, `isolatedModules`) | Types, nullability, unused locals in the five projects |
| ESLint, bug rules | Unhandled and misused promises, `await` on non-thenables, unused vars (`_` prefix excepted), React hook rules |
| ESLint, targeted rules | Exhaustive `switch` over unions; imports across `main` / `renderer` / `shared` / `preload` / `backend`; `type` on type-only imports; `any` as a warning |
| Prettier | Everything about layout. Never discuss formatting in review |
| E2E visual audit (`apps/desktop/e2e/support/audit.browser.js`) | Borders, `<hr>`, non-token colours, contrast, sideways overflow |
| `gofmt`, `go vet` | Launcher formatting and vet checks, including `GOOS=windows` |

## Known gaps

Places where the code does not follow these rules yet. New code follows the rule; the old code is fixed in small refactor PRs, not in unrelated changes.

| Rule | Where the code differs today |
| --- | --- |
| One atomic-write helper for state files (§4) | Three helpers (`atomicWriteJson` in `settings.ts`, `writeJsonAtomic` with fsync in `install/record.ts`, `lib/engineStore.ts` with retries) and about 100 direct `writeFileSync`/`writeFile` calls in `src/main`. One helper is to move to `src/main/lib` and become the rule. |
| `codedError`, not a code inside the message (§2) | Four `throw new Error('E_DEVICE: …')` in `src/main/services/mossInfer.ts`. |
| New comments in English (§5) | 85 older Chinese comment lines in `src/main` and `src/shared` (about 1,180 are English). They stay until the code around them changes. |
| One IPC registry (§1) | `src/main/install/app.ts` repeats the `handle`/`toResult` helpers of `src/main/ipc.ts` for the setup window. |
| Wrap Go errors with `%w` (§9) | 12 `%w` wraps against 23 bare `errors.New` and a few `%v` wraps (`internal/winres/winres.go:133`). |
| One error-to-message path in the renderer | About ten copies of `error instanceof Error ? error.message : String(error)` before `toast.push`; a `messageOf(error)` helper in `lib/api.ts` would replace them. |
| Types and schemas change together (§1) | `src/shared/types.ts` and `schemas.ts` are written twice by hand. Deriving the types from the schemas would remove the rule; that is a separate decision. |
