# @accremind/dsh-plugin

**Models are always superseded by the next generation. Knowledge is not.** This is the [DeepSeek Harness](https://github.com/deepseek-ai) adapter for AccreMind — a local-first knowledge base for AI-assisted engineering. AccreMind turns the decisions you made while solving a problem, the domain rules and conventions you settled on, the traps you already fell into, and how each one refines, overrides or supersedes another into reusable Markdown knowledge assets, then hands them back through three budgeted injection layers.

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A524-339933.svg)](https://nodejs.org)

**AccreMind is not built for DSH only.** The engine, `@accremind/core`, is a zero-dependency Node.js library that knows nothing about any host; the CLI and the standalone workbench drive it directly. This package is the host integration: it maps AccreMind onto DSH turn hooks, tools, the sidebar panel and skill export. Another host — an IDE, a server — would be another package like this one, over the same public API. See the [project README](https://github.com/ninthmonee/AccreMind#host-model) for the full picture.

## What it solves

Model context rolls over, human memory decays, and documentation keeps the conclusion while dropping the reason. The knowledge that cost a team real time — *this retry double-charges*, *this library cannot be dynamically imported under SSR since 3.x*, *we tried the queue design and reverted it*, *this domain rule overrides the generic one* — is exactly what is missing when the next change is written.

AccreMind stores only that **knowledge delta**, as Markdown you can review in a pull request, with a rebuildable local SQLite index. No background service, no external vector store, no telemetry. The full list of what is worth accumulating — and what is deliberately never kept — is in the [project README](https://github.com/ninthmonee/AccreMind#what-we-accumulate).

## Install

```bash
dsh plugin install @accremind/dsh-plugin
```

Or from the marketplace: add `https://raw.githubusercontent.com/ninthmonee/AccreMind/main/market/index.json` under **Plugins → Experimental plugins → Custom plugin indexes**, then install **AccreMind** from Discover.

Requires **DSH ≥ 0.2.2-rc.5** (declared as `engines.dsh`; the host refuses to load the bundle below that range) and **Node.js ≥ 24** (`node:sqlite` with FTS5 trigram).

## What you get

- A sidebar **AccreMind** panel: overview, library, candidate review, rule documents, governance, turn receipts, Git radar.
- Entries injected as the conversation needs them, plus a per-turn receipt with one-click feedback.
- Six tools for the model:

| Tool | Purpose |
| --- | --- |
| `accremind_capture` | Submit a candidate and run five-way triage |
| `accremind_search` | Search by keyword, kind, layer or file path |
| `accremind_get` | Fetch full entry: preconditions, verification, evidence |
| `accremind_validate` | Record success or failure; `failure` suspends the entry |
| `accremind_export_skill` | Freeze a verified entry into a DSH skill |
| `accremind_propose_doc_change` | Propose a change to a rule document for human review |

## Configuration

Everything is optional; defaults are sensible. Configuration lives in the host's cordis patch:

```yaml
plugins:
  accremind:
    globalDir: ~/.dsh/accremind
    projectDirName: .accremind
    writeGate:
      mode: probation        # probation | auto | manual
      maxProbationExposures: 3
      assessmentMode: single_pass
    budgets:
      residentRulesTokens: 500
      turnRadarTokens: 300
      toolGuardTokens: 240
      toolReadMaxTokens: 1500
    autoCapture:
      enabled: true
    autoEvolve:
      tune: false            # weekly auto-tuning with observation window
      demote: false           # automatic demotion / archiving
```

| Key | Meaning |
| --- | --- |
| `globalDir` | Per-user state: drafts, queues, index, cross-repo layers (default `~/.dsh/accremind`) |
| `projectDirName` | In-repo knowledge directory (default `.accremind`, meant to be committed) |
| `writeGate.mode` | `probation` keeps new entries shadowed until validated; `auto` promotes immediately; `manual` requires review |
| `writeGate.maxProbationExposures` | Exposures without validation before a draft is archived |
| `budgets.*` | Per-layer token ceilings; the resident block is byte-stable so the KV cache survives |
| `autoCapture.enabled` | Let the host model propose candidates from a turn (needs an `llm` service) |
| `autoEvolve.tune` / `autoEvolve.demote` | Auditable, roll-back-able self-improvement; both off by default |

Retrieval, reminders, file guards and the staleness sweep run fully locally and need no API key. Only extraction calls a model: the plugin reuses the host `llm` service, or an external endpoint via `ACCREMIND_LLM_BASE_URL` / `ACCREMIND_LLM_MODEL` / `ACCREMIND_LLM_API_KEY`.

## Where knowledge lives

| Path | Contents |
| --- | --- |
| `<repo>/.accremind/entries/` | Verified cards (Markdown, revisions, evidence) |
| `<repo>/.accremind/rules/` | Resident rules |
| `<repo>/.accremind/docs/` | Domain, business rules, project norms, project profile |
| `~/.dsh/accremind/probation/` | Probation drafts, never written into the repo |
| `~/.dsh/accremind/index/` | Rebuildable SQLite index |
| `~/.dsh/accremind/tuning-history.jsonl` | Every auto-tuning step, undoable |

Run `accremind rebuild` at any time to rebuild the index from the Markdown.

## Design guarantees

- **Reference, not instruction** — injected inside read-only tags, sanitised, explicitly marked as material. No host override, no execution authority.
- **Only the delta** — five-way triage (`index_only / link_existing / knowledge_candidate / needs_confirmation / discard`) keeps reconstructible content out.
- **AI proposes, humans decide** — probation before verification; rule documents only change on human acceptance.
- **Reversible** — every automatic tuning and demotion is recorded and can be undone.

## Links

- [Full documentation](https://github.com/ninthmonee/AccreMind#readme)
- [Architecture and design principles](https://github.com/ninthmonee/AccreMind/blob/main/docs/ARCHITECTURE.md)
- [Changelog](https://github.com/ninthmonee/AccreMind/blob/main/CHANGELOG.md)
- [Issues](https://github.com/ninthmonee/AccreMind/issues)

## License

[MIT](./LICENSE) © 2026 AccreMind contributors
