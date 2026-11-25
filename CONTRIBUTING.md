# Contributing to AccreMind

Thanks for taking the time to contribute. This document covers everything you need to get productive: how to set up the repository, what a pull request must pass, and the conventions the codebase follows.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). Include the DSH version, Node version, and the smallest reproduction you can manage.
- **Propose a feature** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml). Describe the problem before the solution.
- **Improve documentation** — typos, unclear explanations and missing examples are all welcome; docs changes need no discussion first.
- **Send a pull request** — see [Pull request checklist](#pull-request-checklist).
- **Report a security issue** — do **not** open a public issue; follow [SECURITY.md](SECURITY.md).

If your change touches the knowledge lifecycle (triage, probation, verification, staleness, tuning), open an issue first so the design can be agreed on before code exists.

## Development setup

**Prerequisites**

| Tool | Version |
| --- | --- |
| Node.js | ≥ 24 (`node:sqlite` with FTS5 trigram is required) |
| pnpm | 10.17.1 (matches CI; `corepack enable pnpm` is enough) |

**Bootstrap**

```bash
git clone https://github.com/ninthmonee/AccreMind.git
cd AccreMind
pnpm install
pnpm verify
```

`pnpm verify` builds everything, runs the full test suite, and checks the workbench artifact fingerprint. If it passes on a clean checkout, your environment is correct.

## Repository layout

```
packages/
  core/            # kernel: storage, retrieval, triage, lifecycle, governance
  dsh-plugin/      # DSH host integration: tools, cordis patch, bootstrap, CLI
  webui/           # React workbench (Vite), inlined into the plugin at build time
scripts/           # build pipeline and artifact checks
tests/             # node:test suites (one file per concern)
docs/              # architecture, product and technical design, publishing guide
market/            # plugin marketplace index served over raw.githubusercontent.com
```

The webui is compiled and **inlined** into the plugin bundle. That is why the build has two entry points and why the fingerprint check exists.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | Build core, plugin and the inlined workbench artifact |
| `pnpm build:webui` | Rebuild only the workbench and write it back inline |
| `pnpm test` | Build, then run `node --test tests/*.test.ts` |
| `pnpm verify` | Build + tests + workbench fingerprint. **Run this before opening a PR.** |
| `pnpm typecheck` | Type-check the kernel packages and the workbench |
| `pnpm check:webui` | Compare `packages/webui` sources with the inlined artifact |
| `pnpm pack:check` | Validate the publishable package shape, including host compatibility |
| `pnpm market:index` | Regenerate `market/index.json` |
| `pnpm dev:webui` | Vite dev server with HMR for UI work |
| `pnpm ui -- --port 3180` | Run the standalone workbench |
| `pnpm accremind <cmd>` | Run the CLI from source |

## Coding conventions

- **TypeScript, ESM, no build-time transposition tricks.** Source runs directly on Node 24 via type stripping; avoid syntax that requires a transform.
- **No new runtime dependencies without a discussion.** The plugin intentionally ships zero third-party runtime deps so the marketplace bundle stays auditable. Dev dependencies are fine when they clearly pay for themselves.
- **`node:sqlite` only.** Do not introduce `better-sqlite3`, `sql.js` or an external vector store — the index must stay rebuildable from Markdown with the Node standard library.
- **Markdown stays the source of truth.** Anything persisted as knowledge must be readable, diffable and reviewable in a PR. Never let a derived store become the only copy.
- **Injection is read-only reference material.** Any new injection path must respect the per-layer token budgets, sanitise content, and be marked as material rather than instruction. It must never claim execution authority or override host rules.
- **Comments explain *why*.** The code says what it does; the comment should say which failure it prevents.
- **Formatting**: 2-space indent, single quotes, semicolons, no trailing whitespace. Match the surrounding file.

## Tests

- Tests use the built-in `node:test` runner; one file per concern under `tests/`.
- A behaviour change needs a test that fails before the change and passes after it. Bug fixes need a regression test.
- Filesystem tests must use temporary directories (`mkdtemp`) and clean up; never write into the repository or a real user's `~/.dsh`.
- Tests must not call a real model endpoint. Stub the `llm` service.
- Keep the suite fast: `pnpm verify` targets well under a minute on CI hardware.

## UI changes

1. `pnpm dev:webui` and iterate against the Vite dev server.
2. `pnpm build:webui` to reinline the artifact.
3. `pnpm verify` — `check:webui` fails when sources and the inlined bundle disagree, which is exactly how a UI change silently misses a release.

Screenshots in the PR description are appreciated for visual changes.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body — why, not what>

<footer — refs, breaking changes>
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `chore`. Scopes mirror packages: `core`, `plugin`, `webui`, `docs`, `market`, `ci`.

Examples:

```
fix(plugin): read the DSH version gate from top-level engines.dsh
docs(market): document the top-level engines.dsh requirement
feat(core): queue a re-check when a symbol anchor drifts
```

Keep the subject in the imperative mood, under 72 characters, without a trailing period. Reference the issue in the footer (`Closes #42`).

## Pull request checklist

Before requesting review, confirm:

- [ ] `pnpm verify` passes locally (build, tests, fingerprint).
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm pack:check` passes if anything under `packages/dsh-plugin` or `packages/core` changed.
- [ ] New behaviour has a test; bug fixes have a regression test.
- [ ] Documentation is updated when behaviour, configuration or CLI surface changes.
- [ ] `CHANGELOG.md` has an entry under *Unreleased* for user-visible changes.
- [ ] The PR description explains the problem, the approach, and how you verified it.
- [ ] No unrelated refactors are bundled in.

CI runs the same checks; a red build blocks review.

## Releasing

Releases are cut from `main` by a maintainer. The order matters because the marketplace index points at published tarballs:

1. Update `CHANGELOG.md` and bump the version in `packages/dsh-plugin/package.json`.
2. `pnpm verify && pnpm pack:check`.
3. `pnpm market:index` and commit the regenerated `market/index.json`.
4. Publish the package, then tag the release.

Details: [docs/market-publishing.md](docs/market-publishing.md).

## Questions

Open a [discussion](https://github.com/ninthmonee/AccreMind/discussions) or an issue labelled `question`. For anything you believe is a vulnerability, use [SECURITY.md](SECURITY.md) instead.
