<div align="center">

# ![AccreMind](docs/brand/accremind-wordmark-dark.svg#gh-dark-mode-only)![AccreMind](docs/brand/accremind-wordmark-light.svg#gh-light-mode-only)

**Models are always superseded by the next generation. Knowledge is not.**

Turn the experience scattered across your projects into reusable knowledge assets.

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/ninthmonee/AccreMind/actions/workflows/ci.yml/badge.svg)](https://github.com/ninthmonee/AccreMind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A524-339933.svg)](https://nodejs.org)
[![Core: host-agnostic](https://img.shields.io/badge/core-host--agnostic-6c6cf0.svg)](#host-model)
[![DSH plugin](https://img.shields.io/badge/DSH%20plugin-%E2%89%A50.2.2--rc.5-4d6bfe.svg)](#deepseek-harness-dsh)

</div>

AccreMind is a local-first knowledge base for AI-assisted engineering. It turns the experience scattered across your projects — the decisions, the abandoned routes, the domain rules and shared conventions, the traps already fallen into, and how all of it connects — into Markdown knowledge assets you can commit, review and reuse. Then it puts them back in front of the model and the developer right before the next change.

Everything stays on your machine: Markdown is the source of truth, `node:sqlite` (WAL + FTS5 trigram) is only ever a rebuildable index. No background service, no external vector store, no telemetry.

---

## Table of contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Host model](#host-model)
- [What we accumulate](#what-we-accumulate)
- [Three injection layers](#three-injection-layers)
- [Features](#features)
- [Quick start](#quick-start)
- [Host integrations](#host-integrations)
- [Standalone workbench](#standalone-workbench)
- [Team knowledge base, domains and mounting scope](#team-knowledge-base-domains-and-mounting-scope)
- [Where the data lives](#where-the-data-lives)
- [Excluding a repository](#excluding-a-repository)
- [CLI](#cli)
- [Model access (optional)](#model-access-optional)
- [Design principles](#design-principles)
- [How it compares](#how-it-compares)
- [Non-goals](#non-goals)
- [Requirements](#requirements)
- [Development](#development)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## The problem

Model context rolls over. Human memory decays. Documentation keeps the conclusion and throws away the reason.

The knowledge that actually cost a team something — "retrying this endpoint double-charges", "this library cannot be dynamically imported under SSR since 3.x", "we tried the queue-based design and reverted it" — lives in a chat thread, a postmortem, or one person's head. It is exactly the knowledge that is missing at the moment the next change is written, and exactly the knowledge an AI assistant cannot infer from the repository.

AccreMind stores that delta and nothing else.

## How it works

Three moments, one knowledge base:

| Moment | What happens |
| --- | --- |
| **Before a change** | Entries that match the turn are injected as *references* — id plus one-line summary, explicitly marked as material, not instructions |
| **During a change** | Touching a file that an entry watches unfolds the full entry: preconditions, counterexamples, how to verify, where the evidence is |
| **After a change** | A turn-tail receipt lists what was used, with one-click "helpful / not helpful / inaccurate" feedback |

## Host model

AccreMind does not belong to any one host. The engine, `@accremind/core`, is a zero-dependency Node.js library — it imports nothing but `node:*` built-ins — and it is driven by three front doors that share the same public API:

| Front door | Package | Needs a host? |
| --- | --- | --- |
| Plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) | `@accremind/dsh-plugin` | Yes — the first host integration, and the most complete one |
| Command line | `accremind` (in `@accremind/core`) | No |
| Standalone workbench | `@accremind/webui` | No |

DSH is the first adapter, not the design centre: turn hooks, tools, the sidebar panel and skill export are the surface a host can offer, and every one of them is a thin mapping onto the kernel. Adding another host — an IDE extension, a server — means writing an adapter that calls the public API and expresses the same three layers in that host's own vocabulary.

The DSH integration does carry DSH-shaped defaults: per-user state lives in `~/.dsh/accremind/` (override it with `globalDir`) and exported skills land in `.dsh/skills/<slug>/SKILL.md`. Those paths are conventions of the adapter, not of the engine's data model — the knowledge itself is plain Markdown in the repository.

## What we accumulate

"The experience scattered across projects" is not a slogan here — it is six concrete kinds of knowledge, each with a home in the store:

| Kind | What it looks like in practice | Entry type | Layer |
| --- | --- | --- | --- |
| **Decisions and their reasoning** | why this design, what it cost, what it rules out next time | `decision` | `project` |
| **Traps and abandoned routes** | "retrying this endpoint double-charges"; "we tried the queue design and reverted it" | `pitfall` | `project` |
| **Domain rules** | business invariants, temporal rules, what a settled order may never become | `model` / `guideline` | `domain` |
| **Shared conventions** | naming, error envelope, migration pattern, review expectations | `guideline` / `process` | `project`, and `team_rule` once accepted as a team norm |
| **Shared-tech gotchas** | "this library cannot be dynamically imported under SSR since 3.x" — true in every repository | `model` / `pitfall` | `shared_tech` |
| **Process knowledge** | how a release, rollout or incident is actually handled here | `process` | `project` / `personal` |

Two properties make this a body of knowledge rather than a pile of notes:

- **Relations are part of the record.** An entry states what it `supersedes`, which shared-tech entry it `specializes`, which team rule it `overrides`, and which `tags` and `domains` it belongs to. A specialised pair is never served together, so refinement replaces contradiction instead of adding to it.
- **Scope decides who gets it.** A `personal` entry stays with you, `project` stays in the repository, `domain` and `shared_tech` travel to other repositories, and `team_rule` is organisation-wide — it is only ever proposed by a person, never written by automatic capture, and is exempt from automatic demotion.

### What is deliberately not accumulated

- Anything the code, tests or existing docs already say.
- Diffs and file listings that `git log` regenerates for free.
- Machine-local paths and one-off environment noise.
- Unverified guesses: they wait in `needs_confirmation` for a human, and are dropped if nobody vouches for them.

### How a candidate is filtered

Only a `knowledge_delta` — the part a reader could not reconstruct from the code and the existing docs — is accepted. Every candidate goes through five-way triage:

| Disposition | Meaning |
| --- | --- |
| `index_only` | Already discoverable in code/docs; index it for retrieval, do not store a card |
| `link_existing` | Duplicate of an entry we already have; link to it instead |
| `knowledge_candidate` | A real delta; promote into a Markdown card |
| `needs_confirmation` | Plausible but unverified; park it until a human decides |
| `discard` | Empty delta, a guess, or a machine-local path; drop it |

New cards start in `probation`. They become `verified` only after being surfaced by real turns and validated — no silent self-promotion.

## Three injection layers

| Layer | Fires on | Default budget | Role |
| --- | --- | --- | --- |
| Resident rules | Start of every turn | 500 tokens | Team hard constraints; byte-stable so the KV cache survives |
| Turn radar | Each turn, by query | 300 tokens | Matching entries by id, marked as reference material |
| Tool guard | Reading/writing a watched file | 240 / 1500 tokens | Unfolds the full entry when the same file is touched |

All three are read-only reference material. They never override host rules and have no execution authority.

## Features

- **Local-first, two-tier storage** — team knowledge lives in `.accremind/` inside the repo (commit it, review it in PRs); drafts, queues, indexes and per-user retrieval logs live in `~/.dsh/accremind/`. The index can be rebuilt from the Markdown at any time.
- **Five-way triage** — `index_only / link_existing / knowledge_candidate / needs_confirmation / discard`, so code-recoverable input never pollutes the base.
- **Shadow probation** — new entries are used quietly, then promoted on independent validation. Repeated exposure without feedback archives them.
- **Staleness and symbol anchors** — entries record `watch_paths` and symbol-anchor hashes. Code changes or an expired review window push the entry into a re-check queue; a counterexample suspends it immediately. Formatting-only edits do not raise false alarms.
- **Rule documents** — `domain` / `business_rules` / `project_norms` / `project_profile` are indexed by `##` section, with import, change proposals, accept/reject and a change log, written to `.accremind/docs/` and reviewed with the code.
- **Cross-repository knowledge** — repository identity comes from `.accremind/repo.json`, then `origin`, then a path hash. Entries in the `domain` and `shared_tech` layers surface across repositories in the same domain.
- **Structured relations** — an entry can declare what it `supersedes`, which shared-tech entry it `specializes`, and which team rule it `overrides`, and it shares controlled `tags` and `domains` with related knowledge. Relations are honoured at serving time — a specialised pair is never delivered together — so the structure survives instead of decaying into prose links.
- **Receipts and offline evaluation** — every turn keeps a redacted question plus feedback; `accremind eval` replays real feedback and the real questions written in `.accremind/eval/cases.jsonl`, and reports three arms side by side: nothing shown at all (`off`), resident team rules only (`rulesOnly`), and the full reminder path. `lift` is what the last one adds over the first two. `--grid` sweeps parameters, `--apply` writes back only when the score improves.
- **Workbench** — seven views covering overview, library, candidate review, rule documents, governance, turn receipts and a Git radar. A verified entry can be exported to `.dsh/skills/<slug>/SKILL.md`.
- **Self-improvement, unattended and reversible** — configurable via `autoEvolve: { tune: false, demote: false }`:
  - *Auto-tuning* runs one minute after a session opens, at most once a week per repository. It only applies when there are ≥ 30 labelled samples, the score improves by ≥ 0.03, recall drops by no more than 0.02, and rejected entries do not surface more often. It then enters an observation window and rolls itself back if either the adjusted feedback or the real "does not apply" rate gets worse. Every step is recorded in `~/.dsh/accremind/tuning-history.jsonl` and can be undone.
  - *Demotion* moves a verified entry back to probation when at least two sessions in the current revision flag it as "not applicable" at ≥ 25% of exposures, or when it has been surfaced in ≥ 40 sessions over 30 days and never opened, quoted or confirmed. Suspended entries archive after 30 days untouched; probation drafts after 60. Team norms, entries confirmed on the current revision, and counterexample-backed entries are exempt. Every action lands in the overview's *needs your attention* list with a one-click undo.

## Quick start

### From source (current, recommended until the npm release)

```bash
git clone https://github.com/ninthmonee/AccreMind.git
cd AccreMind
pnpm install
pnpm build      # builds core, plugin and the inlined workbench bundle
pnpm verify     # build + full test suite + workbench artifact fingerprint
```

Then link the plugin into a DSH profile:

```bash
pnpm install:dsh                      # desktop profile by default
pnpm install:dsh -- --profile web     # or a specific profile
```

### From a plugin marketplace

The package is published as `@accremind/dsh-plugin`. What you see depends on which marketplace the host has installed:

- **Official plugin market** (`@deepseek-ai/dsh-experimental-plugin-market-bundle`): open **Manage index sources… → Add index source**, paste the index URL below, then install **AccreMind** from **Discover**.
- **dshmarket** (third-party): it reads *catalogs*, not indexes. Give it a catalog file that holds one entry:

  ```json
  {"plugins":[{"name":"ninthmonee/AccreMind#dsh-plugin","url":"https://github.com/ninthmonee/AccreMind/tree/main/packages/dsh-plugin","category":"memory","npm":"@accremind/dsh-plugin"}]}
  ```

  dshmarket accepts an `http(s)://` URL, a `file://` URL or an absolute path.
- **No marketplace**: install from the CLI (any profile except `desktop`) or copy the package into the profile by hand.

Index URL used by the official market:

```
https://raw.githubusercontent.com/ninthmonee/AccreMind/main/market/index.json
```

Release mechanics are documented in [docs/market-publishing.md](docs/market-publishing.md).

## Host integrations

### DeepSeek Harness (DSH)

The reference adapter. Requires **DSH ≥ 0.2.2-rc.5** (declared as `engines.dsh`; the host refuses to load the bundle below that range) and **Node.js ≥ 24**.

#### Install inside the desktop app

1. Point the marketplace at the index (official market) or at a catalog (dshmarket), as described in
   [From a plugin marketplace](#from-a-plugin-marketplace).
2. Find `AccreMind` in the market list and install it.
3. Bundle activation is hot: an **AccreMind** entry shows up in the sidebar and the six tools below become
   available to the model. If your host does not hot-load bundles, reload the window.

Nothing else is required: the store is created on first use under `~/.dsh/accremind/` and `<repo>/.accremind/`.

#### Install into any other profile

The same build is on npm. `dsh plugin` forwards its arguments to pnpm inside the profile directory, so `add`, `remove` and `why` all work:

```bash
dsh plugin --profile <profile> add @accremind/dsh-plugin
dsh plugin --profile <profile> remove @accremind/dsh-plugin   # uninstall
```

The `desktop` profile is owned by the Electron application and rejects CLI writes — install there through the interface. A profile that has never been booted does not exist yet, so start DSH once with it before adding plugins.

Once installed, an `AccreMind` panel appears in the sidebar, entries are injected as the conversation needs them, and a receipt is appended to each turn. Six tools are available to the model:

| Tool | Purpose |
| --- | --- |
| `accremind_capture` | Submit a candidate and run five-way triage |
| `accremind_search` | Search by keyword, kind, layer or file path |
| `accremind_get` | Fetch full text, preconditions, verification steps and evidence |
| `accremind_validate` | Record a success or failure for this use; `failure` suspends the entry |
| `accremind_export_skill` | Freeze a verified entry into a DSH skill document |
| `accremind_propose_doc_change` | Propose a change to a rule document for human review |

## Standalone workbench

The same UI runs without DSH (port 3180, loopback only):

```bash
pnpm ui -- --port 3180
```

| View | What it answers |
| --- | --- |
| Overview | What needs my attention, how healthy is the base |
| Library | Browse, search and summarise every entry |
| Review | Compare baseline against delta, check evidence |
| Rule documents | Domain, business rules, project norms and pending proposals |
| Governance | Staleness re-checks, counterexamples, settings |
| Receipts | Which entries each turn actually used |
| Git radar | Scan commit history for high-signal experience |

For UI work use `pnpm dev:webui` (Vite HMR). Before releasing, always run `pnpm verify`: `check:webui` compares the `packages/webui` sources with the inlined artifact so a UI change cannot silently miss the published bundle.

## Team knowledge base, domains and mounting scope

Where a piece of knowledge belongs decides who gets reminded of it. AccreMind mounts knowledge in three layers:

| Mounted to | Best for | Stored in | Reminded to |
| --- | --- | --- | --- |
| This project `project` | Project norms, project profile, business rules that only apply to this repository | `<repo>/.accremind/docs/` | This repository; can be narrowed to one sub-project |
| Domain `domain` | Domain descriptions, business rules shared across projects | Team knowledge base (this repository when none is mounted) | Every project in that domain, sub-domains included |
| Personal `personal` | Personal preferences (answer style, habits) | `~/.dsh/accremind/personal/docs/<user>/` | Only you; never committed |

**The team knowledge base** is a separate Git repository for what the team shares and no single project owns:

```
<team knowledge base>/
├── domains/<domain>.json        # one file per domain: name, aliases, parent, owners
├── members/<repo>.json          # one file per repository: its domains (core / consumer, optionally per sub-project)
├── docs/<category>/*.md          # domain documents + changes.ndjson + CHANGELOG.md
└── feedback/<repo>/<user hash>.json  # per-person usage counts (counts only, never prompts)
```

```bash
pnpm accremind team set ~/code/team-knowledge     # mount; otherwise ~/.dsh/accremind/knowledge/ on this machine
pnpm accremind domains add refund --parent payment --aliases refund --owners lead@example.com
pnpm accremind domains join refund                   # this repository joins as a core project
pnpm accremind domains join payment --role consumer   # caller only: sees rules meant for everyone, not core-only details
pnpm accremind subprojects add pay --paths services/pay/ --domains payment --owners pay-dev@example.com
pnpm accremind docs import refund.md --category business_rules --scope domain --domains refund [--audience core]
pnpm accremind docs import norms.md --category project_norms --subproject pay
pnpm accremind docs import my-prefs.md --category personal_preferences
```

- A domain can contain many projects, and a project can join many domains; rules from a parent domain reach projects in its sub-domains.
- The catalog is split per domain and per repository member file, so two people adding a domain or joining one never edit the same file and Git merges stay clean. An older `domains.json` is split automatically on the first change.
- With a team knowledge base mounted, importing into a domain that is not in the catalog is refused (to prevent spelling forks); pass `--new-domain` when it really is new. The workbench import dialog can create the domain (optionally with a parent) and make this repository join it.
- The workbench importer accepts Markdown uploads (multi-select, drag and drop) and direct paste.
- Mounting to "this project" can target another project: the open one by default, another registered on this machine, or any folder picked from the browser.
- Domains and memberships built on this machine before a team knowledge base existed are carried over once on mount; files the team already has win.
- AccreMind only writes files — it never commits or pushes for you. The rule documents page shows how many changes in `.accremind/` and the team knowledge base are uncommitted, unpushed or unpulled.
- The rule documents page filters by mounting scope, domain (sub-domains and aliases included) and storage location, and full-text searches section content; the library filters entries by domain and sub-project.
- Personal preferences follow the person: switching between the local identity and the host login moves them to the current identity.
- When rules collide: team rules > project norms and experience > domain rules > personal preferences. Personal preferences are resident but last.
- When an entry's evidence cites a document section (`D:<doc>#<section>`) and that section is edited or deleted, the entry goes back for review automatically.
- Turn receipts state why each reminder matched; reporting "does not apply" lets you pick a reason (wrong domain, not this project or sub-project, wrong version, outdated, unrelated to this question).

**Project-level settings** live in `.accremind/repo.json` and are reviewed with the repository:

```json
{
  "domains": ["refund", "payment:consumer"],
  "owners": ["team-lead@example.com"],
  "projects": [{ "id": "pay", "paths": ["services/pay/"], "domains": ["refund"], "owners": ["pay-dev@example.com"] }],
  "settings": {
    "budgets": { "turnRadarTokens": 400 },
    "tuning": { "textSaturation": 6 },
    "autoDemotion": { "demoteUnusedShownSessions": 12 }
  }
}
```

**Keeping a repository out** uses the same `settings` block, reviewed with the repository and effective for everyone who clones it:

```json
{
  "settings": {
    "enabled": false,
    "excludePaths": ["vendor/", "dist/", "third_party/protobuf/"]
  }
}
```

- `enabled: false` pauses the whole repository: no injected rules, no reminders, no file guard, no capture, no automatic tuning. Read-only commands such as `accremind search` and `accremind digest` keep working.
- `excludePaths` only excludes prefixes inside the repository (vendored trees, generated code): those files get no file guard and stay out of the turn's changed-file signals. Absolute paths, `~` paths and entries containing `..` are ignored.
- From the CLI: `accremind repo pause` / `repo resume` / `repo exclude vendor/ dist/` / `repo unexclude vendor/`; plain `accremind repo` prints the current scope.
- The switches are re-read every turn, so a change applies on the next turn without restarting the host.

A project with a custom `settings.tuning` opts out of automatic tuning. Owners decide who the to-do belongs to: experience looks for the domain owner → sub-project owner → repository owner, and the workbench can show "only mine"; `pnpm accremind digest` prints the last seven days (pending, automatic demotions, document changes, tuning, reminder quality), addressing the reader by their Git user name.

## Where the data lives

| Path | Contents |
| --- | --- |
| `<repo>/.accremind/entries/` | Verified experience cards (Markdown, with revisions and evidence) |
| `<repo>/.accremind/evidence/` | Evidence attachments |
| `<repo>/.accremind/rules/` | Resident rules |
| `<repo>/.accremind/docs/` | The four rule document kinds and their change log |
| `<repo>/.accremind/repo.json` | Repository identity, business domains, sub-projects, owners and project settings (commit this) |
| `<team knowledge base>/` | Domain catalog, domain documents and team usage counts (a separate Git repository) |
| `~/.dsh/accremind/knowledge.json` | Where the team knowledge base is mounted (`ACCREMIND_KNOWLEDGE_ROOT` overrides) |
| `~/.dsh/accremind/personal/docs/` | Personal preference documents, per user |
| `~/.dsh/accremind/probation/` | Probation drafts (never written into the repo) |
| `~/.dsh/accremind/queue/` | Auto-capture and evaluation queues |
| `~/.dsh/accremind/index/` | Rebuildable SQLite index |
| `~/.dsh/accremind/{personal,domain,shared-tech}/` | Cross-repository knowledge layers |
| `~/.dsh/accremind/{registry,users,workspaces}/` | Repository registry, user identity, per-repository retrieval logs |

## Excluding a repository

Some repositories should not feed the knowledge base at all, and some should not trade knowledge with
sibling repositories. Both switches live inside the repository itself, in `.accremind/repo.json`, so they
travel with its commits and every clone — and every machine — agrees on them.

| Field | Default | Effect when `false` |
| --- | --- | --- |
| `capture` | `true` | The Git radar skips the repository, and manual plus automatic capture write nothing. Entries already in the library stay and keep being served. |
| `share` | `true` | Two-way isolation: this repository's knowledge is not served elsewhere, and knowledge from other repositories is not served here. This includes repository-origin personal, domain and shared-tech entries stored in the global index, plus shared rule documents. Originless machine-wide knowledge remains available. |

In the workbench open **Git radar → Exclude project** and flip the two switches; the panel writes
`repo.json` for you and the radar refreshes in place. Or edit the file directly:

```json
{ "repo_id": "acme-payments", "domains": ["payments"], "capture": true, "share": false }
```

Both switches are enforced in the kernel, not only in the interface. `capture: false` stops new manual and automatic capture, skips Git scans and extraction, and pauses pending jobs without consuming them. `share: false` is checked on search, reads by ID, the workbench library, duplicate suggestions and rule-document retrieval. Existing knowledge and its governance history are retained. Re-enabling a switch takes effect without rebuilding the shared index.

## CLI

```bash
pnpm accremind status                     # overview + staleness sweep
pnpm accremind search "order retry" --scope auto --file packages/core/src/store/local-store.ts
pnpm accremind get K-XXXX                 # full entry
pnpm accremind rebuild                    # rebuild the index from Markdown
pnpm accremind bootstrap --top 10         # scan Git history for high-signal commits
pnpm accremind bootstrap --extract        # hand them to the model for triage
pnpm accremind migrate                    # cross-repo migration rehearsal; --apply, --rollback
pnpm accremind repo --domains payments,ledger:consumer [--new-domain]
pnpm accremind repo                       # current scope: paused? which prefixes are excluded?
pnpm accremind repo pause | resume        # pause the whole repository / resume it
pnpm accremind repo exclude vendor/ dist/ # exclude repository prefixes (unexclude reverts)
pnpm accremind team [set <dir> | unset]  # team knowledge base
pnpm accremind domains [list | add | join | leave]
pnpm accremind subprojects [list | add <id> --paths a/,b/ | remove <id>]
pnpm accremind docs import ./adr --category business_rules --scope domain --domains refund
pnpm accremind docs list --scope domain --domain payment   # also --category, --query
pnpm accremind docs search partial refund
pnpm accremind docs proposals             # pending document and vocabulary proposals
pnpm accremind docs accept <proposal-id>
pnpm accremind eval                       # replay feedback + cases.jsonl, with off / rulesOnly baselines
pnpm accremind eval --grid --apply        # replay feedback, tune, write back only if better
pnpm accremind eval auto                  # run one tuning cycle now (incl. observation verdict)
pnpm accremind eval history               # tuning history and observation state
pnpm accremind eval rollback              # undo the last tuning
pnpm accremind usage [--days 7]           # model calls and tokens spent on extraction and topic tagging
pnpm accremind demotions [--all]          # automatic demotion / archive records
pnpm accremind demotions restore K-XXXX   # undo a demotion or archive
pnpm accremind digest [--days 7] [--json]   # recent digest: pending, automatic changes, document changes, reminder quality, model usage
pnpm accremind ui --port 3180
```

Every command accepts `--repo` and `--global-dir`, defaulting to the current directory and `~/.dsh/accremind`.

## Model access (optional)

Retrieval, reminders, file guards and the staleness sweep are entirely local and need no key. Only **extraction** (`bootstrap --extract`, extraction in the workbench, and auto-capture when enabled) calls a model. The plugin reuses the host's `llm` service by default; an external endpoint can be configured with environment variables:

```bash
cp .env.example .env
# ACCREMIND_LLM_BASE_URL / ACCREMIND_LLM_MODEL / ACCREMIND_LLM_API_KEY
# or DEEPSEEK_API_KEY / OPENAI_API_KEY
```

Keys are only sent to the service they belong to: a custom `ACCREMIND_LLM_BASE_URL` pointing at another host never receives a DeepSeek or OpenAI key.

## Design principles

| # | Principle | What it means in the implementation |
| --- | --- | --- |
| 1 | Only the delta | Baseline answer is generated from code and docs first; triage drops anything reconstructible |
| 2 | Local-first, Markdown is the source of truth | Every entry is a reviewable card; SQLite is a rebuildable index |
| 3 | Reference, not instruction | Injected inside read-only tags, sanitised, marked as material; no host override, no execution |
| 4 | Evidence and freshness before conclusions | Entries carry evidence locations and symbol anchors; code drift queues a re-check |
| 5 | AI proposes, humans decide | Probation before verification; rule documents and vocabularies only change on human acceptance |
| 6 | Respect the context budget | Per-layer token budgets; byte-stable resident block for KV cache; silence when relevance is uncertain |
| 7 | Self-improvement you can audit and undo | Retrieval parameters auto-tune and auto-roll-back; knowledge content is never rewritten automatically |

## How it compares

| | AccreMind | `AGENTS.md` / `CLAUDE.md` | Wiki / ADR | Chat-memory assistants |
| --- | --- | --- | --- | --- |
| What is stored | Only the delta code cannot give back | Whatever gets pasted in | Decisions, rarely the traps | Past conversation turns |
| Where it lives | Markdown cards in the repo + local index | One flat file, hand-edited | Prose, human search only | Usually cloud embeddings |
| When it reaches the model | Three budgeted moments | Every turn, whole file | When a human reads it | Similarity match |
| Freshness | Symbol anchors, watch paths, re-check queue | None | Manual | None |
| Verification | Probation → verified on real use | None | Review, if any | None |
| Leaves your machine | No | No | Depends | Usually yes |

## Non-goals

- Not a general-purpose chat memory or a personal note app.
- Not a code knowledge graph or an index of your repository's structure.
- Not a replacement for ADRs — it complements them by keeping what ADRs usually omit.
- It never writes code, never runs commands, and never overrides the host's rules.

## Requirements

- **Node.js ≥ 24** — `node:sqlite` with FTS5 trigram tokenisation.
- **DeepSeek Harness ≥ 0.2.2-rc.5** — only if you use the plugin; declared as `engines.dsh`, and DSH refuses to install or start the bundle below that range. The CLI and the standalone workbench need nothing but Node.js.

## Development

```bash
pnpm build          # build core, plugin and the workbench artifact
pnpm build:webui    # rebuild only the workbench and write it back inline
pnpm test           # node:test (builds first)
pnpm verify         # build + tests + artifact fingerprint — run before every PR
pnpm typecheck      # kernel + workbench type checks
pnpm pack:check     # verify the published package shape (incl. host compatibility)
pnpm market:index   # regenerate market/index.json
```

CI runs `pnpm verify`, `pnpm pack:check` and the market index check on every push. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Documentation

- [Architecture and design principles](docs/ARCHITECTURE.md) — vision, seven principles, data flow, lifecycle, retrieval pipeline, self-improvement
- [Product design V3.2](<docs/AI 研发知识基座 DSH本地插件产品设计方案 V3.md>) — scope, data model, acceptance criteria
- [Technical design V3.2](<docs/AI 研发知识基座 DSH本地插件技术实现方案 V3.md>) — module contracts, retrieval and governance
- [Marketplace publishing](docs/market-publishing.md) — package shape, index schema, release order
- [Legacy V1 / V2 design](docs/legacy/README.md) — the September 2026 design notes, archived verbatim
- [Introduction article](docs/blog/2026-11-23-accremind-introduction.md) — a long-form introduction for teams
- [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)

Deep-dive documents are currently written in Chinese; English translations are tracked in [docs/README.md](docs/README.md).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers the local setup, the checks a PR must pass, and the commit conventions. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 AccreMind contributors
