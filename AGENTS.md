# AGENTS.md

Instructions for every coding agent working in this repository (Codex, Cursor, Copilot, Gemini, Claude Code and others). `CLAUDE.md` imports this file; do not add rules there. Humans read [CONTRIBUTING.md](CONTRIBUTING.md) for the long form; this file keeps only what an agent must know before its first edit.

## What this is

MossStudio is a desktop image-creation workbench: an Electron + React + TypeScript app (`apps/desktop`) with a Go launcher and setup stub (`apps/launcher`). It drives the MossInfer image engine (`moss-server`) on the local GPU or over SSH. Version 2.0.0 shipped the node-board Studio. UI text is Chinese; code, comments, commits and developer docs are English.

## Setup and commands

Node 22 and pnpm 9 (`corepack enable`). Go 1.27 only for the launcher. On Linux, `xvfb` for E2E and the install test.

```bash
pnpm install
pnpm dev                        # the app in development mode
pnpm build                      # production build; E2E and scenarios run against it

pnpm lint                       # ESLint, bug-finding rules only (eslint.config.mjs)
pnpm format:check               # Prettier; `pnpm format` fixes
pnpm typecheck                  # tsc over all five TypeScript projects
pnpm test:unit                  # Vitest; one file: pnpm test:unit -- test/renderer/lib/format.test.ts
pnpm test:e2e                   # Electron E2E against the mock backend; needs a build first
pnpm test:scenarios             # builds, then in-app scenarios on the built app
pnpm test:install               # real install → update → rollback → uninstall on this machine
cd apps/launcher && gofmt -l . && go vet ./... && GOOS=windows GOARCH=amd64 go vet ./... && go test ./...
```

On Linux, `pnpm test:e2e`, `pnpm test:scenarios` and `pnpm test:install` run themselves under `xvfb-run`, so their windows never reach the desktop. Never set `E2E_HEADED=1` or `MOSS_IT_HEADED=1`.

## Project map

| Path | What lives there |
| --- | --- |
| `apps/desktop/src/main/` | Electron main process. `services/` engines, models, jobs, SSH; `install/` install, uninstall and run modes; `update/` the updater; `lib/` helpers |
| `apps/desktop/src/preload/index.ts` | The only bridge: exposes `window.clover` (`invoke`, `on`) to the renderer |
| `apps/desktop/src/renderer/src/` | UI. `components/ui.tsx`, `form.tsx`, `common/` are the primitives; `pages/` the screens; `pages/studio/` the node board; `lib/format.ts` all wording and number formats; `lib/api.ts` the IPC client |
| `apps/desktop/src/shared/` | Types, zod schemas, IPC channel names (`channels.ts`) and the engine protocol (`engineProtocol.ts`), imported by main and renderer as `@shared/*`. No Node or DOM imports |
| `apps/desktop/src/backend/` | Local HTTP/WebSocket backend for the LAN web UI |
| `apps/desktop/test/` | Vitest unit tests, mirrored by source folder. `mocks/backend/` is the fake main process the renderer tests and E2E run against |
| `apps/desktop/e2e/` | Playwright + Electron E2E. `specs/` the tests; `support/audit.browser.js` the visual-rule audit |
| `apps/launcher/` | Go launcher, setup stub and uninstall finisher (Windows, Linux). See `apps/launcher/AGENTS.md` |
| `tools/release/` | Packaging, deltas, feed, signing; `integration/` is the real install test |
| `tools/dev/` | Developer helpers, including `fake-moss-server.mjs` |
| `release/notes/` | One Markdown file per release; the GitHub release text and the in-app notes |
| `docs/` | Developer docs. `docs/README.md` is the index; `docs/decisions/` the ADRs; `docs/archive/` is historical and read-only |
| `.github/workflows/build.yml` | CI. `.github/scripts/ci-scope.sh` decides which paths trigger the package + install matrix |

## Before you change code

- Any change: [CONTRIBUTING.md](CONTRIBUTING.md).
- Rules a reviewer applies that lint cannot: [docs/reference/coding-standards.md](docs/reference/coding-standards.md).
- Renderer: [docs/reference/ui-rules.md](docs/reference/ui-rules.md); the Studio in [docs/reference/studio-node-board.md](docs/reference/studio-node-board.md) and [docs/reference/studio-assistant.md](docs/reference/studio-assistant.md).
- Main process, services, engine: [docs/reference/architecture.md](docs/reference/architecture.md) and [docs/reference/engines.md](docs/reference/engines.md).
- Models, bundles and local files: [docs/reference/models.md](docs/reference/models.md).
- Any doc: [docs/README.md](docs/README.md) is the map; [docs/reference/documentation-guidelines.md](docs/reference/documentation-guidelines.md) the rules.
- Launcher, install, update, release: [docs/how-to/release.md](docs/how-to/release.md) and `apps/launcher/AGENTS.md`.
- Engine protocol and capabilities: the [MossInfer repository](https://github.com/mossimage-cpp/mossimage.cpp) docs. Do not copy engine facts into this repo.

## Rules

### Code

- TypeScript `strict`. Prettier owns formatting; ESLint catches bugs. Do not add style rules to `eslint.config.mjs`, and do not disable a rule inline without a comment saying why.
- The renderer reaches main only through `lib/api.ts` → `window.clover` → channels in `shared/channels.ts`. Never import `electron` or `main/` from the renderer. Add a channel name to `shared/channels.ts` before using it.
- Comments say why, not what. Delete a comment that restates the code.
- Ask the engine what it supports (`hello`, `inspect`) instead of hard-coding GPU, model or version rules.
- Every spawned process has an owner that ends it on job end, cancel, error and app quit.
- Every request to the engine, SSH or network has a timeout.
- Prefix an intentionally unused name with `_`.

### UI

- Use the primitives from ui-rules and `lib/format.ts`. Do not hand-build headings, notices, progress bars, dates or sizes with Tailwind.
- `cn` is tailwind-merge: a later class wins, so a `className` prop overrides defaults.
- UI text is Chinese, plain and friendly. Name what the person knows (显卡, 引擎, 模型), not the implementation.
- Flat tonal design: areas are told apart by surface tone, never by borders or lines. The E2E visual audit fails on borders, `<hr>`, non-token colours and low contrast. Check light and dark themes.

### Tests

- New behaviour gets a unit test. UI behaviour also gets an E2E assertion in `apps/desktop/e2e/specs`, with `apps/desktop/test/mocks/backend` updated to match.
- A bug fix comes with a test that fails without the fix.
- When UI text or structure changes, update the mock backend and the E2E specs in the same change.
- Never weaken or delete an assertion to make it pass. Find out why it changed.
- No `.only`, `.skip`, TODO stubs or empty tests.
- E2E and the install test run headless and never open windows on someone's desktop.

### Git and PRs

- Branch names: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`.
- Conventional Commits in English (`fix(update): tell the user once when a version is rolled back`). PRs are squash-merged; the PR title becomes the commit on `main`.
- Do not push to `main`. Do not merge unless asked.
- No AI attribution anywhere: no `Co-Authored-By` for a tool, no `Assisted-by`, no "Generated with" lines. The human contributor is the author and is responsible for the change.
- Fill in the PR template: what and why, how it was verified (commands and results, light and dark screenshots for UI), platforms affected.

### Docs

- Developer docs are English. UI text stays Chinese.
- `docs/` follows Diátaxis: how-to, reference, explanation, tutorial, plus `decisions/` (ADRs) and dated records. Put a new doc in the right section and add it to `docs/README.md`.
- Every doc outside `docs/archive/` starts with the front matter (`status`, `last-verified`, `code`) and a 2 to 3 line summary from the documentation guidelines. Set `last-verified` only after comparing the whole doc to the code.
- Link to the source of a fact instead of restating it. Engine facts link to the MossInfer docs.
- ADRs use MADR 4.0. Never edit an accepted ADR: write a new one that supersedes it and link both ways. Leave `status: proposed`; only the maintainer marks an ADR accepted.

## Finishing checklist

1. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test:unit` pass.
2. UI changed: `pnpm build && pnpm test:e2e` passes, and light and dark were checked.
3. Launcher, install, update or release changed: `pnpm test:install` passes, and the launcher checks above pass.
4. Docs changed: summary, status and last-verified date present; index updated; no fact restated that a link covers.
5. The diff has no `.only`, `.skip`, TODO stubs, debug output or attribution lines.

## Do not

- Edit `docs/archive/` or the `release/notes/` file of a shipped version.
- Touch the signing key or add keys outside the PR flow in `docs/how-to/release.md`. The private key lives only in the GitHub `release` environment.
- Push to `main`, merge, or tag.
- Run E2E or the install test with a visible window.
- Mark an ADR accepted, or edit one that is.
- Commit `.dev-data/`, model weights or anything else `.gitignore` lists.
