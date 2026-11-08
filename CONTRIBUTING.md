# Contributing to MossStudio

This page covers how the repository is laid out, how to build and test it, and how changes reach `main`. Product and architecture docs live in [docs/](docs/README.md); the release process is in [docs/how-to/release.md](docs/how-to/release.md). Coding agents follow [AGENTS.md](AGENTS.md), which keeps the same rules in short form; keep the two in step when a rule changes.

## Layout

| Path | What it is |
| --- | --- |
| `apps/desktop/` | The Electron app (TypeScript, React, electron-vite) |
| `apps/desktop/src/main/` | Main process. `install/` is install, uninstall and run modes; `update/` is the updater; `services/` is engines, models, jobs and SSH |
| `apps/desktop/src/renderer/src/` | UI. `components/` holds shared primitives; `pages/` holds the screens |
| `apps/desktop/src/shared/` | Types, schemas and contracts shared by main and renderer |
| `apps/desktop/src/backend/` | The local HTTP/WebSocket backend for the LAN web UI |
| `apps/desktop/test/`, `apps/desktop/e2e/` | Unit tests (Vitest) and E2E tests (Playwright + Electron against a mock backend) |
| `apps/launcher/` | The Go launcher and setup stub (Windows, Linux) |
| `tools/release/` | Packaging, delta, feed and signing tools, plus the real install test (`integration/`) |
| `tools/dev/` | Developer helpers (fake engine server, model budget, Windows `start.cmd`) |
| `release/notes/` | One Markdown file per release |
| `docs/` | Product, architecture, design and decision records. `docs/archive/` is historical |

## Set up and run

You need Node 22 and pnpm 9 (`corepack enable`). Go 1.27 is needed only for the launcher.

```bash
pnpm install
pnpm dev        # the app in development mode
pnpm build      # production build
```

## Checks

| Command | What it runs |
| --- | --- |
| `pnpm lint` | ESLint: bug-finding rules, exhaustive `switch`, type-only imports and the process import boundaries (`eslint.config.mjs`) |
| `pnpm format` / `pnpm format:check` | Prettier for code and config |
| `pnpm typecheck` | `tsc` over all five TypeScript projects |
| `pnpm test:unit` | Vitest. Pass a file to run one: `pnpm test:unit -- test/renderer/lib/format.test.ts` |
| `pnpm test:e2e` | The Electron E2E suite against the mock backend. Run `pnpm build` first. On Linux it runs under `xvfb-run` by itself |
| `pnpm test:scenarios` | In-app scenarios on the built app |
| `pnpm test:install` | The real install → update → rollback → uninstall test on this machine. On Linux it runs under `xvfb-run` by itself and stops if xvfb is missing |
| `cd apps/launcher && gofmt -l . && go vet ./... && go test ./...` | The launcher |

Before opening a PR, run lint, format check, typecheck and unit tests, plus E2E when you change UI.

## CI

`.github/workflows/build.yml` runs on every pull request and on pushes to `main`:

- Every PR runs typecheck, lint, format check, unit, launcher, build, E2E and scenarios.
- A PR that touches the launcher, install, update, setup or release code, the workflow or dependencies also runs the package + install/update/rollback test on Windows, Linux and macOS arm64.
- `main` and manual runs add macOS Intel. To run the full matrix on a PR: `gh workflow run build.yml --ref <branch>`.
- **`CI result`** is the single required check. It passes only when every job that ran passed.

## Branches, commits and pull requests

- Work on a branch named after the change type: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`.
- Commit messages and PR titles follow Conventional Commits, in English: `fix(update): tell the user once when a version is rolled back`. User-facing UI text stays Chinese.
- Every change reaches `main` through a pull request, **squash-merged**. The PR title becomes the commit on `main`, so make it a good one. Branches are deleted after merging.
- A PR says what changed and why, how it was verified, and which platforms it affects (the template asks).
- Reformat-only commits go into `.git-blame-ignore-revs`. Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once.
- Commit trailers name people only. No tool attribution lines (see [AI-assisted contributions](#ai-assisted-contributions)).

## AI-assisted contributions

You may use any tool to write code, tests or docs, and you do not have to say which. How a change was produced is up to you; the bar is the same for everyone.

You are the author. That means:

- You have read, run and understood every line you submit, and you can explain any of it in review. A PR whose author cannot answer questions about it may be closed without a detailed review.
- You have tested it the way the PR template asks, on the platforms it touches. "The tool said it works" is not verification.
- You have the right to contribute it, and it meets the project's licence, like any other contribution.
- Commits and PRs carry no tool attribution: no `Co-Authored-By`, `Assisted-by` or similar lines for tools.

Review is done by people, and they will treat your PR as your own work. A PR that is too large to review, or that bundles unrelated changes, will be sent back to be split, however it was written.

## Code standards

Rules that no tool checks are in [docs/reference/coding-standards.md](docs/reference/coding-standards.md). In short:

- **TypeScript:** `strict`. Prettier owns formatting; ESLint catches unhandled promises, unused code, hook misuse, non-exhaustive `switch` over unions, missing `type` on type-only imports, and imports across process boundaries (renderer, shared, main). No `.only`, `.skip` or TODO stubs in tests.
- **Go:** `gofmt`, `go vet`.
- **UI:** follow [docs/reference/ui-rules.md](docs/reference/ui-rules.md), which covers:
  - which primitive to use for what, and which button tone for which action;
  - delete vs remove;
  - loading, empty and error states;
  - wording and formats through `lib/format.ts`.

  The design is flat and tonal: no border-based separation. Check both light and dark themes.
- **Tests:** new behaviour gets unit tests. UI behaviour also gets an E2E assertion in `apps/desktop/e2e/specs`, with the mock backend updated in `apps/desktop/test/mocks/backend`.

## Releases

See [docs/how-to/release.md](docs/how-to/release.md). In short: bump both `package.json` versions, add `release/notes/<version>.md`, merge the PR, then tag `v<version>` on `main`.
