# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/legacy/` — the V1 product thinking note and the V2 PRD revision, restored verbatim from history (blob-identical to their last committed revision). They were removed from the tree while the V3.1 design became authoritative and are now archived next to it instead of being reachable only through `git log`.

## [0.1.0] — first public release

The first version that is installable as a DSH plugin and publishable to the plugin marketplace.

### Added

- **Kernel (`@accremind/core`)** — Markdown-backed knowledge store with a rebuildable `node:sqlite` (WAL + FTS5 trigram) index; entries, revisions, evidence, rule documents, probation drafts, queues and per-user retrieval logs.
- **Five-way triage** — `index_only`, `link_existing`, `knowledge_candidate`, `needs_confirmation`, `discard`; candidates must carry a `knowledge_delta` to be promoted.
- **Three injection layers** — byte-stable resident rules, per-turn radar (id + summary, marked as reference), and file-scoped tool guard, each with its own token budget.
- **Probation and verification** — new entries are shadowed until validated; repeated exposure without validation archives them; a recorded counterexample suspends an entry immediately.
- **Freshness governance** — `watch_paths` plus symbol-anchor hashes; code drift or an expired review window queues a re-check, formatting-only edits do not.
- **Rule documents** — `domain`, `business_rules`, `project_norms`, `project_profile`, indexed per `##` section, with import, change proposals, accept/reject and a change log.
- **Cross-repository knowledge** — repository identity from `.accremind/repo.json`, then `origin`, then a path hash; `domain` and `shared_tech` layers surface across repositories.
- **Turn receipts and offline evaluation** — redacted question plus feedback per turn; `accremind eval` replays real and hand-written cases, `--grid` sweeps parameters, `--apply` writes back only when the score improves.
- **Optional auto-evolution** (off by default, `autoEvolve: { tune, demote }`) — weekly auto-tuning guarded by sample size, score gain, recall loss and rejection exposure, with an observation window and automatic rollback; automatic demotion and archiving with a full, undoable record.
- **DSH integration (`@accremind/dsh-plugin`)** — six tools (`accremind_capture`, `accremind_search`, `accremind_get`, `accremind_validate`, `accremind_export_skill`, `accremind_propose_doc_change`), a sidebar panel, turn receipts, and reuse of the host `llm` service with an external-endpoint fallback.
- **CLI** — `status`, `search`, `get`, `rebuild`, `bootstrap`, `migrate`, `repo`, `docs`, `eval`, `demotions`, `ui`.
- **Workbench** — seven views (overview, library, review, rule documents, governance, receipts, Git radar), inlined into the plugin bundle and also runnable standalone on loopback.
- **Marketplace publishing** — `market/index.json`, `check-publishable.mjs` and `market-index.mjs`; CI validates the package shape and the index on every push.
- Documentation set: architecture and design principles, product and technical design, marketplace publishing guide, introduction article.

### Changed

- The DSH version requirement is declared as top-level `engines.dsh`; `dsh.engines` is not read by the host and is rejected by the publish check.
- Injected content is always labelled as reference material and carries no execution authority.

### Fixed

- Publish check now verifies host compatibility through the host's own `evaluatePluginCompatibility`, so a bundle that DSH would refuse is caught before release.
- Workbench artifact drift is caught by `pnpm check:webui` and enforced in `pnpm verify`.

### Requirements

- Node.js ≥ 24 (`node:sqlite` with FTS5 trigram).
- DeepSeek Harness ≥ 0.2.2-rc.5.

[Unreleased]: https://github.com/ninthmonee/AccreMind/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ninthmonee/AccreMind/releases/tag/v0.1.0
