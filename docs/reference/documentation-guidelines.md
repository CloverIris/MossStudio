---
status: current
last-verified: 2026-11-08 (ce189a1)
code: docs/, AGENTS.md, CONTRIBUTING.md
---

# Documentation guidelines

Proposed path: `docs/reference/documentation-guidelines.md`.

How docs in this repository are written, placed and kept current, so that a person can find one doc per question and trust its header. Most docs here are drafted by agents; every rule below is one a reviewer checks by reading the diff. Paths are relative to the repository root.

## 1. Doc types and where they live

Each doc has one type and one folder. If a draft needs two types, it is two docs.

| Type | Folder | Answers | Test: it belongs here if... |
| --- | --- | --- | --- |
| How-to | `docs/how-to/` | "How do I do X?" | It is a numbered list of steps towards one goal, and a reader can stop when the goal is reached. |
| Reference | `docs/reference/` | "What is X? What are the rules?" | It describes what exists, as built, and can be checked against the code line by line. Standards (`ui-rules.md`, `coding-standards.md`, this file) are reference. |
| Explanation | `docs/explanation/` | "Why is X like this?" | Deleting it would break no task and no lookup, only understanding. |
| Tutorial | `docs/tutorials/` (none yet) | "Teach me X from zero." | A newcomer follows it end to end and learns by doing. Write one only when a how-to has proven too hard for first-time readers. |
| Decision | `docs/decisions/` | "Why did we decide Z?" | It records one choice between alternatives, with a date. Format: ADR (section 9). |
| Record | `docs/records/` | "What did we measure or find on date D?" | It is a snapshot: an audit, a benchmark, a survey. It is never updated after it lands. |
| Archive | `docs/archive/` | Nothing current | It is superseded and kept only for history. Read-only. |

Other locations: `docs/README.md` is the index (section 7). `docs/assets/` holds images (section 10). `release/notes/<version>.md` are release notes, owned by the release process (`docs/how-to/release.md`). The root `README.md` is the product front page for users. `AGENTS.md` and `CONTRIBUTING.md` are entry points that link into `docs/`; they hold no facts that a doc in `docs/` already holds.

## 2. Header block

Every doc outside `docs/archive/` starts with this YAML front matter, then an H1, then a summary of 2 to 3 lines that states the conclusion or what the doc covers. GitHub renders the front matter as a table.

```markdown
---
status: current
last-verified: 2026-11-08 (ce189a1)
code: apps/desktop/src/renderer/src/pages/studio/, apps/desktop/src/shared/types.ts
---

# Title in sentence case

Two or three lines. What the doc covers and the one thing a reader should take away.
```

| Field | Values | Rule |
| --- | --- | --- |
| `status` | `current`, `partly stale`, `historical`; `record` for `docs/records/`; ADRs use section 9 | `partly stale` needs a line under the summary saying which parts. `historical` docs are moved to `docs/archive/` in the same PR, except ADRs, which never move. |
| `last-verified` | ISO date and the short commit hash | The date someone compared the doc to the code at that commit and fixed the differences. Reading the doc is not verifying it. |
| `code` | Paths, comma separated | The folders or files the doc describes. Reviewers diff these paths against the doc. A how-to lists the commands or workflows it uses instead. |

Records replace `last-verified` with `date` (the date of the measurement) and omit `code` unless useful.

## 3. Language

- Developer docs (how-to for contributors, reference, explanation, decisions, records, `AGENTS.md`, `CONTRIBUTING.md`) are English.
- User-facing text is Chinese: UI strings, the root `README.md`, release notes, and how-tos written for people who use the app rather than build it. The header says `audience: users` for those.
- UI strings quoted in any doc are written exactly as the UI shows them, in Chinese, never translated: 设置 › 设备与引擎, 风格, 放大. On first use in an English doc, add the code identifier in parentheses: 风格 (`kind: 'style'`).
- Existing Chinese developer docs are translated when they are rewritten or moved into the new tree for content changes, not before. A pure move keeps the language.
- Code, comments, commit messages and PR text are English (see `coding-standards.md` section 5).

## 4. Style guides

By reference, not restated:

- English: the [Google developer documentation style guide](https://developers.google.com/style).
- Chinese: 阮一峰《[中文技术文档的写作规范](https://github.com/ruanyf/document-style-guide)》 and 《[中文文案排版指北](https://github.com/sparanoid/chinese-copywriting-guidelines)》.

Project deltas, which win over the guides:

| Rule | Check |
| --- | --- |
| Headings are sentence case and start with a noun or verb; no numbering in the text except the `N.` sections of rule docs. | Scan headings. |
| Paths are relative to the repository root and in backticks. A doc may declare another base in its first paragraph, as `ui-rules.md` does. | Every path resolves from the root, or the base is declared. |
| Dates are ISO 8601 (`2026-11-08`). Versions have no `v` except git tags (`v2.0.0`). | grep `v[0-9]` outside tag names. |
| Terms from the glossary are used as the glossary spells them, with the UI Chinese and the code identifier as given there. | Compare to `docs/reference/glossary.md`. |
| In Chinese text, UI labels are quoted with 「」; in English text they stand bare. | grep. |
| No em dashes; use a period, a colon or parentheses. No "simply", "just", "easily", "it's worth noting", "note that". | grep `—` and the words. |
| Tables for anything with three or more parallel items. Prose for reasoning. | Review. |
| State facts as-built in the present tense. Planned work is in a section titled "Planned" or "Not built", never mixed into the as-built text. | Every future-tense sentence sits under such a heading. |

## 5. Length budgets

| Doc | Budget | When over |
| --- | --- | --- |
| Summary at the top | 2 to 3 lines | Cut. |
| How-to | 150 lines, one goal | Split by goal. |
| Reference | 300 lines | Split by topic; the parent links the children. |
| Explanation | 200 lines | Move detail to reference and link. |
| ADR | 120 lines (1 to 2 pages) | Detail goes to a reference doc or a record; the ADR links it. |
| Record | No limit, but the summary states the result in 3 lines. | |
| `docs/README.md` | 80 lines | It is a map, not a catalogue. |
| Glossary entry | One line of meaning | Link a doc for more. |

## 6. Linking and single source of truth

- Each fact has one home. Other docs link to it with a sentence of context, never a copy. The 2026-11-08 audit found MossInfer package names, the Project schema, model directories and benchmark numbers copied 3 to 5 times, each copy different.
- Homes: code first (a type in `src/shared/types.ts` is the schema; the doc links the line range, not a paste). Engine facts (protocol, capabilities, supported GPUs) live in the MossInfer repository; link, do not copy. Commands live in `CONTRIBUTING.md` and `AGENTS.md`. Release steps live in `docs/how-to/release.md`.
- Link to a file, and to a heading or line when the file is long: `[`EngineFeatures`](/apps/desktop/src/shared/types.ts#L800)`. Line links go stale; prefer a heading or a symbol name in the sentence so the reader can search.
- Root-relative links (`/docs/...`) resolve on GitHub from any location and survive moves.
- A doc that must restate a fact for readability (a user guide naming a menu path) says where the fact comes from, so a later diff can be checked.

## 7. Keeping docs current

A PR must touch docs when it changes any of these:

| Change | Docs to update in the same PR |
| --- | --- |
| A route, window, Rail entry, settings section or page | `docs/reference/architecture.md`; the screenshot, if one shows it |
| Canvas kinds, inputs, wires, regions, recipes, filmstrip, the Project schema | `docs/reference/studio-node-board.md`, `docs/reference/project-and-backend.md` |
| Assistant tools, cards or modes | `docs/reference/studio-assistant.md` |
| Engine packages, GPU support, tiers, engine protocol version | `docs/reference/engines.md`; an ADR if the supported hardware changes |
| Model directories, bundles, component binding | `docs/reference/models.md` |
| A UI primitive or its rules | `docs/reference/ui-rules.md` |
| Commands, CI, branch rules | `CONTRIBUTING.md` and `AGENTS.md` |
| Release or update flow | `docs/how-to/release.md` |
| A doc added, renamed, moved or archived | `docs/README.md` |

Rules:

- The PR template gets a checkbox under "How it was verified": `- [ ] Docs updated (which), or none apply (why)`. Reviewers check the table above against the diff.
- Updating a doc sets `last-verified` to that date and commit only if the whole doc was compared to the code. A partial fix leaves `last-verified` alone and, if the rest is doubtful, sets `status: partly stale` with the reason.
- `status: current` with a `last-verified` older than the last release of the code it names is a review finding: re-verify or mark `partly stale`.
- A doc that is no longer true and will not be fixed is archived (section 8), not left in place.
- Status and roadmap documents are not kept. What is built is in the reference docs; what is planned is in GitHub issues and milestones; what shipped is in `release/notes/`.

## 8. Dated records and archiving

- A record is named `docs/records/YYYY-MM-DD-<topic>.md`, with `status: record` and `date:`. It states its method and machine so it can be repeated. It is never edited after merge except to fix a link; a new measurement is a new record.
- Audits of the docs or code, benchmarks, research surveys and incident write-ups are records. A record that proposes changes links the PRs or issues that carry them out; the record itself does not track progress.
- Archiving: `git mv` the file into `docs/archive/` keeping its name, set `status: historical` in its header, and remove it from `docs/README.md`. Add one line to `docs/archive/README.md` saying what replaced it. Do not edit the body; blame should keep working.
- Nothing in `docs/archive/` is linked from a current doc except to say "this replaced it".
- ADRs are never archived. A superseded ADR stays in `docs/decisions/` with its status changed (section 9).
- Images whose screen no longer exists are deleted, not archived; git history keeps them.

## 9. ADRs

Rules:

- Location and name: `docs/decisions/NNNN-short-title.md`. Numbers are sequential and never reused, even for a rejected ADR.
- Format: [MADR 4.0](https://adr.github.io/madr/), reduced to the template below. Front matter `status` and `date` are required. `status` is one of `proposed`, `accepted`, `rejected`, `deprecated`, `superseded by ADR-NNNN`.
- An accepted ADR is never edited except its status line and the `superseded-by` / `amended-by` links in the front matter. Everything else, including fixing a wrong fact, is a new ADR.
- Superseding: the new ADR says `supersedes: ADR-NNNN` in its front matter and in a sentence in its context; the old ADR gets `status: superseded by ADR-MMMM`. Both links land in the same PR. Partial supersession (one point of an ADR) is written as `amends: ADR-NNNN`, and the old ADR gets `amended-by: ADR-MMMM` with its status unchanged.
- An agent may draft an ADR only as `proposed`. The maintainer changes it to `accepted` or `rejected`. A PR that sets `accepted` on a new ADR without the maintainer's commit is sent back.
- One decision per ADR. If the context needs more than a page, it is a record or an explanation that the ADR links.
- English. Existing Chinese ADRs stay Chinese; only their status changes.

Template:

```markdown
---
status: proposed
date: 2026-11-08
supersedes: ADR-0008          # optional
amends: ADR-0009              # optional
superseded-by:                # filled later, on this ADR
amended-by:                   # filled later, on this ADR
---

# ADR-0011: Rail navigation and the node board replace the dock layout

## Context and problem statement

Two to five sentences. What forced a decision, and the question in one line.

## Decision drivers

- Constraint or goal, one per line (3 to 6).

## Considered options

1. Option A
2. Option B

## Decision outcome

Chosen option: "Option A", because ... (one paragraph). What is as-built and what is planned, if the decision is not fully implemented.

### Consequences

- Good: ...
- Bad: ...

## More information

Links: PRs, the reference doc that describes the result, the ADR this replaces.
```

## 10. Images and screenshots

- Location: `docs/assets/<doc-name>/<subject>-light.png` and `<subject>-dark.png`, where `<doc-name>` is the doc that embeds them. Brand files live in `docs/assets/brand/`. An image referenced by no doc is deleted.
- App screenshots are captured in both themes and embedded with a `<picture>` element so GitHub picks the viewer's theme:

  ```html
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/studio-node-board/board-dark.png">
    <img alt="The Studio board with a 风格 node wired to three 画面" src="assets/studio-node-board/board-light.png" width="800">
  </picture>
  ```
- Capture through the app's `--screenshot` mode (`apps/desktop/src/main/index.ts`, writes `screenshot-*.png` to the user data folder; run it once per theme) or an E2E scenario, at 1x, 1600 px wide or less, PNG, under 500 KB. No personal data, real tokens or paths with user names in the frame.
- A PR that changes a screen shown in a screenshot replaces the screenshot in the same PR, both themes. The alt text says what the picture shows, not "screenshot".
- Diagrams are Mermaid blocks in the Markdown, not images, unless the tool cannot draw them. A diagram image comes with its source file next to it.
- The root `README.md` carries at most two screenshots; more belong in the docs they illustrate.

## 11. Rules for agents writing docs

An agent drafting or editing a doc follows everything above, and in addition:

- Read `AGENTS.md`, this file and `docs/reference/glossary.md` before writing. Use the glossary's terms.
- Every path, identifier, command, route and UI string in the draft was opened or run in this checkout. The 2026-11-08 audit found docs citing files and pages that did not exist. If you did not check it, do not write it.
- `last-verified` is the date and commit you checked against. Do not copy it from another doc, and do not set it when you only changed wording.
- Say what you verified and how in the PR description ("compared sections 2 to 4 to `src/shared/types.ts` at ce189a1"). "Reviewed" without a method is not verification.
- Mark as-built and planned separately. If the code and an existing doc disagree, the code wins; say so in the PR and fix the doc, do not average them.
- Do not create a new doc when an existing one has the same purpose; extend it. Do not create status, roadmap, summary or report files in the repository. Findings go in the PR description or, if the maintainer asks, in a dated record.
- Do not edit `docs/archive/`, shipped `release/notes/`, or the body of an accepted ADR. Draft ADRs as `proposed` only.
- Update `docs/README.md` and the docs named in the section 7 table in the same PR as the change. One area per PR; a docs PR that rewrites two unrelated areas is split.
- Write the summary last and put it first. If you cannot state the doc's point in three lines, the doc has more than one purpose.
