# Notes for coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: layout, commands, CI tiers, branch and commit rules. These points are easy to get wrong:

- **Commits and PRs:**
  - Conventional Commits in English, squash-merged through a PR.
  - Do not add `Co-Authored-By` or any other AI attribution line.
  - Do not push to `main`, and do not merge, unless asked.
- **UI:**
  - Follow [docs/design/ui-rules.md](docs/design/ui-rules.md): use the shared primitives and `lib/format.ts`, not hand-built Tailwind.
  - `cn` merges classes, so a `className` override wins.
  - UI text is Chinese, plain and friendly.
- **Tests:**
  - Run E2E and the real install test headless (`xvfb-run -a` on Linux); they must never open windows on someone's desktop.
  - Update the mock backend and E2E specs when UI text or structure changes.
  - Never weaken an assertion to make it pass. Find out why it changed.
- **Before you finish:** run `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test:unit`. Run `pnpm test:e2e` after a build for UI changes, and `pnpm test:install` for launcher, install, update or release changes.
- **Do not touch:** `docs/archive/` (historical) or `release/notes/` of shipped versions. The signing key lives only in the `release` environment.
