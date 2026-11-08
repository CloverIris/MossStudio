---
status: proposed
date: 2026-11-08
---

# ADR-0013: Documentation structure and language

## Context and problem statement

An audit of `docs/` on 2026-11-08 (against ce189a1) found no shared structure: design proposals, as-built references, audits and roadmaps side by side, most in Chinese and a few in English, headers that said "implemented" over sections the code had left behind, docs citing files and pages that no longer existed, and superseded ADRs with no status. `docs/README.md` carried its own status markers and maintenance rules that nothing enforced. Most of these docs were drafted by coding agents, which had no rule to follow beyond `CLAUDE.md`. The question: how are docs organised, in which language and style, and how are decisions recorded, so that a person finds one doc per question and can trust its header?

## Decision drivers

- One place per question: a reader with a task, a lookup or a "why" should know which folder to open.
- Two audiences with different languages: contributors and maintainers write English; users of the app read Chinese, and the UI is Chinese (`CONTRIBUTING.md`).
- Every rule must be checkable in a PR diff by a reviewer, and followable by an agent with no other context.
- History must stay readable: `git log --follow` on moved files, decisions never rewritten.
- Conventions that already work stay: `docs/decisions/` with numbered ADRs, `release/notes/` owned by the release process, Conventional Commits in English.

## Considered options

1. Organise `docs/` by product area (Studio, engines, models, release), each folder mixing how-to, reference and design notes.
2. Keep a flat `docs/` with an index that marks each file's status. This is the state before this ADR.
3. Organise by document type following Diátaxis (how-to, reference, explanation, tutorial), plus `decisions/` and `records/`, with a status header on every doc.

For style: a house style guide written for this repository, or established guides by reference with a short list of project deltas.

For decisions: free-form ADRs as before, or MADR 4.0 with the status in front matter.

## Decision outcome

Chosen: option 3, established style guides by reference, and MADR 4.0. Option 1 puts a user guide, an as-built reference and an abandoned proposal for the same area in one folder, which is how the audited tree went stale. Option 2 depends on someone updating markers by hand; the audit found them wrong. A house style guide would be one more doc to keep current and would restate what Google and 阮一峰 already say.

The decisions, as the maintainer approved them on 2026-11-08:

1. **Tree.** `docs/how-to/`, `docs/reference/` and `docs/explanation/`, with `docs/tutorials/` added only when a how-to proves too hard for first-time readers. Beside them `docs/decisions/` for ADRs, `docs/records/` for dated snapshots (audits, benchmarks, surveys) that are never updated, and `docs/archive/` for superseded docs, read-only. One type per doc; a draft that needs two types is two docs. The move into this tree is PR #49.
2. **Language.** Developer docs (how-to for contributors, reference, explanation, decisions, records, `AGENTS.md`, `CONTRIBUTING.md`) are English. User-facing text is Chinese: UI strings, the root `README.md`, release notes and how-tos for people who use the app, marked `audience: users` in the header. UI strings are quoted exactly as the UI shows them, never translated, with the code identifier on first use. Existing Chinese developer docs are translated when they are rewritten, not when they are moved.
3. **Style.** The Google developer documentation style guide for English; 阮一峰《中文技术文档的写作规范》 and 《中文文案排版指北》 for Chinese; all by reference. A short table of project deltas and a project glossary (`docs/reference/glossary.md`) carry the terms the code uses.
4. **Header.** Every doc outside `docs/archive/` starts with YAML front matter: `status` (`current`, `partly stale`, `historical`, or `record`), `last-verified` as an ISO date plus the commit someone compared the doc against, and `code`, the paths it describes. Reading a doc is not verifying it.
5. **ADRs.** MADR 4.0, reduced to the template in the guidelines, with `status` and `date` in front matter and `supersedes`, `superseded-by`, `amends` and `amended-by` links. Numbers are sequential and never reused. An accepted ADR is never edited except for those front-matter fields; a wrong fact becomes a new ADR. Partial supersession is `amends`. An agent drafts ADRs as `proposed` only; the maintainer sets `accepted` or `rejected`. ADRs 0001 to 0009 stay Chinese; `docs/decisions/README.md` gives each an English title and a one-line summary.
6. **Agent entry point.** `AGENTS.md` is the canonical instructions file for every coding agent, and `CLAUDE.md` only includes it (PR #48).
7. **AI-written docs.** Docs drafted by agents follow the same rules and must read as written for people: every path, identifier, command and UI string was opened or run in the checkout; as-built and planned are marked separately; the PR says what was verified and how; no status, roadmap, summary or report files land in the repository.

The rules in full are `docs/reference/documentation-guidelines.md`, which lands in the next PR of the reorganisation. This ADR records that they were decided; the guidelines carry the detail and may change without a new ADR, except for the seven points above.

### Consequences

- Good: a reader opens one folder per kind of question, and the header says whether to trust the doc and against which commit.
- Good: reviewers check the mechanical rules (folder, header, language, ADR status) from the diff, and agents read the same rules from one file.
- Good: superseded decisions stay findable with their status; nothing in `decisions/` is moved or renumbered.
- Bad: the first pass is a sequence of PRs of moves, rewrites and translations, and about a third of the old docs end in `archive/`.
- Bad: `last-verified` goes stale unless someone re-verifies. A stale date is at least visible.
- Bad: Chinese-speaking contributors write developer docs in English, and some existing docs stay Chinese until rewritten, so the tree is bilingual for a while.

## More information

- The audit is published as `docs/records/2026-11-08-docs-audit.md` in the next PR of the reorganisation.
- Diátaxis: <https://diataxis.fr/>. MADR: <https://adr.github.io/madr/>. Google developer documentation style guide: <https://developers.google.com/style>. 阮一峰《中文技术文档的写作规范》: <https://github.com/ruanyf/document-style-guide>. 《中文文案排版指北》: <https://github.com/sparanoid/chinese-copywriting-guidelines>.
- PR #49 (the moves), PR #48 (`AGENTS.md`), and the PR that adds this ADR (status front matter on ADRs 0001 to 0010).
