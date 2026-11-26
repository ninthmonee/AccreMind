# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/brand/` — SVG and PNG icon assets, monochrome variants, a size preview and a downloadable icon kit.
- Repository exclusion: `.accremind/repo.json` now carries two switches — `capture` (default `true`) keeps a repository out of the knowledge pipeline, and `share` (default `true`) isolates it from cross-repository retrieval in both directions. Both live with the repository so every clone agrees, are exposed as **Git radar → Exclude project** in the workbench (`accremind.repo.setSettings`), and are enforced throughout the kernel: manual and automatic capture, pending queue drains, Git scans and extraction obey the capture switch. Sharing policy applies to search, direct reads, admin lists, duplicate suggestions and shared rule documents, including repository-origin global entries. Originless machine-wide knowledge remains available; pending work is paused rather than discarded.
- `docs/legacy/` — the V1 product thinking note and the V2 PRD revision, restored verbatim from history (blob-identical to their last committed revision). They were removed from the tree while the V3.1 design became authoritative and are now archived next to it instead of being reachable only through `git log`.

### Changed

- Use a teal layered A icon across both README titles, the plugin marketplace, the DSH sidebar, the workbench header and the browser tab. The workbench header and favicon share the plugin's SVG, which is included in the workbench source fingerprint.
- `scripts/release-npm.sh` now injects the npm token as `npm_config_//registry.npmjs.org/:_authToken` for the publish step. `pnpm publish` does not read the token from a userconfig or a project `.npmrc`, and the resulting failure is `403 ... two-factor authentication ... is required`, which reads like a token-permission problem even when the token already has Bypass 2FA. The marketplace guide documents both the symptom and the `npm stage publish` / `npm stage approve` fallback.
- Repositioned the documentation: AccreMind is no longer described as "a plugin for DeepSeek Harness". The kernel `@accremind/core` has no host dependency; the DSH plugin is the first (and currently most complete) host integration, and `~/.dsh/accremind/` plus `.dsh/skills/` are adapter conventions rather than engine defaults. README (both languages), `packages/dsh-plugin/README.md`, `docs/ARCHITECTURE.md`, the introduction article, the publishing guide and the package `description` fields all follow that framing. A dedicated **Host model** section in the README maps the three front doors (DSH plugin, CLI, standalone workbench) onto the same public API.

### Fixed

- Rolled the npm `latest` tags and both marketplace manifests back to `0.2.0` after the erroneous duplicate `0.2.1`–`0.2.3` bumps. `@accremind/dsh-plugin@0.2.1` was removed; the three core duplicates remain published because npm blocks unpublishing a package that has dependents, but they are no longer selected by default.
- `scripts/release-npm.sh` can resume a partially completed release: it verifies that both packages carry the same version, skips versions already present on npm, then publishes the missing package and refreshes the marketplace index. Previously a successful core publish followed by a plugin failure made every retry stop at the already-published core version.
- The DSH sidebar entry now draws the same layered A as `packages/dsh-plugin/icon.svg` (rounded surface, two gradients, three strokes) instead of a `currentColor` outline, so the sidebar, the workbench header, the browser tab and the marketplace all show one mark. A test asserts the paths and gradient stops against the SVG so the two cannot drift apart.
- Long commit bodies, diff rows and touched-file chips in the Git radar no longer widen the list: the expanded card is a `min-w-0` grid and long unbroken strings wrap (`break-words` / `[overflow-wrap:anywhere]`, `break-all` on file chips).
- Select README wordmarks using GitHub's page theme markers, so manually selected dark mode shows light text even when the system theme is light.
- Align the README title icon and text in self-contained SVG wordmarks with light and dark variants, avoiding GitHub's inline image baseline offset.
- Corrected the DSH install instructions. `dsh plugin` forwards its arguments to pnpm inside the profile directory, so the previously documented `dsh plugin install <pkg>` never worked: `pnpm install` takes no package argument. The documented path is now the plugin index plus `dsh plugin --profile <profile> add @accremind/dsh-plugin`, and it states that the `desktop` profile is owned by the Electron application and only accepts interface installs.
- Documented that a *plugin index* and a *plugin catalog* are two different mechanisms. The index (`market/index.json`) feeds DSH's official market only; the third-party dshmarket reads catalogs, refuses installs for anything outside its current registry (`{"error":"plugin is not in the curated registry"}`), and — on this desktop build — hides its catalog settings page entirely, so the catalog has to be registered through `POST /dsh-market/catalogs/add`. Both READMEs now branch on the marketplace the host actually ships instead of assuming one.

## [0.1.0] — 2026-11-25

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
