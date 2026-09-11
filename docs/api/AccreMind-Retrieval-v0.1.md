# 检索与离线评测 v0.1

状态：Implemented，2026-09-10。此阶段对应技术选型开发顺序第 6 项。

## 召回链路

```text
RecallRequest
→ 身份 scope 与请求 scope 取交集（越权直接 403）
→ 只读取 Published 语料（Candidate / Paused / Expired 默认不可召回）
→ 确定性 FTS（to_tsvector('simple') + ts_rank_cd）
→ pgvector 余弦相似度（可选，取决于是否配置 embedding）
→ RRF 融合（k=60）
→ 适用性过滤（project / phase / technology）
→ trigger 命中加权
→ token 预算裁剪
→ Experience Pack
```

关键词查询用 `to_tsquery('simple', ...)` 的 OR 组合：词项已在上游清洗，不含 tsquery 语法，
OR 允许部分命中。向量召回以 `distance <= 1 - embedding_min_similarity` 过滤，默认
`embedding_min_similarity = 0.3`。

## 降级行为

召回**永远不会**因为模型服务不可用而失败：

| 情况 | mode | gaps |
| --- | --- | --- |
| PostgreSQL + 向量可用 | `hybrid` | — |
| 未配置 embedding | `fts` | `embedding_not_configured` |
| embedding 调用失败或返回非法向量 | `fts` | `embedding_unavailable_fts_fallback` |
| 非 PostgreSQL（单元测试） | `lexical_test` | — |
| 过滤后没有结果 | 同左 | `no_matching_published_experience` |

`gaps` 会随 Experience Pack 一起返回，Agent 可以据此判断“没有可复用经验”，而不是让模型编造。

## 预算与打分

- `max_items` 限制条数，`max_tokens` 按解决方案正文的 UTF-8 字节数做保守上界；
- `relevance_score = min(1, rrf_score * 20)`，只用于展示与排序，不代表质量结论；
- 每个经验返回 `experience_id`、`version`、`applicability`、`source_summary`、`maturity`、
  `freshness`，便于 Agent 判断适用性并反馈。

## 可观测

每次召回写入 `retrieval_runs`：调用者、scope、`mode`、`index_version`、命中的经验与版本、
分数，以及 `retrieval_id`。后续反馈必须以同一 `task_id` + `retrieval_id` + 经验版本提交，
Core API 会校验该召回确实属于当前调用者。

## 离线评测

`evaluation.run`（Celery 任务，`make eval`）在独立评测租户 `eval-synthetic` 下：

1. 用固定幂等键发布版本化数据集（默认 `evals/retrieval-smoke.json`）中的经验，重复运行复用同一批数据；
2. 对数据集里的每个 query 调用同一条召回链路；
3. 计算 `recall@k` 与 MRR，把聚合指标写入 `evaluation_runs`。

当前数据集是 `synthetic_engineering_smoke`（10 个 query 的合成冒烟集），用于防回归，**不代表**
P0 质量结论。P0 要求 50 条人工确认经验与 30 个真实/脱敏问题，必须由实际数据与人工审核验收。
