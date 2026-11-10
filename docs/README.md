---
status: current
last-verified: 2026-11-08 (c3dc0ee)
code: docs/
---

# MossStudio docs

Developer documentation for MossStudio: an Electron + React + TypeScript desktop app with a Go launcher, driving the MossInfer image engine. Developer docs are English; user guides and UI text are Chinese. Every doc carries a header with its status and the date it was last checked against the code; trust the header before the text. Agents read [AGENTS.md](../AGENTS.md), which points at the same docs.

## I want to...

| Goal | Read |
| --- | --- |
| Set up the app as a user (首次运行、显卡与引擎、模型) | [how-to/setup.md](how-to/setup.md) |
| Build, test and open a PR | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Know the rules a reviewer applies to code | [reference/coding-standards.md](reference/coding-standards.md) |
| Build or change a screen | [reference/ui-rules.md](reference/ui-rules.md) |
| Write or change a doc | [reference/documentation-guidelines.md](reference/documentation-guidelines.md), [reference/glossary.md](reference/glossary.md) |
| Cut a release or rotate the update key | [how-to/release.md](how-to/release.md), then [how-to/release-qa-checklist.md](how-to/release-qa-checklist.md) |

## I want to understand...

| Topic | Read |
| --- | --- |
| How the app is put together: processes, windows, routes, services, storage | [reference/architecture.md](reference/architecture.md) |
| The Studio node board: 画面, 风格, 放大, inputs, wires, regions, runs, recipes | [reference/studio-node-board.md](reference/studio-node-board.md) |
| The Studio assistant: tools, cards, 自主 and 审批 modes | [reference/studio-assistant.md](reference/studio-assistant.md) |
| Why the Studio is a node board, and what it refuses to be | [explanation/studio-design.md](explanation/studio-design.md) |
| Engines and GPUs: CUDA packages, 兼容模式 (Vulkan), AMD 原生 (HIP), tiers, remote hosts | [reference/engines.md](reference/engines.md) |
| Models: catalog, bundles, component files, directories, LoRA | [reference/models.md](reference/models.md) |

## I want to look up...

| Thing | Read |
| --- | --- |
| A term the UI or code uses | [reference/glossary.md](reference/glossary.md) |
| The project file (`ProjectDocument` v3), engine jobs and the LAN HTTP/WS API | [reference/project-and-backend.md](reference/project-and-backend.md) |
| Region coordinates and the layout contract | [reference/layout-schema.md](reference/layout-schema.md) |
| MOSS-Image model files, sizes and VRAM budgets | [reference/model-notes.md](reference/model-notes.md) |
| The engine protocol and what each engine supports | The [MossInfer repository](https://github.com/mossimage-cpp/mossimage.cpp); this repo links it and does not copy it |

## I want to see why we decided...

Decisions are ADRs in [decisions/](decisions/README.md), one per choice, never edited after acceptance. The index lists each with its status. Start with:

| Decision | ADR |
| --- | --- |
| MossInfer is the only inference engine | [0009](decisions/0009-mossinfer-inference.md), amended by [0012](decisions/0012-vulkan-and-hip-cli-engines.md) (Vulkan and HIP) |
| Rail navigation and the node board | [0011](decisions/0011-rail-navigation-and-node-board.md), which supersedes [0008](decisions/0008-studio-window-and-dock.md) |
| Own installer, launcher and signed updates | [0010](decisions/0010-own-installer-and-signed-updates.md), amended by [0014](decisions/0014-nightly-update-channel.md) (nightly channel) |
| The Trainer stays an external Python tool | [0002](decisions/0002-trainer-backend.md) |
| How these docs are organised | [0013](decisions/0013-documentation-structure-and-language.md) |

## Records and history

- [records/](records/) holds dated snapshots (audits, benchmarks, surveys). They are never updated; the newest one on a topic is the one to read. The MossInfer 1.0.0 performance report is [records/2026-10-31-mossinfer-1.0.0-performance.md](records/2026-10-31-mossinfer-1.0.0-performance.md).
- [archive/](archive/README.md) holds superseded docs. Nothing there describes the current app; its README says what replaced each file.

## Adding or changing a doc

Follow [reference/documentation-guidelines.md](reference/documentation-guidelines.md): pick the type, fill the header, link instead of restating, and add the doc to this page in the same PR.
