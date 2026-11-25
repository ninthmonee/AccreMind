# Documentation

Start here, then dive into the document that matches your question.

## Reading order

| Document | Read it if you want to know | Length |
| --- | --- | --- |
| [Project README](../README.md) | what AccreMind is, how to install it, what it does | ~10 min |
| [Architecture](ARCHITECTURE.md) | vision, the seven principles, data flow, entry lifecycle, retrieval pipeline, self-improvement | ~20 min |
| [Introduction article](blog/2026-11-23-accremind-introduction.md) | the narrative version, written for a team deciding whether to adopt it | ~15 min |
| [Product design V3.2](<AI 研发知识基座 DSH本地插件产品设计方案 V3.md>) | scope, data model, acceptance criteria, what is deliberately out of scope | reference |
| [Technical design V3.2](<AI 研发知识基座 DSH本地插件技术实现方案 V3.md>) | module contracts, storage layout, retrieval and governance mechanics | reference |
| [Marketplace publishing](market-publishing.md) | package shape, index schema, release order, the `engines.dsh` constraint | ~10 min |

## By task

| I want to… | Go to |
| --- | --- |
| Install the plugin | [README → Quick start](../README.md#quick-start) |
| Understand why an entry was not promoted | [Architecture → Lifecycle](ARCHITECTURE.md) |
| Change retrieval budgets or the write gate | [README → Configuration](../packages/dsh-plugin/README.md#configuration) |
| Run the checks a PR needs | [CONTRIBUTING](../CONTRIBUTING.md) |
| Publish a release to the marketplace | [Marketplace publishing](market-publishing.md) |
| Understand the security posture | [SECURITY](../SECURITY.md) |
| See what changed | [CHANGELOG](../CHANGELOG.md) |

## Language status

The project's primary documentation language is **English** for the entry points (README, CONTRIBUTING, SECURITY, CHANGELOG, this index). The in-depth design documents are currently written in **Chinese**; they are the authoritative record of the V3.2 design and are translated incrementally.

| Document | Language |
| --- | --- |
| README, CONTRIBUTING, SECURITY, CHANGELOG, docs/README.md | English (+ [README.zh-CN.md](../README.zh-CN.md)) |
| ARCHITECTURE.md | Chinese |
| Product design V3.2 | Chinese |
| Technical design V3.2 | Chinese |
| market-publishing.md | Chinese |

English translations of the design documents are tracked as separate files (for example `ARCHITECTURE.en.md`) so the Chinese originals stay intact while both versions are compared during review.

## Conventions for contributors

- One document, one purpose. Design rationale belongs in `ARCHITECTURE.md`; step-by-step procedure belongs in the README or `CONTRIBUTING.md`.
- State the mechanism, not just the conclusion — a reader should be able to predict what the code does from the document.
- Prefer tables for enumerations (layers, dispositions, states) and prose for reasoning.
- Update the affected document in the same pull request that changes the behaviour. A doc that contradicts the code is a bug.
- Long-form prose for a general audience goes to `blog/`; normative design goes to the top level of `docs/`.
