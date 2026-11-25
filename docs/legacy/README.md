# Legacy design documents (V1 and V2)

These two documents record how the product was thought about before the current design. They are kept **verbatim** — the same bytes that were written in September 2026 — including figures, scope and mechanisms that later revisions replaced.

| Document | What it records | Version |
| --- | --- | --- |
| [AI 研发知识基座 思路 V1版本](<AI 研发知识基座 思路 V1版本.md>) | the first full product thinking: knowledge layering, signal-driven capture, cloud-delivered configuration, multi-source knowledge aggregation | V1 |
| [AI 研发知识基座 PRD V2 修订版](<AI 研发知识基座 PRD V2 修订版.md>) | the V2.1 PRD: knowledge-delta identification, field definitions, triage rules, consumption requirements, acceptance cases | V2.1 |

## Status

- **Not normative.** Where these documents and the code disagree, the code and [../ARCHITECTURE.md](../ARCHITECTURE.md) win. Read [the product design V3](<../AI 研发知识基座 DSH本地插件产品设计方案 V3.md>) and [the technical design V3](<../AI 研发知识基座 DSH本地插件技术实现方案 V3.md>) for what ships today.
- **Read them for the reasoning, not the specification.** They show which problems were considered, which mechanisms were proposed and why several of them were dropped — the decision history that the current documents only summarise.

## Provenance

Both files were written on 2026-09-11, moved to the repository root on 2026-09-13, and removed from the tree in 71f66e0 when the V3.1 design became authoritative. They were restored here from that commit without modification; `git hash-object` on each file still matches its blob in history.

Earlier revisions remain reachable through the history of this path, so the full evolution is `git log --follow docs/legacy`.
