import { assertSchema } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext, TokenCounter } from '@accremind/domain';
import { withPrincipalTransaction, AccessDeniedError } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';
import { PostgresKnowledgeGovernance } from './knowledge-governance.js';
import { allowedScopesSql } from './authorization.js';
import { knowledge, governanceInput, assertCapability } from './governance-state.js';
import { canonicalJson } from './contribution-input.js';
import { sha256 } from './evidence-store.js';
import { evidenceMetadata } from './assessment-evidence.js';
import { ReadBudgetService, readTask, taskBudget } from './read-budget.js';
import {
  Utf8TokenCounter,
  applicability,
  keywords,
  searchHit,
  indexVersion,
} from './retrieval-rules.js';
import { ContributionError, invalidInput } from './contribution-errors.js';

const scopeSql = `($6='global' OR s.kind='team' OR s.domain_id=repo.domain_id OR s.repo_id=$5 OR ($6='domain' AND source_repo.domain_id=repo.domain_id))`;
export class PostgresRetrievalService {
  private readonly budget: ReadBudgetService;
  constructor(
    private readonly pool: TransactionPool,
    private readonly details: PostgresKnowledgeGovernance,
    private readonly counter: TokenCounter = new Utf8TokenCounter(),
  ) {
    this.budget = new ReadBudgetService(pool);
  }
  private async recheck(
    client: TransactionClient,
    ctx: PrincipalContext,
    task: string,
    items: readonly { id: string; revision: number; source_refs: SchemaTypes['EvidenceRef'][] }[],
    history = false,
    requireIndex = false,
  ) {
    await readTask(client, ctx, task);
    for (const item of items) {
      const k = await knowledge(client, ctx, item.id, 'knowledge:read');
      if (k.publication_status !== 'published' || k.serving_status !== 'enabled')
        throw new AccessDeniedError();
      if (Number(k.active_content_revision) !== item.revision) {
        if (!history) throw new AccessDeniedError();
        await assertCapability(client, ctx, k.scope_id, 'knowledge:history');
      }
      await evidenceMetadata(client, ctx, item.source_refs);
      if (requireIndex) {
        const ready = await client.query(
          `SELECT d.knowledge_id FROM akb.search_documents d JOIN akb.knowledge_revisions r ON r.tenant_id=d.tenant_id AND r.knowledge_id=d.knowledge_id AND r.revision=d.knowledge_revision JOIN akb.publications p ON p.tenant_id=r.tenant_id AND p.knowledge_id=r.knowledge_id AND p.review_id=r.review_id AND p.status='published' AND p.index_status='ready' WHERE d.tenant_id=$1 AND d.knowledge_id=$2 AND d.knowledge_revision=$3 AND d.index_version=$4`,
          [ctx.tenantId, item.id, item.revision, indexVersion],
        );
        if (!ready.rowCount)
          throw new ContributionError(
            'TEMPORARILY_UNAVAILABLE',
            503,
            'Search index is pending or unavailable',
          );
      }
    }
  }
  private async replay(
    ctx: PrincipalContext,
    task: string,
    result: SchemaTypes['SearchResult'] | SchemaTypes['ReadResult'],
    history = false,
  ) {
    const refs =
      'items' in result
        ? result.items
        : result.kind === 'complete'
          ? [
              {
                id: result.item.id,
                revision: result.item.content_revision,
                source_refs: result.item.source_refs,
              },
            ]
          : [{ id: result.id, revision: result.content_revision, source_refs: result.source_refs }];
    // File integrity and current evidence availability are checked even for a cached logical result.
    for (const ref of refs)
      await this.details.detail(ctx, ref.id, history ? ref.revision : undefined);
    await withPrincipalTransaction(this.pool, ctx, (client) =>
      this.recheck(client, ctx, task, refs, history, 'items' in result),
    );
    return result;
  }
  async search(
    ctx: PrincipalContext,
    value: SchemaTypes['SearchRequest'],
  ): Promise<SchemaTypes['SearchResult']> {
    const input = governanceInput<SchemaTypes['SearchRequest']>('SearchRequest', value);
    const identity = { ...ctx };
    const start = performance.now();
    const { operation_id: id, ...payload } = input;
    const hash = sha256(
      canonicalJson({
        ...payload,
        limit: input.limit ?? 5,
        token_budget: input.token_budget ?? 4000,
      }),
    );
    const reservation = await this.budget.reserve(
      identity,
      input.task_id,
      id,
      'searchKnowledge',
      hash,
      input.repo_id,
      input.environment,
    );
    if (reservation.replay)
      return (await this.replay(
        identity,
        input.task_id,
        reservation.replay,
      )) as SchemaTypes['SearchResult'];
    try {
      const result: SchemaTypes['SearchResult'] = {
        query_id: id,
        outcome: 'budget_exhausted',
        items: [],
        budget: taskBudget(reservation.task),
        clarification_questions: [],
      };
      if (reservation.charged) {
        const terms = keywords(input.query);
        if (!terms.length) invalidInput('Query needs searchable terms');
        const candidates = await withPrincipalTransaction(this.pool, identity, async (client) => {
          await readTask(client, identity, input.task_id, input.repo_id);

          const pending = await client.query(
            `WITH allowed AS (${allowedScopesSql}) SELECT k.id FROM akb.knowledge_entries k JOIN akb.knowledge_revisions r ON r.tenant_id=k.tenant_id AND r.knowledge_id=k.id AND r.revision=k.active_content_revision JOIN allowed ON allowed.id=k.scope_id JOIN akb.scopes s ON s.tenant_id=k.tenant_id AND s.id=k.scope_id JOIN akb.repos repo ON repo.tenant_id=k.tenant_id AND repo.id=$5 LEFT JOIN akb.repos source_repo ON source_repo.tenant_id=s.tenant_id AND source_repo.id=s.repo_id
      LEFT JOIN akb.search_documents d ON d.tenant_id=k.tenant_id AND d.knowledge_id=k.id AND d.knowledge_revision=k.active_content_revision AND d.index_version=$7
      LEFT JOIN akb.publications p ON p.tenant_id=r.tenant_id AND p.knowledge_id=r.knowledge_id AND p.review_id=r.review_id AND p.status='published'
      WHERE k.tenant_id=$1 AND k.publication_status='published' AND k.serving_status='enabled' AND ${scopeSql} AND (d.knowledge_id IS NULL OR p.index_status IS DISTINCT FROM 'ready') LIMIT 1`,
            [
              identity.tenantId,
              identity.actorId,
              identity.authzVersion,
              'knowledge:read',
              input.repo_id,
              input.scope,
              indexVersion,
            ],
          );
          if (pending.rowCount)
            throw new ContributionError(
              'TEMPORARILY_UNAVAILABLE',
              503,
              'Search index is pending or unavailable; use an authorized direct read or retry',
            );
          const rows = await client.query<{ id: string; revision: string; rank: number }>(
            `WITH allowed AS (${allowedScopesSql}),q AS (SELECT websearch_to_tsquery('simple',$7) query)
      SELECT k.id,k.active_content_revision revision,ts_rank(ARRAY[0.0,0.25,0.5,1.0]::real[],d.lexemes,q.query) rank
      FROM akb.search_documents d JOIN akb.knowledge_entries k ON k.tenant_id=d.tenant_id AND k.id=d.knowledge_id AND k.active_content_revision=d.knowledge_revision JOIN akb.knowledge_revisions r ON r.tenant_id=k.tenant_id AND r.knowledge_id=k.id AND r.revision=k.active_content_revision JOIN akb.publications p ON p.tenant_id=r.tenant_id AND p.knowledge_id=r.knowledge_id AND p.review_id=r.review_id AND p.status='published' AND p.index_status='ready'
      JOIN allowed ON allowed.id=k.scope_id JOIN akb.scopes s ON s.tenant_id=k.tenant_id AND s.id=k.scope_id JOIN akb.repos repo ON repo.tenant_id=k.tenant_id AND repo.id=$5
      LEFT JOIN akb.repos source_repo ON source_repo.tenant_id=s.tenant_id AND source_repo.id=s.repo_id CROSS JOIN q
      WHERE k.tenant_id=$1 AND k.publication_status='published' AND k.serving_status='enabled' AND d.index_version=$8 AND ${scopeSql} AND d.lexemes@@q.query
      ORDER BY rank DESC,(s.repo_id=$5) DESC,(k.freshness='current') DESC,k.id LIMIT 50`,
            [
              identity.tenantId,
              identity.actorId,
              identity.authzVersion,
              'knowledge:read',
              input.repo_id,
              input.scope,
              terms.join(' OR '),
              indexVersion,
            ],
          );
          return rows.rows;
        });
        const questions: string[] = [];
        const limit = Math.min(5, input.limit ?? 5);
        const maxTokens = Math.min(4000, input.token_budget ?? 4000);
        let tokens = 0;
        let tooLarge = false;
        for (const candidate of candidates) {
          if (result.items.length >= limit) break;
          let detail: SchemaTypes['KnowledgeDetail'];
          try {
            detail = await this.details.detail(identity, candidate.id);
          } catch (error) {
            if (error instanceof AccessDeniedError) continue;
            throw error;
          }
          if (
            detail.publication_status !== 'published' ||
            detail.serving_status !== 'enabled' ||
            detail.content_revision !== Number(candidate.revision)
          )
            continue;
          const applicable = applicability(detail.body, input.environment);
          questions.push(...applicable.questions);
          if (!applicable.matches) continue;
          const hit = searchHit(
            detail,
            `关键词命中；依赖版本已核对。适用前提和例外必须由使用者确认${input.environment.dirty ? '；工作区存在未提交改动' : ''}`,
          );
          const count = this.counter.count(JSON.stringify(hit));
          if (tokens + count > maxTokens) {
            tooLarge = true;
            continue;
          }
          tokens += count;
          result.items.push(hit);
        }
        result.budget.returned_tokens = tokens;
        result.clarification_questions = [...new Set(questions)].slice(0, 100);
        if (!result.items.length && tooLarge)
          result.clarification_questions.push(
            '完整条件与依据超过安全正文预算，请缩小问题或使用直接读取。',
          );
        result.outcome = result.items.length
          ? 'matched'
          : result.clarification_questions.length
            ? 'clarification_required'
            : 'no_applicable_knowledge';
      }
      const completed = await this.budget.complete(
        identity,
        input.task_id,
        id,
        reservation,
        result,
        performance.now() - start,
        (client) => this.recheck(client, identity, input.task_id, result.items, false, true),
      );
      assertSchema('SearchResult', completed);
      return completed;
    } catch (error) {
      await this.budget.fail(identity, id, reservation.generation, performance.now() - start);
      throw error;
    }
  }
  async read(
    ctx: PrincipalContext,
    value: SchemaTypes['ReadRequest'],
  ): Promise<SchemaTypes['ReadResult']> {
    const input = governanceInput<SchemaTypes['ReadRequest']>('ReadRequest', value);
    const identity = { ...ctx };
    const start = performance.now();
    const { operation_id: id, ...payload } = input;
    const reservation = await this.budget.reserve(
      identity,
      input.task_id,
      id,
      'readKnowledge',
      sha256(canonicalJson(payload)),
    );
    if (reservation.replay)
      return (await this.replay(
        identity,
        input.task_id,
        reservation.replay,
        input.revision !== undefined,
      )) as SchemaTypes['ReadResult'];
    try {
      const detail = await this.details.detail(identity, input.id, input.revision);
      await withPrincipalTransaction(this.pool, identity, async (client) => {
        const target = await knowledge(client, identity, input.id, 'knowledge:read');
        if (target.publication_status !== 'published' || target.serving_status !== 'enabled')
          throw new AccessDeniedError();
        const scoped = await client.query<{ ok: boolean }>(
          `SELECT (s.kind='team' OR s.domain_id=r.domain_id OR s.repo_id=r.id OR source.domain_id=r.domain_id) ok FROM akb.scopes s JOIN akb.repos r ON r.tenant_id=s.tenant_id AND r.id=$3 LEFT JOIN akb.repos source ON source.tenant_id=s.tenant_id AND source.id=s.repo_id WHERE s.tenant_id=$1 AND s.id=$2`,
          [identity.tenantId, target.scope_id, reservation.task.repo_id],
        );
        if (scoped.rows[0]?.ok !== true) throw new AccessDeniedError();
      });
      if (detail.body.context.dependency_constraints.length) {
        if (!reservation.task.environment)
          invalidInput(
            'First search with the task environment before reading version-constrained knowledge',
          );
        if (!applicability(detail.body, reservation.task.environment).matches)
          invalidInput('Task environment does not establish applicability of this knowledge');
      }
      const count = this.counter.count(JSON.stringify(detail));
      const result: SchemaTypes['ReadResult'] =
        reservation.charged && count <= 4000
          ? { kind: 'complete', item: detail, budget: taskBudget(reservation.task, count) }
          : {
              kind: 'budget_limited',
              id: detail.id,
              content_revision: detail.content_revision,
              title: detail.body.title,
              source_refs: [],
              needs_expansion: true,
              reason: reservation.charged ? 'token_budget_exceeded' : 'read_budget_exhausted',
              budget: taskBudget(reservation.task),
            };
      if (result.kind === 'budget_limited') {
        for (const ref of detail.source_refs) {
          if (
            this.counter.count(
              JSON.stringify({ ...result, source_refs: [...result.source_refs, ref] }),
            ) > 4000
          )
            break;
          result.source_refs.push(ref);
        }
        result.budget.returned_tokens = this.counter.count(
          JSON.stringify({
            id: result.id,
            content_revision: result.content_revision,
            title: result.title,
            source_refs: result.source_refs,
            needs_expansion: true,
            reason: result.reason,
          }),
        );
      }
      const refs = [
        { id: detail.id, revision: detail.content_revision, source_refs: detail.source_refs },
      ];
      const completed = await this.budget.complete(
        identity,
        input.task_id,
        id,
        reservation,
        result,
        performance.now() - start,
        (client) =>
          this.recheck(client, identity, input.task_id, refs, input.revision !== undefined),
      );
      assertSchema('ReadResult', completed);
      return completed;
    } catch (error) {
      await this.budget.fail(identity, id, reservation.generation, performance.now() - start);
      throw error;
    }
  }
}
