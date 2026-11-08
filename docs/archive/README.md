# Archive

Documents and files that described the project at an earlier stage. They are kept for history and are never updated, so their links and facts may be out of date. For how things work now, start at [docs/README.md](../README.md).

| Archived | What it was | Replaced by |
| --- | --- | --- |
| [app-installer.md](app-installer.md) | The 1.0.3 self-extracting installer design | The launcher in `apps/launcher` and `src/main/install`; [ADR-0010](../decisions/0010-own-installer-and-signed-updates.md) |
| [apps-README.md](apps-README.md) | An early layout guide for `apps/` | [CONTRIBUTING.md](../../CONTRIBUTING.md) |
| [contracts/](contracts/) | V2 runner and engine protocols and JSON schemas | `src/shared/` types and the MossInfer protocol; [ADR-0009](../decisions/0009-mossinfer-inference.md) |
| [engine/](engine/) | Notes for a planned in-house engine | MossInfer; [ADR-0009](../decisions/0009-mossinfer-inference.md) |
| [release-and-updates.md](release-and-updates.md) | The release.md / manifest.json update flow | [how-to/release.md](../how-to/release.md); [ADR-0010](../decisions/0010-own-installer-and-signed-updates.md) |
| [runner/](runner/) | The Python inference runner | MossInfer; [ADR-0009](../decisions/0009-mossinfer-inference.md) |
| [future-inference-engine.md](future-inference-engine.md) | A pre-MossInfer proposal for an in-house engine | MossInfer; [ADR-0009](../decisions/0009-mossinfer-inference.md) |
| [gbc-integration.md](gbc-integration.md) | A Studio panel for KohakuGBC image analysis | GBC has no UI now; it is reachable only through IPC (`src/shared/channels.ts`) |
| [mossinfer-migration.md](mossinfer-migration.md) | The log of the move from the Python runner to MossInfer | The migration is done; the engine is described in the developer docs |
| [roadmap.md](roadmap.md) | The plan for the five-window launcher era | GitHub issues and milestones |
| [status.md](status.md) | Feature status as of 1.0.3 | Release notes in `release/notes/` and the status header of each doc |
| [v2-mnn-spike.md](v2-mnn-spike.md) | A benchmark template for MNN on macOS, never filled in | [ADR-0009](../decisions/0009-mossinfer-inference.md) (no local inference on macOS) |
