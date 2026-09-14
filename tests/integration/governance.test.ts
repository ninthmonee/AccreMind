import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertSchema, createApiClient } from '@accremind/contracts';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { SchemaTypes } from '@accremind/contracts';
import { loadDevelopmentConfig } from '@accremind/domain';
import { createDatabasePool, AccessDeniedError } from '../../apps/api/src/database.js';
import { PostgresContributionService } from '../../apps/api/src/contributions.js';
import { PostgresAssessmentService } from '../../apps/api/src/assessments.js';
import { PostgresGovernanceService } from '../../apps/api/src/governance.js';
import { PostgresKnowledgeGovernance } from '../../apps/api/src/knowledge-governance.js';
import { PublicationWorker } from '../../apps/api/src/publication-worker.js';
import { FileEvidenceStore, sha256 } from '../../apps/api/src/evidence-store.js';
import { GitContentStore } from '../../apps/api/src/content-store.js';
import type { ContentStore } from '../../apps/api/src/content-store.js';
import { ContributionError } from '../../apps/api/src/contribution-errors.js';
import { createApp } from '../../apps/api/src/app.js';
import { PostgresRetrievalService } from '../../apps/api/src/retrieval.js';
import { SearchIndexWorker } from '../../apps/api/src/search-index.js';
import { ReadBudgetService } from '../../apps/api/src/read-budget.js';
import { Utf8TokenCounter } from '../../apps/api/src/retrieval-rules.js';
import { PostgresValidationService } from '../../apps/api/src/validations.js';
import { PostgresConfigurationService } from '../../apps/api/src/configurations.js';
import { mandatoryRuleText } from '../../apps/api/src/configuration-rules.js';
import { canonicalJson } from '../../apps/api/src/contribution-input.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const alice = { tenantId: id(3101), actorId: id(3201), authzVersion: 1 };
const reviewer = { ...alice, actorId: id(3202) };
const outsider = { ...alice, actorId: id(3203) };
const scope = { kind: 'repo' as const, id: id(3301) };
const repo = id(3401);
const apiUrl = process.env.ACCREMIND_TEST_DATABASE_URL;
const ownerUrl = process.env.ACCREMIND_TEST_OWNER_URL;
const code = (expected: string) => (error: unknown) =>
  error instanceof ContributionError && error.code === expected;

test(
  'B06 real PostgreSQL independent approval, retained evidence, Git recovery, revision CAS and lifecycle',
  { skip: !apiUrl || !ownerUrl, timeout: 90000 },
  async (t) => {
    assert.ok(apiUrl && ownerUrl);
    for (const value of [apiUrl, ownerUrl]) {
      const url = new URL(value);
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(url.pathname, '/accremind_test');
    }
    const admin = createDatabasePool(ownerUrl, 2);
    const pool = createDatabasePool(apiUrl, 6);
    const workerUrl = new URL(apiUrl);
    workerUrl.username = 'akb_worker';
    const workerPool = createDatabasePool(workerUrl.toString(), 6);
    const root = await mkdtemp(join(tmpdir(), 'accremind-b06-'));
    const evidence = new FileEvidenceStore(join(root, 'evidence'));
    const git = new GitContentStore(join(root, 'content'));
    const contributions = new PostgresContributionService(pool, evidence);
    const assessments = new PostgresAssessmentService(pool, evidence);
    const governance = new PostgresGovernanceService(pool, evidence);
    const knowledge = new PostgresKnowledgeGovernance(pool, evidence, git);
    const retrieval = new PostgresRetrievalService(pool, knowledge);
    const indexWorker = new SearchIndexWorker(workerPool, git);
    const validations = new PostgresValidationService(pool, evidence, knowledge);
    const configurations = new PostgresConfigurationService(pool, evidence, git);
    const worker = new PublicationWorker(workerPool, evidence, git);
    let actor = alice;
    const app = createApp(loadDevelopmentConfig({}), {
      checkDatabase: async () => true,
      contributions,
      assessments,
      governance,
      knowledge,
      retrieval,
      validations,
      configurations,
      resolvePrincipal: async () => ({ ...actor }),
    });
    try {
      const guard = await admin.query<{ token: string }>(
        'SELECT token FROM public.accremind_test_guard',
      );
      assert.ok(process.env.ACCREMIND_TEST_GUARD);
      assert.equal(guard.rows[0]?.token, process.env.ACCREMIND_TEST_GUARD);
      await admin.query("INSERT INTO akb.tenants(id,name) VALUES($1,'synthetic B06')", [
        alice.tenantId,
      ]);
      for (const ctx of [alice, reviewer, outsider])
        await admin.query(
          `INSERT INTO akb.principals(tenant_id,id,oidc_issuer,oidc_subject,display_name) VALUES($1,$2::uuid,'synthetic',$2::text,$2::text)`,
          [ctx.tenantId, ctx.actorId],
        );
      await admin.query("INSERT INTO akb.domains(tenant_id,id,name) VALUES($1,$2,'synthetic')", [
        alice.tenantId,
        id(3501),
      ]);
      await admin.query(
        "INSERT INTO akb.repos(tenant_id,id,domain_id,name,canonical_remote) VALUES($1,$2,$3,'synthetic','synthetic:b06')",
        [alice.tenantId, repo, id(3501)],
      );
      await admin.query(
        "INSERT INTO akb.scopes(tenant_id,id,kind,repo_id) VALUES($1,$2,'repo',$3)",
        [alice.tenantId, scope.id, repo],
      );
      for (const ctx of [alice, reviewer])
        for (const capability of [
          'knowledge:read',
          'knowledge:contribute',
          'knowledge:assess',
          'evidence:read',
          'knowledge:review',
          'knowledge:publish',
          'knowledge:history',
          'knowledge:validation-review',
          'config:read',
          'config:manage',
        ])
          await admin.query(
            'INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,$5)',
            [alice.tenantId, randomUUID(), ctx.actorId, scope.id, capability],
          );
      const sources = new Map<
        string,
        {
          material: SchemaTypes['Material'];
          raw: SchemaTypes['EvidenceRef'];
          retained: SchemaTypes['EvidenceRef'];
          retainInput: SchemaTypes['RetainRequest'];
        }
      >();
      for (const kind of ['code', 'history', 'authoritative_doc'] as const) {
        const rawId = randomUUID();
        const content = `合成 ${kind} 来源片段，记录行为与历史依据。`;
        const key = await evidence.write(alice.tenantId, rawId, content);
        const material: SchemaTypes['Material'] = {
          source_ref: `synthetic:b06/${kind}`,
          source_revision: 'b06-commit',
          locator: 'line:1',
          content_hash: sha256(content),
          material_kind: kind,
        };
        await admin.query(
          `INSERT INTO akb.evidence(tenant_id,id,revision,scope_id,source_ref,source_revision,locator,object_key,sha256,evidence_kind,status,expires_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,'raw','available',now()+interval '1 day')`,
          [
            alice.tenantId,
            rawId,
            scope.id,
            material.source_ref,
            material.source_revision,
            material.locator,
            key,
            material.content_hash,
          ],
        );
        await admin.query(
          'INSERT INTO akb.baseline_materials(tenant_id,id,repo_id,source_ref,source_revision,locator,content_hash,material_kind,evidence_id,evidence_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)',
          [
            alice.tenantId,
            randomUUID(),
            repo,
            material.source_ref,
            material.source_revision,
            material.locator,
            material.content_hash,
            kind,
            rawId,
          ],
        );
        const retainInput = {
          operation_id: randomUUID(),
          source_evidence_revision: 1,
          locator: 'line:1',
        };
        const retained = await governance.retain(reviewer, rawId, retainInput);
        assertSchema('Evidence', retained);
        assert.equal(retained.content, content);
        assert.equal(retained.evidence_kind, 'retained');
        assert.notEqual(retained.id, rawId);
        assert.deepEqual(await governance.retain(reviewer, rawId, retainInput), retained);
        sources.set(kind, {
          material,
          raw: { id: rawId, revision: 1, locator: 'line:1' },
          retained: { id: retained.id, revision: 1, locator: 'line:1' },
          retainInput,
        });
      }
      const source = (kind: string) => sources.get(kind)!;
      const body = (
        title = '合成 B06 候选',
        raw = false,
        mirror = false,
      ): SchemaTypes['CandidateBody'] => ({
        type: 'decision',
        presentation: 'article',
        title,
        claim: '有来源的合成结论',
        scope,
        owner_id: alice.actorId,
        context: {
          preconditions: ['合成环境'],
          exclusions: [],
          dependency_constraints: [],
          verification_method: '人工核验',
        },
        rationale: {
          text: '历史依据',
          evidence_refs: [source('history')[raw ? 'raw' : 'retained']],
        },
        invalidation_triggers: ['材料变化'],
        alternatives: [],
        enforcement: { kind: 'none', status: 'proposed', artifact_refs: [] },
        ...(mirror
          ? {
              knowledge_role: 'authoritative_mirror' as const,
              mirror: {
                authority_ref: source('authoritative_doc').retained,
                sync_owner_id: alice.actorId,
                reason: '合成权威镜像',
              },
            }
          : { knowledge_role: 'experience' as const }),
      });
      const check = (raw = false, mirror = false): SchemaTypes['Assessment'] => ({
        question: '基线能恢复哪些信息？',
        assessment_method: 'human_review',
        rule_version: 'human-v1',
        checked_context: {
          repo_id: repo,
          commit: 'b06-commit',
          materials: [structuredClone(source(mirror ? 'authoritative_doc' : 'code').material)],
          queries: ['查阅登记片段'],
          completed: true,
          incomplete_reason: 'none',
          elapsed_ms: 1,
          input_tokens: 0,
          output_tokens: 0,
          tool_calls: 1,
        },
        baseline_answer: {
          text: '基线明确行为',
          evidence_refs: [source(mirror ? 'authoritative_doc' : 'code')[raw ? 'raw' : 'retained']],
        },
        discoverability: mirror ? 'authoritative_source' : 'missing_context',
        knowledge_delta: mirror
          ? []
          : [
              {
                claim_id: randomUUID(),
                text: '历史动机不可由代码单独恢复',
                support: 'confirmed_decision',
                evidence_refs: [source('history')[raw ? 'raw' : 'retained']],
              },
            ],
        confirmation_questions: [],
        disposition: mirror ? 'link_existing' : 'knowledge_candidate',
        priority: 'P1',
        omission_consequence: '合成历史约束将丢失',
        reason: '人工完成基线与增量检查',
      });
      const task = await contributions.createTask(alice, {
        operation_id: randomUUID(),
        repo_id: repo,
        client_session_id: 'B06',
      });
      async function packet(bodies: SchemaTypes['CandidateBody'][] = []) {
        const content = '合成开发贡献';
        const received = await contributions.ingest(alice, {
          idempotency_key: randomUUID(),
          repo_id: repo,
          task_id: task.id,
          source_event_ids: [randomUUID()],
          environment: { commit: 'b06-commit', dependencies: {} },
          candidates: bodies,
          evidence: [
            {
              client_evidence_id: randomUUID(),
              source_kind: 'selected_text',
              source_ref: 'synthetic:b06/packet',
              source_revision: '1',
              locator: 'line:1',
              content,
              sha256: sha256(content),
            },
          ],
        });
        return contributions.get(alice, received.contribution_id);
      }
      async function candidate(raw = false, mirror = false) {
        const contribution = await packet([body(undefined, raw, mirror)]);
        const id = contribution.candidates[0]!.id;
        await assessments.saveHumanCheck(alice, id, {
          operation_id: randomUUID(),
          expected_revision: 1,
          assessment: check(raw, mirror),
        });
        return id;
      }
      async function approve(id: string, ctx = reviewer) {
        const view = await assessments.getReview(ctx, id);
        assert.ok(view.assessment);
        const input: SchemaTypes['ReviewRequest'] = {
          operation_id: randomUUID(),
          expected_revision: view.candidate.revision,
          assessment_revision: view.assessment.revision,
          evidence_set_hash: view.candidate.evidence_set_hash,
          scope,
          action: 'approve',
          disposition: view.assessment.assessment.disposition,
          reason: '独立人工核验',
          ...(view.candidate.body.knowledge_role === 'authoritative_mirror'
            ? { mirror_approval: true }
            : {}),
        };
        return { input, record: await governance.review(ctx, id, input) };
      }
      async function request(
        id: string,
        review: SchemaTypes['ReviewRecord'],
        operation = randomUUID(),
      ) {
        const row = await assessments.getReview(alice, id);
        assert.ok(row.assessment);
        const input: SchemaTypes['PublishRequest'] = {
          operation_id: operation,
          expected_revision: row.candidate.revision,
          assessment_revision: row.assessment.revision,
          review_id: review.review_id,
          evidence_set_hash: row.candidate.evidence_set_hash,
          ...(row.candidate.creation_kind === 'revision'
            ? { expected_target_revision: row.candidate.revision_binding!.base_aggregate_revision }
            : {}),
        };
        return { input, result: await governance.request(alice, id, input) };
      }
      async function publish(id: string) {
        const approved = await approve(id);
        const pending = await request(id, approved.record);
        assert.equal(pending.result.status, 'pending');
        await worker.runOnce(alice.tenantId);
        const result = await governance.getPublication(alice, pending.result.publication_id);
        assert.equal(result.status, 'published');
        assert.ok(result.knowledge_id);
        return { result, approved, pending };
      }
      const forceRetry = async (publication: string) => {
        await admin.query(
          'UPDATE akb.jobs SET next_run_at=now() WHERE tenant_id=$1 AND dedupe_key=$2',
          [alice.tenantId, publication],
        );
      };
      let first: Awaited<ReturnType<typeof publish>>;
      await t.test(
        'retention authorization, exact locator, forged fields and immutable runtime history',
        async () => {
          await assert.rejects(
            governance.retain(outsider, source('code').raw.id, {
              operation_id: randomUUID(),
              source_evidence_revision: 1,
              locator: 'line:1',
            }),
            AccessDeniedError,
          );
          await assert.rejects(
            governance.retain(reviewer, source('code').raw.id, {
              operation_id: randomUUID(),
              source_evidence_revision: 1,
              locator: 'line:999',
            }),
            AccessDeniedError,
          );
          const result = await app.inject({
            method: 'POST',
            url: `/api/v1/evidence/${source('code').raw.id}/retain`,
            payload: { ...source('code').retainInput, content: '编造' },
          });
          assert.equal(result.statusCode, 400);
          await assert.rejects(pool.query("UPDATE akb.reviews SET reason='forged'"));
          await assert.rejects(workerPool.query('INSERT INTO akb.reviews DEFAULT VALUES'));
        },
      );
      await t.test(
        'missing assessment, raw sources and self approval cannot bypass the API',
        async () => {
          const contribution = await packet([body()]);
          const id = contribution.candidates[0]!.id;
          await assert.rejects(
            governance.request(alice, id, {
              operation_id: randomUUID(),
              expected_revision: 1,
              assessment_revision: 1,
              review_id: randomUUID(),
              evidence_set_hash: '0'.repeat(64),
            }),
            code('PUBLICATION_BLOCKED'),
          );
          const raw = await candidate(true);
          await assert.rejects(approve(raw), code('PUBLICATION_BLOCKED'));
          const ready = await candidate();
          await assert.rejects(approve(ready, alice), code('PUBLICATION_BLOCKED'));
          const view = await assessments.getReview(alice, ready);
          actor = alice;
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1/candidates/${ready}/review`,
            payload: {
              operation_id: randomUUID(),
              expected_revision: view.candidate.revision,
              assessment_revision: view.assessment!.revision,
              evidence_set_hash: view.candidate.evidence_set_hash,
              scope,
              action: 'approve',
              disposition: 'knowledge_candidate',
              reason: '自审',
            },
          });
          assert.equal(response.statusCode, 422);
        },
      );
      await t.test(
        'independent approval and asynchronous HTTP publication recover after refresh',
        async () => {
          const id = await candidate();
          const approved = await approve(id);
          assert.deepEqual(await governance.review(reviewer, id, approved.input), approved.record);
          const decorated = await governance.decorateReview(
            alice,
            await assessments.getReview(alice, id),
          );
          assert.equal(decorated.current_approval?.review_id, approved.record.review_id);
          assert.ok(decorated.allowed_actions.includes('publish'));
          const row = decorated.candidate;
          const input = {
            operation_id: randomUUID(),
            expected_revision: row.revision,
            assessment_revision: decorated.assessment!.revision,
            review_id: approved.record.review_id,
            evidence_set_hash: row.evidence_set_hash,
          };
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1/candidates/${id}/publish`,
            payload: input,
          });
          assert.equal(response.statusCode, 202);
          const pending = response.json().data as SchemaTypes['PublishResult'];
          assert.equal(pending.status, 'pending');
          const refreshed = await app.inject({ method: 'GET', url: `/api/v1/candidates/${id}` });
          assert.equal(
            refreshed.json().data.current_publication.publication_id,
            pending.publication_id,
          );
          await Promise.all([
            worker.runOnce(alice.tenantId),
            new PublicationWorker(workerPool, evidence, git).runOnce(alice.tenantId),
          ]);
          const result = await governance.getPublication(alice, pending.publication_id);
          assert.equal(result.status, 'published');
          assert.equal(result.index_status, 'pending');
          const retry = await governance.request(alice, id, input);
          assert.equal(retry.knowledge_id, result.knowledge_id);
          const detail = await knowledge.detail(alice, result.knowledge_id!);
          assert.equal(detail.maturity, 'draft');
          assert.equal(detail.freshness, 'unknown');
          assert.equal(detail.usage_mode, 'current_guidance');
          first = { result, approved, pending: { input, result: pending } };
          const versions = await admin.query(
            'SELECT * FROM akb.knowledge_revisions WHERE tenant_id=$1 AND knowledge_id=$2',
            [alice.tenantId, result.knowledge_id],
          );
          assert.equal(versions.rowCount, 1);
        },
      );
      await t.test(
        'candidate edits invalidate approval and pending publication; historical retry never reactivates',
        async () => {
          const id = await candidate();
          const approved = await approve(id);
          const pending = await request(id, approved.record);
          await assessments.updateCandidate(alice, id, {
            operation_id: randomUUID(),
            expected_revision: 2,
            body: body('修改后的候选'),
          });
          const refreshed = await governance.decorateReview(
            alice,
            await assessments.getReview(alice, id),
          );
          assert.equal(refreshed.current_approval, null);
          assert.equal(refreshed.latest_review?.validity, 'stale');
          assert.equal(refreshed.current_publication, null);
          await worker.runOnce(alice.tenantId);
          assert.equal(
            (await governance.getPublication(alice, pending.result.publication_id)).status,
            'failed',
          );
          assert.equal((await governance.request(alice, id, pending.input)).status, 'failed');
          await assert.rejects(
            governance.review(reviewer, id, { ...approved.input, operation_id: randomUUID() }),
            code('REVISION_CONFLICT'),
          );
        },
      );
      await t.test(
        'return/reject supersede approvals and block already queued publication',
        async () => {
          const id = await candidate();
          const approved = await approve(id);
          const pending = await request(id, approved.record);
          const returned = await governance.review(reviewer, id, {
            ...approved.input,
            operation_id: randomUUID(),
            action: 'return',
            reason: '补充依据',
          });
          assert.equal(returned.action, 'return');
          assert.equal(
            (await governance.decorateReview(alice, await assessments.getReview(alice, id)))
              .current_approval,
            null,
          );
          await worker.runOnce(alice.tenantId);
          assert.equal(
            (await governance.getPublication(alice, pending.result.publication_id)).status,
            'failed',
          );
        },
      );
      await t.test(
        'Git success followed by DB failure stays invisible and reuses the commit on retry',
        async () => {
          const id = await candidate();
          const approved = await approve(id);
          const pending = await request(id, approved.record);
          await admin.query(
            "CREATE FUNCTION public.fail_b06_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_b06 BEFORE INSERT ON akb.knowledge_revisions FOR EACH ROW EXECUTE FUNCTION public.fail_b06_insert();",
          );
          try {
            await worker.runOnce(alice.tenantId);
          } finally {
            await admin.query(
              'DROP TRIGGER fail_b06 ON akb.knowledge_revisions; DROP FUNCTION public.fail_b06_insert();',
            );
          }
          assert.equal(
            (await governance.getPublication(alice, pending.result.publication_id)).status,
            'pending',
          );
          const invisible = await admin.query(
            'SELECT knowledge_id FROM akb.knowledge_revisions WHERE tenant_id=$1 AND candidate_id=$2',
            [alice.tenantId, id],
          );
          assert.equal(invisible.rowCount, 0);
          await forceRetry(pending.result.publication_id);
          await worker.runOnce(alice.tenantId);
          assert.equal(
            (await governance.getPublication(alice, pending.result.publication_id)).status,
            'published',
          );
        },
      );
      await t.test(
        'Git failures retry with a bounded budget and never activate metadata',
        async () => {
          const id = await candidate();
          const approved = await approve(id);
          const pending = await request(id, approved.record);
          const broken: ContentStore = {
            write: async () => {
              throw new Error('synthetic Git failure');
            },
            read: git.read.bind(git),
          };
          const failing = new PublicationWorker(workerPool, evidence, broken);
          for (let attempt = 0; attempt < 3; attempt++) {
            await forceRetry(pending.result.publication_id);
            await failing.runOnce(alice.tenantId);
          }
          assert.equal(
            (await governance.getPublication(alice, pending.result.publication_id)).status,
            'failed',
          );
          const visible = await admin.query(
            'SELECT knowledge_id FROM akb.knowledge_revisions WHERE tenant_id=$1 AND candidate_id=$2',
            [alice.tenantId, id],
          );
          assert.equal(visible.rowCount, 0);
        },
      );
      await t.test(
        'expired worker generation and authorization revoked after Git cannot activate',
        async () => {
          for (const kind of ['generation', 'authorization']) {
            const id = await candidate();
            const approved = await approve(id);
            const pending = await request(id, approved.record);
            const intercepted: ContentStore = {
              read: git.read.bind(git),
              write: async (tenant, pub, content, signal) => {
                const ref = await git.write(tenant, pub, content, signal);
                if (kind === 'generation')
                  await admin.query(
                    "UPDATE akb.jobs SET generation=generation+1,lease_owner='replacement',lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND dedupe_key=$2",
                    [tenant, pub],
                  );
                else
                  await admin.query(
                    "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='knowledge:publish'",
                    [tenant, alice.actorId],
                  );
                return ref;
              },
            };
            await new PublicationWorker(workerPool, evidence, intercepted).runOnce(alice.tenantId);
            const visible = await admin.query(
              'SELECT knowledge_id FROM akb.knowledge_revisions WHERE tenant_id=$1 AND candidate_id=$2',
              [alice.tenantId, id],
            );
            assert.equal(visible.rowCount, 0);
            if (kind === 'generation') {
              assert.equal(
                (await governance.getPublication(alice, pending.result.publication_id)).status,
                'pending',
              );
              await worker.runOnce(alice.tenantId);
              assert.equal(
                (await governance.getPublication(alice, pending.result.publication_id)).status,
                'published',
              );
            } else {
              await admin.query(
                "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='knowledge:publish'",
                [alice.tenantId, alice.actorId],
              );
              assert.equal(
                (await governance.getPublication(alice, pending.result.publication_id)).status,
                'failed',
              );
            }
          }
        },
      );
      await t.test(
        'competing revision candidates use target CAS; explicit rebase clears assessment and approval',
        async () => {
          const target = first.result.knowledge_id!;
          const contribution = await packet();
          const create = (title: string) =>
            knowledge.createRevision(alice, target, {
              operation_id: randomUUID(),
              expected_revision: 1,
              base_content_revision: 1,
              contribution_id: contribution.id,
              body: body(title),
            });
          const a = await create('修订 A');
          const b = await create('修订 B');
          for (const c of [a, b])
            await assessments.saveHumanCheck(alice, c.id, {
              operation_id: randomUUID(),
              expected_revision: 1,
              assessment: check(),
            });
          const aa = await approve(a.id);
          const bb = await approve(b.id);
          const pa = await request(a.id, aa.record);
          const pb = await request(b.id, bb.record);
          await Promise.all([
            worker.runOnce(alice.tenantId),
            new PublicationWorker(workerPool, evidence, git).runOnce(alice.tenantId),
          ]);
          const outcomes = await Promise.all(
            [pa, pb].map((p) => governance.getPublication(alice, p.result.publication_id)),
          );
          assert.deepEqual(outcomes.map((x) => x.status).sort(), ['failed', 'published']);
          const loser = outcomes[0]!.status === 'failed' ? a : b;
          const state = await governance.decorateReview(
            alice,
            await assessments.getReview(alice, loser.id),
          );
          assert.equal(state.current_approval, null);
          assert.ok(state.latest_review?.stale_reasons.includes('TARGET_CHANGED'));
          const current = await knowledge.detail(alice, target);
          assert.equal(current.content_revision, 2);
          assert.equal(current.aggregate_revision, 2);
          const rebased = await knowledge.rebase(alice, loser.id, {
            operation_id: randomUUID(),
            expected_revision: 2,
            expected_target_revision: 2,
            base_content_revision: 2,
            body: body('人工合并后的修订'),
          });
          assert.equal(rebased.revision, 3);
          assert.equal(rebased.assessment_id, null);
          await assessments.saveHumanCheck(alice, loser.id, {
            operation_id: randomUUID(),
            expected_revision: 3,
            assessment: check(),
          });
          const final = await publish(loser.id);
          assert.equal(final.result.knowledge_revision, 3);
          assert.equal(final.result.aggregate_revision, 3);
          const history = await knowledge.history(alice, target, { limit: 1 });
          assert.equal(history.items.length, 1);
          assert.ok(history.next_cursor);
          const next = await knowledge.history(alice, target, {
            limit: 1,
            cursor: history.next_cursor,
          });
          assert.equal(next.items[0]?.content_revision, 2);
          assert.equal(
            (await knowledge.detail(alice, target, 1)).usage_mode,
            'historical_reference',
          );
        },
      );
      await t.test(
        'authority mirror requires explicit independent approval and preserves link_existing',
        async () => {
          const id = await candidate(false, true);
          const view = await assessments.getReview(reviewer, id);
          await assert.rejects(
            governance.review(reviewer, id, {
              operation_id: randomUUID(),
              expected_revision: 2,
              assessment_revision: view.assessment!.revision,
              evidence_set_hash: view.candidate.evidence_set_hash,
              scope,
              action: 'approve',
              disposition: 'knowledge_candidate',
              reason: '错误镜像批准',
            }),
            code('PUBLICATION_BLOCKED'),
          );
          const result = await publish(id);
          const detail = await knowledge.detail(alice, result.result.knowledge_id!);
          assert.equal(detail.body.knowledge_role, 'authoritative_mirror');
          assert.equal(detail.knowledge_delta.length, 0);
          assert.equal(result.approved.record.disposition, 'link_existing');
        },
      );
      await t.test(
        'historical review and revision-create retries reauthorize their original evidence',
        async () => {
          const candidateId = await candidate();
          const approved = await approve(candidateId);
          const replacement = body('新正文只引用代码依据');
          replacement.rationale.evidence_refs = [source('code').retained];
          await assessments.updateCandidate(alice, candidateId, {
            operation_id: randomUUID(),
            expected_revision: 2,
            body: replacement,
          });
          const target = first.result.knowledge_id!;
          const current = await knowledge.detail(alice, target);
          const contribution = await packet();
          const input: SchemaTypes['RevisionCreate'] = {
            operation_id: randomUUID(),
            expected_revision: current.aggregate_revision,
            base_content_revision: current.content_revision,
            contribution_id: contribution.id,
            body: body(),
          };
          const revision = await knowledge.createRevision(alice, target, input);
          await assessments.updateCandidate(alice, revision.id, {
            operation_id: randomUUID(),
            expected_revision: 1,
            body: replacement,
          });
          await admin.query(
            "UPDATE akb.evidence SET status='quarantined' WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, source('history').retained.id],
          );
          try {
            assert.equal(
              (await assessments.getReview(alice, candidateId)).candidate.body.title,
              replacement.title,
            );
            await assert.rejects(
              governance.review(reviewer, candidateId, approved.input),
              AccessDeniedError,
            );
            await assert.rejects(knowledge.createRevision(alice, target, input), AccessDeniedError);
          } finally {
            await admin.query(
              "UPDATE akb.evidence SET status='available' WHERE tenant_id=$1 AND id=$2",
              [alice.tenantId, source('history').retained.id],
            );
          }
        },
      );
      const environment: SchemaTypes['Environment'] = { commit: 'b07-commit', dependencies: {} };
      const newReadTask = (session: string) =>
        contributions.createTask(alice, {
          operation_id: randomUUID(),
          repo_id: repo,
          client_session_id: `B07-${session}`,
        });
      const searchInput = (taskId: string, query = '合成'): SchemaTypes['SearchRequest'] => ({
        task_id: taskId,
        operation_id: randomUUID(),
        repo_id: repo,
        query,
        environment,
        scope: 'repo',
        limit: 5,
        token_budget: 4000,
      });
      const drainIndex = async () => {
        for (let i = 0; i < 50; i++) if (!(await indexWorker.runOnce(alice.tenantId))) return;
        throw new Error('Index drain did not finish');
      };
      let endpoint: string;
      let api: ReturnType<typeof createApiClient>;
      await t.test(
        'B07 derived index is rebuildable and real HTTP search/read preserve evidence and conditions',
        async () => {
          await drainIndex();
          const currentPublication = await admin.query<{ id: string }>(
            `SELECT p.id FROM akb.knowledge_entries k JOIN akb.knowledge_revisions r ON r.tenant_id=k.tenant_id AND r.knowledge_id=k.id AND r.revision=k.active_content_revision JOIN akb.publications p ON p.tenant_id=r.tenant_id AND p.review_id=r.review_id WHERE k.tenant_id=$1 AND k.id=$2`,
            [alice.tenantId, first.result.knowledge_id],
          );
          assert.equal(
            (await governance.getPublication(alice, currentPublication.rows[0]!.id)).index_status,
            'ready',
          );
          endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
          api = createApiClient({ baseUrl: `${endpoint}/api/v1` });
          const task = await newReadTask('http');
          const input = searchInput(task.id);
          const result = await api.request('searchKnowledge', { body: input });
          assertSchema('SearchResult', result);
          assert.equal(result.outcome, 'matched');
          assert.ok(result.items.length > 0);
          assert.ok(result.items.length <= 5);
          assert.ok(result.budget.returned_tokens <= 4000);
          assert.deepEqual(await api.request('searchKnowledge', { body: input }), result);
          await assert.rejects(
            retrieval.search(alice, { ...input, query: 'changed' }),
            code('IDEMPOTENCY_CONFLICT'),
          );
          const read = await api.request('readKnowledge', {
            body: { task_id: task.id, operation_id: randomUUID(), id: first.result.knowledge_id! },
          });
          assert.equal(read.kind, 'complete');
          if (read.kind === 'complete')
            assert.deepEqual(
              read.item.body.context,
              (await knowledge.detail(alice, first.result.knowledge_id!)).body.context,
            );
          const empty = await retrieval.search(alice, searchInput(task.id, '不存在词zzunmatched'));
          assert.equal(empty.outcome, 'no_applicable_knowledge');
          assert.equal(empty.budget.used, 3);
          const exhausted = await retrieval.search(alice, searchInput(task.id));
          assert.equal(exhausted.outcome, 'budget_exhausted');
          assert.equal(exhausted.budget.used, 3);
          const limited = await retrieval.read(alice, {
            task_id: task.id,
            operation_id: randomUUID(),
            id: first.result.knowledge_id!,
          });
          assert.equal(limited.kind, 'budget_limited');
          if (limited.kind === 'budget_limited') {
            assert.equal(limited.reason, 'read_budget_exhausted');
            assert.equal('claim' in limited, false);
          }
        },
      );
      await t.test(
        'B07 concurrent logical reads reserve at most three slots and task sessions cannot refill them',
        async () => {
          const task = await newReadTask('race');
          const reused = await newReadTask('race');
          assert.equal(reused.id, task.id);
          const results = await Promise.all(
            Array.from({ length: 6 }, () =>
              retrieval.search(alice, searchInput(task.id, '无匹配zz')),
            ),
          );
          assert.equal(results.filter((r) => r.outcome !== 'budget_exhausted').length, 3);
          const row = await admin.query<{ used_reads: number; reserved_reads: number }>(
            'SELECT used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 AND id=$2',
            [alice.tenantId, task.id],
          );
          assert.deepEqual(row.rows[0], { used_reads: 3, reserved_reads: 0 });
          await assert.rejects(retrieval.search(reviewer, searchInput(task.id)), AccessDeniedError);
          await assert.rejects(
            retrieval.search(alice, { ...searchInput(task.id), repo_id: randomUUID() }),
            AccessDeniedError,
          );
        },
      );
      await t.test(
        'B07 stable dependency ranges filter mismatches and missing versions require clarification',
        async () => {
          const versioned = body('版本约束专用词');
          versioned.context.dependency_constraints = [
            { name: 'postgres', version_range: '^17.0.0' },
          ];
          versioned.context.preconditions = ['仅限指定版本与人工确认的事务顺序'];
          versioned.context.exclusions = ['不适用于其他存储引擎'];
          const contribution = await packet([versioned]);
          const id = contribution.candidates[0]!.id;
          await assessments.saveHumanCheck(alice, id, {
            operation_id: randomUUID(),
            expected_revision: 1,
            assessment: check(),
          });
          const published = await publish(id);
          await drainIndex();
          const missing = await newReadTask('version-missing');
          const result = await retrieval.search(alice, searchInput(missing.id, '版本约束专用词'));
          assert.equal(result.outcome, 'clarification_required');
          assert.ok(result.clarification_questions.some((q) => q.includes('postgres')));
          const mismatch = await newReadTask('version-mismatch');
          const bad = await retrieval.search(alice, {
            ...searchInput(mismatch.id, '版本约束专用词'),
            environment: { ...environment, dependencies: { postgres: '18.0.0' } },
          });
          assert.equal(bad.outcome, 'no_applicable_knowledge');
          const matching = await newReadTask('version-matching');
          const good = await retrieval.search(alice, {
            ...searchInput(matching.id, '版本约束专用词'),
            environment: { ...environment, dependencies: { postgres: '17.6.0' } },
          });
          assert.equal(good.outcome, 'matched');
          assert.deepEqual(good.items[0]!.context, versioned.context);
          await assert.rejects(
            retrieval.search(alice, searchInput(matching.id)),
            code('INVALID_INPUT'),
          );
          const read = await retrieval.read(alice, {
            task_id: matching.id,
            operation_id: randomUUID(),
            id: published.result.knowledge_id!,
          });
          assert.equal(read.kind, 'complete');
        },
      );
      await t.test(
        'B07 technical failure and revocation during I/O release reservations and never become empty success',
        async () => {
          const task = await newReadTask('failure');
          const input: SchemaTypes['ReadRequest'] = {
            task_id: task.id,
            operation_id: randomUUID(),
            id: first.result.knowledge_id!,
          };
          let fail = true;
          const broken: ContentStore = {
            write: git.write.bind(git),
            read: async (...args) => {
              if (fail) {
                fail = false;
                throw new Error('synthetic read failure');
              }
              return git.read(...args);
            },
          };
          const service = new PostgresRetrievalService(
            pool,
            new PostgresKnowledgeGovernance(pool, evidence, broken),
          );
          await assert.rejects(service.read(alice, input));
          let row = await admin.query<{ used_reads: number; reserved_reads: number }>(
            'SELECT used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 AND id=$2',
            [alice.tenantId, task.id],
          );
          assert.deepEqual(row.rows[0], { used_reads: 0, reserved_reads: 0 });
          assert.equal((await service.read(alice, input)).kind, 'complete');
          const intercepted: ContentStore = {
            write: git.write.bind(git),
            read: async (...args) => {
              const content = await git.read(...args);
              await admin.query(
                "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
                [alice.tenantId, alice.actorId],
              );
              return content;
            },
          };
          try {
            await assert.rejects(
              new PostgresRetrievalService(
                pool,
                new PostgresKnowledgeGovernance(pool, evidence, intercepted),
              ).read(alice, { ...input, operation_id: randomUUID() }),
              AccessDeniedError,
            );
          } finally {
            await admin.query(
              "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
              [alice.tenantId, alice.actorId],
            );
          }
          row = await admin.query(
            'SELECT used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 AND id=$2',
            [alice.tenantId, task.id],
          );
          assert.deepEqual(row.rows[0], { used_reads: 1, reserved_reads: 0 });
          const budget = new ReadBudgetService(pool);
          const op = randomUUID();
          const lease = await budget.reserve(
            alice,
            task.id,
            op,
            'synthetic-expiry',
            sha256('synthetic'),
          );
          await admin.query(
            "UPDATE akb.operations SET reserved_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, op],
          );
          const replacement = await budget.reserve(
            alice,
            task.id,
            op,
            'synthetic-expiry',
            sha256('synthetic'),
          );
          assert.equal(replacement.generation, lease.generation + 1);
          await assert.rejects(
            budget.complete(
              alice,
              task.id,
              op,
              lease,
              {
                query_id: op,
                outcome: 'no_applicable_knowledge',
                items: [],
                clarification_questions: [],
                budget: { limit: 3, used: 1, reserved: 1, remaining: 1, returned_tokens: 0 },
              },
              1,
              async () => {},
            ),
            code('TEMPORARILY_UNAVAILABLE'),
          );
          await budget.fail(alice, op, replacement.generation, 1);
        },
      );
      await t.test(
        'B07 safe token budgets never cut conditions and cache retries recheck current visibility',
        async () => {
          const task = await newReadTask('tokens');
          const tiny = await retrieval.search(alice, {
            ...searchInput(task.id),
            token_budget: 256,
          });
          assert.equal(tiny.outcome, 'clarification_required');
          assert.equal(tiny.items.length, 0);
          assert.equal(tiny.budget.returned_tokens, 0);
          const inflated = new PostgresRetrievalService(pool, knowledge, {
            version: 'test-counter',
            count: (text: string) => new Utf8TokenCounter().count(text) * 10,
          });
          const limited = await inflated.read(alice, {
            task_id: task.id,
            operation_id: randomUUID(),
            id: first.result.knowledge_id!,
          });
          assert.equal(limited.kind, 'budget_limited');
          assert.equal('item' in limited, false);
          const input = searchInput(task.id);
          const result = await retrieval.search(alice, input);
          assert.equal(result.outcome, 'matched');
          await admin.query(
            "UPDATE akb.evidence SET status='quarantined' WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, source('history').retained.id],
          );
          try {
            await assert.rejects(retrieval.search(alice, input), AccessDeniedError);
          } finally {
            await admin.query(
              "UPDATE akb.evidence SET status='available' WHERE tenant_id=$1 AND id=$2",
              [alice.tenantId, source('history').retained.id],
            );
          }
        },
      );
      await t.test(
        'B07 real MCP stdio calls real HTTP retrieval and preserves operation retry budget',
        async () => {
          const task = await newReadTask('mcp');
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [
              '--import',
              'tsx',
              fileURLToPath(new URL('../../apps/tool/src/cli.ts', import.meta.url)),
              'mcp',
              'serve',
            ],
            env: {
              ...(process.env as Record<string, string>),
              AKB_SYNTHETIC_TOOLS: '1',
              AKB_ENDPOINT: endpoint,
            },
            stderr: 'pipe',
          });
          const client = new Client({ name: 'B07-real-http-test', version: '0.1.0' });
          try {
            await client.connect(transport);
            const input = searchInput(task.id);
            const result = await client.callTool({ name: 'search-knowledge', arguments: input });
            assert.notEqual(result.isError, true);
            assertSchema('SearchResult', result.structuredContent);
            assert.equal(result.structuredContent.outcome, 'matched');
            const retry = await client.callTool({ name: 'search-knowledge', arguments: input });
            assert.deepEqual(retry.structuredContent, result.structuredContent);
            const read = await client.callTool({
              name: 'get-knowledge',
              arguments: {
                task_id: task.id,
                operation_id: randomUUID(),
                id: first.result.knowledge_id!,
              },
            });
            assertSchema('ReadResult', read.structuredContent);
            const invalid = await client.callTool({
              name: 'search-knowledge',
              arguments: { ...input, actor_id: 'forged' },
            });
            assert.equal(invalid.isError, true);
          } finally {
            await client.close();
          }
        },
      );
      await t.test(
        'B07 stale indexes and cached results cannot return withdrawn bodies; actor hourly quota survives new sessions',
        async () => {
          const task = await newReadTask('lifecycle');
          const target = first.result.knowledge_id!;
          const cachedInput: SchemaTypes['ReadRequest'] = {
            task_id: task.id,
            operation_id: randomUUID(),
            id: target,
          };
          assert.equal((await retrieval.read(alice, cachedInput)).kind, 'complete');
          const initial = await knowledge.detail(alice, target);
          await governance.mutateKnowledge(alice, target, 'suspend', {
            operation_id: randomUUID(),
            expected_revision: initial.aggregate_revision,
            reason: '检索权限验证',
          });
          await assert.rejects(retrieval.read(alice, cachedInput), AccessDeniedError);
          const result = await retrieval.search(alice, searchInput(task.id));
          assert.equal(
            result.items.some((i) => i.id === target),
            false,
          );
          await drainIndex();
          assert.equal(
            (
              await admin.query(
                'SELECT * FROM akb.search_documents WHERE tenant_id=$1 AND knowledge_id=$2',
                [alice.tenantId, target],
              )
            ).rowCount,
            0,
          );
          await admin.query(
            "UPDATE akb.knowledge_entries SET serving_status='enabled',revision=revision-1 WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, target],
          );
          await admin.query(
            "UPDATE akb.jobs SET status='queued',next_run_at=now() WHERE tenant_id=$1 AND kind='search_index' AND dedupe_key=$2",
            [alice.tenantId, `${target}:${initial.aggregate_revision + 1}`],
          );
          await drainIndex();
          const window = await admin.query<{ used: number }>(
            "SELECT used FROM akb.read_windows WHERE tenant_id=$1 AND principal_id=$2 AND window_start=date_trunc('hour',now())",
            [alice.tenantId, alice.actorId],
          );
          await admin.query(
            "UPDATE akb.read_windows SET used=20 WHERE tenant_id=$1 AND principal_id=$2 AND window_start=date_trunc('hour',now())",
            [alice.tenantId, alice.actorId],
          );
          try {
            assert.equal(
              (await retrieval.search(alice, searchInput(task.id))).outcome,
              'budget_exhausted',
            );
          } finally {
            await admin.query(
              "UPDATE akb.read_windows SET used=$3 WHERE tenant_id=$1 AND principal_id=$2 AND window_start=date_trunc('hour',now())",
              [alice.tenantId, alice.actorId, window.rows[0]!.used],
            );
          }
        },
      );
      await t.test(
        'B07 failed index leaves publication intact and explicit rebuild recovers derived state',
        async () => {
          const target = first.result.knowledge_id!;
          const staleIndex = await admin.query(
            'SELECT * FROM akb.search_documents WHERE tenant_id=$1 AND knowledge_id=$2',
            [alice.tenantId, target],
          );
          assert.equal(staleIndex.rowCount, 1);
          const baselineInput = searchInput(task.id);
          const baseline = await retrieval.search(alice, baselineInput);
          assert.equal(baseline.outcome, 'matched');
          const broken: ContentStore = {
            write: git.write.bind(git),
            read: async () => {
              throw new Error('synthetic index read failure');
            },
          };
          const failing = new SearchIndexWorker(workerPool, broken);
          await failing.rebuild(alice);
          const retryInput = searchInput(task.id);
          await assert.rejects(
            retrieval.search(alice, retryInput),
            code('TEMPORARILY_UNAVAILABLE'),
          );
          await assert.rejects(
            retrieval.search(alice, baselineInput),
            code('TEMPORARILY_UNAVAILABLE'),
          );
          for (let attempt = 0; attempt < 3; attempt++) {
            await admin.query(
              "UPDATE akb.jobs SET next_run_at=now() WHERE tenant_id=$1 AND kind='search_index' AND status='queued'",
              [alice.tenantId],
            );
            for (let i = 0; i < 50; i++) if (!(await failing.runOnce(alice.tenantId))) break;
          }
          const currentPublication = await admin.query<{ id: string }>(
            `SELECT p.id FROM akb.knowledge_entries k JOIN akb.knowledge_revisions r ON r.tenant_id=k.tenant_id AND r.knowledge_id=k.id AND r.revision=k.active_content_revision JOIN akb.publications p ON p.tenant_id=r.tenant_id AND p.review_id=r.review_id WHERE k.tenant_id=$1 AND k.id=$2`,
            [alice.tenantId, target],
          );
          const publication = await governance.getPublication(
            alice,
            currentPublication.rows[0]!.id,
          );
          assert.equal(publication.status, 'published');
          assert.equal(publication.index_status, 'failed');
          await assert.rejects(
            retrieval.search(alice, retryInput),
            code('TEMPORARILY_UNAVAILABLE'),
          );
          assert.equal(
            (
              await admin.query(
                'SELECT * FROM akb.search_documents WHERE tenant_id=$1 AND knowledge_id=$2',
                [alice.tenantId, target],
              )
            ).rowCount,
            1,
          );
          assert.deepEqual(
            (
              await admin.query(
                'SELECT used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 AND id=$2',
                [alice.tenantId, task.id],
              )
            ).rows[0],
            { used_reads: 1, reserved_reads: 0 },
          );
          const costs = await admin.query(
            "SELECT count(*) FROM akb.jobs WHERE tenant_id=$1 AND kind='search_index' AND status='failed'",
            [alice.tenantId],
          );
          assert.ok(Number(costs.rows[0].count) > 0);
          await indexWorker.rebuild(alice);
          await drainIndex();
          const recovered = await retrieval.search(alice, retryInput);
          assert.equal(recovered.outcome, 'matched');
          assert.equal(recovered.budget.used, 2);
          assert.deepEqual(await retrieval.search(alice, baselineInput), baseline);
          let rebuildDuringRead = true;
          const intercepted: ContentStore = {
            write: git.write.bind(git),
            read: async (...args) => {
              const content = await git.read(...args);
              if (rebuildDuringRead) {
                rebuildDuringRead = false;
                await indexWorker.rebuild(alice);
              }
              return content;
            },
          };
          const duringRead = new PostgresRetrievalService(
            pool,
            new PostgresKnowledgeGovernance(pool, evidence, intercepted),
          );
          const isolatedTask = await contributions.createTask(reviewer, {
            operation_id: randomUUID(),
            repo_id: repo,
            client_session_id: 'B07-final-index-check',
          });
          const finalInput = searchInput(isolatedTask.id);
          await assert.rejects(
            duringRead.search(reviewer, finalInput),
            code('TEMPORARILY_UNAVAILABLE'),
          );
          assert.deepEqual(
            (
              await admin.query(
                'SELECT used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 AND id=$2',
                [reviewer.tenantId, isolatedTask.id],
              )
            ).rows[0],
            { used_reads: 0, reserved_reads: 0 },
          );
          await drainIndex();
          assert.equal((await duringRead.search(reviewer, finalInput)).outcome, 'matched');
          assert.equal(
            (
              await admin.query(
                'SELECT * FROM akb.search_documents WHERE tenant_id=$1 AND knowledge_id=$2',
                [alice.tenantId, target],
              )
            ).rowCount,
            1,
          );
          assert.equal((await knowledge.detail(alice, target)).usage_mode, 'current_guidance');
        },
      );
      await t.test(
        'raw expiry does not invalidate frozen evidence; retained revocation still blocks serving',
        async () => {
          await admin.query(
            "UPDATE akb.evidence SET status='expired',expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND evidence_kind='raw'",
            [alice.tenantId],
          );
          const detail = await knowledge.detail(alice, first.result.knowledge_id!);
          assert.equal(
            detail.source_refs.every((r) =>
              [...sources.values()].some((s) => s.retained.id === r.id),
            ),
            true,
          );
          const recovered = await governance.retain(
            reviewer,
            source('code').raw.id,
            source('code').retainInput,
          );
          assert.equal(recovered.id, source('code').retained.id);
          await admin.query(
            "UPDATE akb.evidence SET status='quarantined' WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, source('history').retained.id],
          );
          await assert.rejects(
            knowledge.detail(alice, first.result.knowledge_id!),
            AccessDeniedError,
          );
          await admin.query(
            "UPDATE akb.evidence SET status='available' WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, source('history').retained.id],
          );
        },
      );
      await t.test(
        'suspend, withdraw and archive use aggregate CAS, immutable retries and safe history',
        async () => {
          const target = first.result.knowledge_id!;
          const initial = await knowledge.detail(alice, target);
          const input = {
            operation_id: randomUUID(),
            expected_revision: initial.aggregate_revision,
            reason: '合成暂停',
          };
          const suspended = await governance.mutateKnowledge(alice, target, 'suspend', input);
          assert.equal(suspended.revision, 4);
          assert.deepEqual(
            await governance.mutateKnowledge(alice, target, 'suspend', input),
            suspended,
          );
          await assert.rejects(
            governance.mutateKnowledge(alice, target, 'withdraw', {
              ...input,
              operation_id: randomUUID(),
            }),
            code('REVISION_CONFLICT'),
          );
          assert.equal((await knowledge.detail(alice, target)).usage_mode, 'historical_reference');
          await admin.query(
            "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='knowledge:review'",
            [alice.tenantId, alice.actorId],
          );
          await assert.rejects(knowledge.detail(alice, target), AccessDeniedError);
          await admin.query(
            "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='knowledge:review'",
            [alice.tenantId, alice.actorId],
          );
          const withdrawn = await governance.mutateKnowledge(alice, target, 'withdraw', {
            operation_id: randomUUID(),
            expected_revision: 4,
            reason: '合成撤回',
          });
          assert.equal(withdrawn.revision, 5);
          const archived = await governance.mutateKnowledge(alice, target, 'archive', {
            operation_id: randomUUID(),
            expected_revision: 5,
            reason: '合成归档',
          });
          assert.equal(archived.revision, 6);
          assert.equal((await knowledge.detail(alice, target)).publication_status, 'archived');
          await assert.rejects(knowledge.detail(outsider, target), AccessDeniedError);
        },
      );
      let validationTarget: string;
      let firstValidation: SchemaTypes['Validation'];
      let firstProof: SchemaTypes['EvidenceRef'];
      const validationInput = (
        target: string,
        ref: SchemaTypes['EvidenceRef'],
        taskId = task.id,
      ): SchemaTypes['ValidationRequest'] => ({
        event_id: randomUUID(),
        task_id: taskId,
        knowledge_id: target,
        revision: 1,
        environment,
        method: '对合成结论的指定事务用例进行提交前后对照，逐项确认前提和例外',
        expected_result: '提交后读取返回指定记录，提交前读取不作为该结论依据',
        actual_result: '指定用例提交后读取返回记录，前提和例外已人工核对',
        outcome: 'success',
        evidence_refs: [ref],
      });
      const reviewInput = (v: SchemaTypes['Validation']): SchemaTypes['ValidationReview'] => ({
        operation_id: randomUUID(),
        expected_revision: v.revision,
        action: 'accept',
        reason: '独立读取证据并核对结论、环境、前提和例外；这是针对该结论的验证',
      });
      async function validationProof(content: string) {
        const evidenceId = randomUUID();
        const key = await evidence.write(alice.tenantId, evidenceId, content);
        await admin.query(
          `INSERT INTO akb.evidence(tenant_id,id,revision,scope_id,source_ref,source_revision,locator,object_key,sha256,evidence_kind,status,expires_at) VALUES($1,$2,1,$3,$4,'b08-proof','line:1',$5,$6,'raw','available',now()+interval '1 day')`,
          [
            alice.tenantId,
            evidenceId,
            scope.id,
            `synthetic:validation/${evidenceId}`,
            key,
            sha256(content),
          ],
        );
        const retained = await governance.retain(reviewer, evidenceId, {
          operation_id: randomUUID(),
          source_evidence_revision: 1,
          locator: 'line:1',
        });
        return { id: retained.id, revision: retained.revision, locator: retained.locator };
      }
      await t.test(
        'B08 usage/feedback are idempotent and cannot promote maturity or forge server events',
        async () => {
          validationTarget = (await publish(await candidate())).result.knowledge_id!;
          const input: SchemaTypes['UsageRequest'] = {
            event_id: randomUUID(),
            task_id: task.id,
            knowledge_id: validationTarget,
            revision: 1,
            event_type: 'cited',
            used_in: 'synthetic:artifact/context',
          };
          const calls = await Promise.all(
            Array.from({ length: 8 }, () => validations.usage(alice, input)),
          );
          assert.equal(new Set(calls.map((r) => r.id)).size, 1);
          assert.equal(calls.filter((r) => r.result === 'recorded').length, 1);
          await assert.rejects(
            validations.usage(alice, { ...input, used_in: 'changed' }),
            code('IDEMPOTENCY_CONFLICT'),
          );
          for (const event_type of ['retrieved', 'validation_submitted', 'validation_accepted']) {
            const response = await app.inject({
              method: 'POST',
              url: '/api/v1/usage-events',
              payload: { ...input, event_id: randomUUID(), event_type },
            });
            assert.equal(response.statusCode, 400);
          }
          const feedback: SchemaTypes['FeedbackRequest'] = {
            event_id: randomUUID(),
            knowledge_id: validationTarget,
            revision: 1,
            category: 'suspected_error',
            description: '合成疑问，需独立核对',
          };
          const result = await api.request('submitFeedback', { body: feedback });
          assert.equal(result.result, 'recorded');
          assert.deepEqual(await api.request('submitFeedback', { body: feedback }), {
            ...result,
            result: 'duplicate',
          });
          await assert.rejects(
            validations.feedback(alice, { ...feedback, description: 'changed' }),
            code('IDEMPOTENCY_CONFLICT'),
          );
          assert.equal((await knowledge.detail(alice, validationTarget)).maturity, 'draft');
          const generated = await admin.query(
            "SELECT count(*) FROM akb.usage_events WHERE tenant_id=$1 AND event_type='retrieved'",
            [alice.tenantId],
          );
          assert.ok(Number(generated.rows[0].count) > 0);
          await assert.rejects(validations.usage(outsider, input), AccessDeniedError);
        },
      );
      await t.test(
        'B08 concurrent submissions and changed event IDs deduplicate actual method/evidence, not client claims',
        async () => {
          firstProof = await validationProof(
            '合成独立证明 A：提交前后指定记录的读取对照，包含环境和前提',
          );
          const input = validationInput(validationTarget, firstProof);
          const results = await Promise.all(
            Array.from({ length: 6 }, () => validations.submit(alice, input)),
          );
          firstValidation = results[0]!;
          assert.equal(new Set(results.map((v) => v.id)).size, 1);
          assert.equal(firstValidation.review_status, 'pending');
          assert.equal(
            (await validations.submit(alice, { ...input, event_id: randomUUID() })).id,
            firstValidation.id,
          );
          await assert.rejects(
            validations.submit(alice, { ...input, actual_result: 'changed' }),
            code('IDEMPOTENCY_CONFLICT'),
          );
          await assert.rejects(
            validations.submit(alice, {
              ...input,
              event_id: randomUUID(),
              environment: { ...environment, commit: 'wrong' },
            }),
            code('INVALID_INPUT'),
          );
          const forged = await app.inject({
            method: 'POST',
            url: '/api/v1/validations',
            payload: { ...input, review_status: 'accepted', maturity: 'proven' },
          });
          assert.equal(forged.statusCode, 400);
          await admin.query(
            "UPDATE akb.evidence SET status='quarantined' WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, firstProof.id],
          );
          try {
            await assert.rejects(validations.submit(alice, input), AccessDeniedError);
          } finally {
            await admin.query(
              "UPDATE akb.evidence SET status='available' WHERE tenant_id=$1 AND id=$2",
              [alice.tenantId, firstProof.id],
            );
          }
          const count = await admin.query(
            'SELECT count(*) FROM akb.validations WHERE tenant_id=$1 AND knowledge_id=$2',
            [alice.tenantId, validationTarget],
          );
          assert.equal(Number(count.rows[0].count), 1);
        },
      );
      await t.test(
        'B08 independent human acceptance promotes verified; self review and plain suite success are rejected',
        async () => {
          await assert.rejects(
            validations.review(alice, firstValidation.id, reviewInput(firstValidation)),
            code('PUBLICATION_BLOCKED'),
          );
          const input = reviewInput(firstValidation);
          const accepted = await validations.review(reviewer, firstValidation.id, input);
          assert.equal(accepted.review_status, 'accepted');
          assert.equal(accepted.revision, 2);
          assert.deepEqual(await validations.review(reviewer, firstValidation.id, input), accepted);
          assert.equal((await knowledge.detail(alice, validationTarget)).maturity, 'verified');
          const proof = await validationProof('整体构建输出合成证明，仅说明构建通过');
          const generic = await validations.submit(alice, {
            ...validationInput(validationTarget, proof),
            method: 'pnpm build',
          });
          await assert.rejects(
            validations.review(reviewer, generic.id, reviewInput(generic)),
            code('PUBLICATION_BLOCKED'),
          );
          await validations.review(reviewer, generic.id, {
            ...reviewInput(generic),
            action: 'reject',
            reason: '整体构建未验证具体结论',
          });
          assert.equal((await knowledge.detail(alice, validationTarget)).maturity, 'verified');
          await assert.rejects(pool.query("UPDATE akb.validation_reviews SET reason='forged'"));
          await assert.rejects(
            pool.query("UPDATE akb.knowledge_revisions SET content_hash=repeat('0',64)"),
          );
        },
      );
      await t.test(
        'B08 copied proof across tasks cannot inflate independence; distinct tasks/validators/proofs can reach proven in one project',
        async () => {
          const a = await contributions.createTask(reviewer, {
            operation_id: randomUUID(),
            repo_id: repo,
            client_session_id: 'B08-copied-proof',
          });
          const copied = await validations.submit(
            reviewer,
            validationInput(validationTarget, firstProof, a.id),
          );
          await validations.review(alice, copied.id, reviewInput(copied));
          assert.equal((await knowledge.detail(alice, validationTarget)).maturity, 'verified');
          const b = await contributions.createTask(reviewer, {
            operation_id: randomUUID(),
            repo_id: repo,
            client_session_id: 'B08-independent-proof',
          });
          const ref = await validationProof(
            '合成独立证明 B：另一任务实际执行同一结论的指定对照，记录不同观测',
          );
          const independent = await validations.submit(
            reviewer,
            validationInput(validationTarget, ref, b.id),
          );
          await validations.review(alice, independent.id, reviewInput(independent));
          const detail = await knowledge.detail(alice, validationTarget);
          assert.equal(detail.maturity, 'proven');
          assert.equal(detail.freshness, 'current');
          assert.ok(detail.last_validated_at);
        },
      );
      await t.test(
        'B08 competing independent reviewers append one CAS decision, with exact historical operation recovery',
        async () => {
          for (const capability of [
            'knowledge:read',
            'evidence:read',
            'knowledge:validation-review',
          ])
            await admin.query(
              'INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,$5)',
              [alice.tenantId, randomUUID(), outsider.actorId, scope.id, capability],
            );
          const ref = await validationProof('合成无结论证明 C：没有足够观测，不是成功证据');
          const v = await validations.submit(alice, {
            ...validationInput(validationTarget, ref),
            outcome: 'inconclusive',
          });
          const input = reviewInput(v);
          const raced = await Promise.allSettled([
            validations.review(reviewer, v.id, input),
            validations.review(outsider, v.id, {
              ...input,
              operation_id: randomUUID(),
              action: 'reject',
            }),
          ]);
          assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
          assert.equal(
            raced.filter((r) => r.status === 'rejected' && code('REVISION_CONFLICT')(r.reason))
              .length,
            1,
            JSON.stringify(
              raced.map((r) =>
                r.status === 'rejected'
                  ? { name: r.reason?.name, code: r.reason?.code, message: r.reason?.message }
                  : r.status,
              ),
            ),
          );
          const history = await admin.query(
            'SELECT * FROM akb.validation_reviews WHERE tenant_id=$1 AND validation_id=$2',
            [alice.tenantId, v.id],
          );
          assert.equal(history.rowCount, 1);
          assert.equal((await knowledge.detail(alice, validationTarget)).maturity, 'proven');
          await admin.query(
            'UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2',
            [alice.tenantId, outsider.actorId],
          );
        },
      );
      await t.test(
        'B08 accepted counterevidence schedules review without adding successes or silently suspending service',
        async () => {
          const ref = await validationProof(
            '合成反证 D：指定条件下提交后读取未返回记录，保留失败观测',
          );
          const v = await validations.submit(alice, {
            ...validationInput(validationTarget, ref),
            outcome: 'failure',
            actual_result: '指定条件下未返回记录，存在反例',
          });
          await validations.review(reviewer, v.id, reviewInput(v));
          const detail = await knowledge.detail(alice, validationTarget);
          assert.equal(detail.maturity, 'proven');
          assert.equal(detail.freshness, 'review_due');
          assert.equal(detail.serving_status, 'enabled');
          const jobs = await admin.query(
            "SELECT * FROM akb.jobs WHERE tenant_id=$1 AND kind='counterevidence_review' AND dedupe_key=$2",
            [alice.tenantId, `${validationTarget}:1`],
          );
          assert.equal(jobs.rowCount, 1);
          assert.equal(jobs.rows[0].status, 'queued');
        },
      );
      await t.test(
        'B08 new content starts draft and accepting an old revision cannot promote the active version',
        async () => {
          const current = await knowledge.detail(alice, validationTarget);
          const p = await packet();
          const c = await knowledge.createRevision(alice, validationTarget, {
            operation_id: randomUUID(),
            expected_revision: current.aggregate_revision,
            base_content_revision: 1,
            contribution_id: p.id,
            body: body('B08 实质修订后的合成结论'),
          });
          await assessments.saveHumanCheck(alice, c.id, {
            operation_id: randomUUID(),
            expected_revision: 1,
            assessment: check(),
          });
          await publish(c.id);
          const before = await knowledge.detail(alice, validationTarget);
          assert.equal(before.content_revision, 2);
          assert.equal(before.maturity, 'draft');
          const ref = await validationProof('合成旧版本证明 E：只针对第一版，不声明第二版适用');
          const v = await validations.submit(alice, validationInput(validationTarget, ref));
          await validations.review(reviewer, v.id, reviewInput(v));
          const after = await knowledge.detail(alice, validationTarget);
          assert.equal(after.maturity, 'draft');
          assert.equal(after.aggregate_revision, before.aggregate_revision);
          assert.equal((await knowledge.detail(alice, validationTarget, 1)).maturity, 'proven');
        },
      );
      await t.test(
        'B08 review listing uses signed scoped paging and fails closed on evidence revocation',
        async () => {
          actor = reviewer;
          const first = await api.request('listValidations', {
            query: { limit: 2, scope_id: scope.id },
          });
          assertSchema('ValidationPage', first);
          assert.equal(first.items.length, 2);
          assert.ok(first.next_cursor);
          const second = await api.request('listValidations', {
            query: { limit: 2, scope_id: scope.id, cursor: first.next_cursor },
          });
          assert.ok(second.items.every((v) => !first.items.some((a) => a.id === v.id)));
          await assert.rejects(
            validations.list(alice, { limit: 2, scope_id: scope.id, cursor: first.next_cursor }),
            code('INVALID_INPUT'),
          );
          assert.equal((await app.inject('/api/v1/validations?limit=0')).statusCode, 400);
          await admin.query(
            "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
            [alice.tenantId, reviewer.actorId],
          );
          try {
            await assert.rejects(
              validations.list(reviewer, { scope_id: scope.id }),
              AccessDeniedError,
            );
          } finally {
            await admin.query(
              "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
              [alice.tenantId, reviewer.actorId],
            );
            actor = alice;
          }
        },
      );
      await t.test(
        'B08 authoritative mirror verification binds registered authority, without treating a build as organizational confirmation',
        async () => {
          const target = (await publish(await candidate(false, true))).result.knowledge_id!;
          const mirror = await knowledge.detail(alice, target);
          const authority = mirror.body.mirror!.authority_ref;
          const input = {
            ...validationInput(target, authority),
            method: '负责人核对权威来源版本、生效范围和当前有效性',
            expected_result: '权威来源当前有效，生效范围与镜像一致',
            actual_result: '已读取登记来源并确认范围和版本',
          };
          const v = await validations.submit(alice, input);
          await validations.review(reviewer, v.id, reviewInput(v));
          assert.equal((await knowledge.detail(alice, target)).maturity, 'verified');
          assert.equal((await knowledge.detail(alice, target)).knowledge_delta.length, 0);
        },
      );
      await t.test(
        'B08 evidence revocation during actual storage I/O rolls back submission',
        async () => {
          const ref = await validationProof('合成撤权证明 F：只用于检查读取期间的权限变化');
          const intercepted = {
            write: evidence.write.bind(evidence),
            read: async (...args: Parameters<typeof evidence.read>) => {
              const content = await evidence.read(...args);
              await admin.query(
                "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
                [alice.tenantId, alice.actorId],
              );
              return content;
            },
          };
          const service = new PostgresValidationService(pool, intercepted, knowledge);
          const input = { ...validationInput(validationTarget, ref), revision: 2 };
          try {
            await assert.rejects(service.submit(alice, input), AccessDeniedError);
          } finally {
            await admin.query(
              "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
              [alice.tenantId, alice.actorId],
            );
          }
          assert.equal(
            (
              await admin.query(
                'SELECT * FROM akb.validations WHERE tenant_id=$1 AND event_id=$2',
                [alice.tenantId, input.event_id],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'B08 real MCP write tools call HTTP, preserve event identity and leave verification pending',
        async () => {
          actor = alice;
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [
              '--import',
              'tsx',
              fileURLToPath(new URL('../../apps/tool/src/cli.ts', import.meta.url)),
              'mcp',
              'serve',
            ],
            env: {
              ...(process.env as Record<string, string>),
              AKB_SYNTHETIC_TOOLS: '1',
              AKB_ENDPOINT: endpoint,
            },
            stderr: 'pipe',
          });
          const client = new Client({ name: 'B08-real-http-test', version: '0.1.0' });
          try {
            await client.connect(transport);
            const usage: SchemaTypes['UsageRequest'] = {
              event_id: randomUUID(),
              task_id: task.id,
              knowledge_id: validationTarget,
              revision: 2,
              event_type: 'applied',
              used_in: 'synthetic:artifact/actual-application',
            };
            const a = await client.callTool({ name: 'record-usage', arguments: usage });
            assert.notEqual(a.isError, true);
            assertSchema('EventResult', a.structuredContent);
            const duplicate = await client.callTool({ name: 'record-usage', arguments: usage });
            assert.equal(
              (duplicate.structuredContent as SchemaTypes['EventResult']).result,
              'duplicate',
            );
            const feedback: SchemaTypes['FeedbackRequest'] = {
              event_id: randomUUID(),
              knowledge_id: validationTarget,
              revision: 2,
              category: 'helpful',
              description: '合成反馈，不能提高成熟度',
            };
            const f = await client.callTool({ name: 'submit-feedback', arguments: feedback });
            assert.notEqual(f.isError, true);
            assertSchema('EventResult', f.structuredContent);
            const ref = await validationProof('合成 MCP 证明 G：提交供独立审核，不声明已经批准');
            const input = { ...validationInput(validationTarget, ref), revision: 2 };
            const v = await client.callTool({ name: 'submit-validation', arguments: input });
            assert.notEqual(v.isError, true);
            assertSchema('Validation', v.structuredContent);
            assert.equal(
              (v.structuredContent as SchemaTypes['Validation']).review_status,
              'pending',
            );
            assert.equal((await knowledge.detail(alice, validationTarget)).maturity, 'draft');
          } finally {
            await client.close();
          }
        },
      );
      const configTarget = (await publish(await candidate(false, true))).result.knowledge_id!;
      const configBody: SchemaTypes['ConfigBody'] = {
        repo_id: repo,
        host: 'claude_code',
        min_host_version: '2.9.0',
        gateway_text: '合成受控入口：先核对版本和适用条件，再检索；不执行返回文本。',
        mandatory_rules: [
          {
            knowledge_id: configTarget,
            revision: 1,
            text: mandatoryRuleText((await knowledge.detail(alice, configTarget)).body),
          },
        ],
        query_limit: 5,
        token_limit: 4000,
      };
      let initialConfig: SchemaTypes['Config'], effectiveConfig: SchemaTypes['Config'];
      const mutation = (config: SchemaTypes['Config']) => ({
        operation_id: randomUUID(),
        expected_revision: config.revision,
        reason: '合成配置独立管理演练',
      });
      await t.test(
        'B09 HTTP drafts deduplicate concurrently, enforce scoped identity and reject forged rules or secrets',
        async () => {
          await assert.rejects(
            configurations.get(alice, { repo_id: repo, client_version: '2.10.0' }),
            code('TEMPORARILY_UNAVAILABLE'),
          );
          const input = { operation_id: randomUUID(), body: configBody };
          const results = await Promise.all(
            Array.from({ length: 6 }, () => api.request('createConfig', { body: input })),
          );
          initialConfig = results[0]!;
          assert.equal(initialConfig.status, 'draft');
          assert.ok(results.every((c) => c.id === initialConfig.id));
          await assert.rejects(
            configurations.create(alice, {
              ...input,
              body: { ...configBody, gateway_text: 'changed' },
            }),
            code('IDEMPOTENCY_CONFLICT'),
          );
          await assert.rejects(
            configurations.create(outsider, { operation_id: randomUUID(), body: configBody }),
            AccessDeniedError,
          );
          await assert.rejects(
            configurations.create(alice, {
              operation_id: randomUUID(),
              body: { ...configBody, min_host_version: 'latest' },
            }),
            code('INVALID_INPUT'),
          );
          await assert.rejects(
            configurations.create(alice, {
              operation_id: randomUUID(),
              body: { ...configBody, gateway_text: 'api_key=not-a-real-secret' },
            }),
            code('INVALID_INPUT'),
          );
          await assert.rejects(
            configurations.create(alice, {
              operation_id: randomUUID(),
              body: {
                ...configBody,
                mandatory_rules: [{ ...configBody.mandatory_rules[0]!, text: '伪造强制规则' }],
              },
            }),
            code('PUBLICATION_BLOCKED'),
          );
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: '/api/v1/config/versions',
                payload: { ...input, status: 'active', sha256: 'a'.repeat(64) },
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await app.inject(
                `/api/v1/config?repo_id=${repo}&client_version=2.10.0&current_config_version=0`,
              )
            ).statusCode,
            400,
          );
        },
      );
      await t.test(
        'B09 competing drafts have one activation generation winner; revoked historical retries never reactivate',
        async () => {
          const sibling = await configurations.create(alice, {
            operation_id: randomUUID(),
            body: { ...configBody, gateway_text: '合成第二个竞争入口' },
          });
          await assert.rejects(
            configurations.activate(alice, initialConfig.id, {
              ...mutation(initialConfig),
              expected_revision: 999,
            }),
            code('REVISION_CONFLICT'),
          );
          const ops = [mutation(initialConfig), mutation(sibling)];
          const contenders = [initialConfig, sibling];
          const result = await Promise.allSettled(
            contenders.map((c, i) =>
              api.request('activateConfig', { path: { id: c.id }, body: ops[i]! }),
            ),
          );
          assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
          const winner = result.findIndex((r) => r.status === 'fulfilled');
          effectiveConfig = (result[winner] as PromiseFulfilledResult<SchemaTypes['Config']>).value;
          const loser = result.find((r) => r.status === 'rejected') as PromiseRejectedResult;
          assert.equal(loser.reason.code, 'REVISION_CONFLICT');
          assert.deepEqual(
            await configurations.activate(alice, effectiveConfig.id, ops[winner]!),
            effectiveConfig,
          );
          assert.equal(
            (
              await admin.query(
                "SELECT id FROM akb.configs WHERE tenant_id=$1 AND scope_id=$2 AND status='active'",
                [alice.tenantId, scope.id],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'B09 effective config preserves complete mandatory rules, checks compatibility and spends no task read budget',
        async () => {
          const before = (
            await admin.query(
              'SELECT id,used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 ORDER BY id',
              [alice.tenantId],
            )
          ).rows;
          const updated = await api.request('getConfig', {
            query: { repo_id: repo, client_version: '2.10.0' },
          });
          assert.equal(updated.outcome, 'updated');
          assert.equal(updated.status, 'active');
          assert.equal(updated.body.mandatory_rules[0]!.text, configBody.mandatory_rules[0]!.text);
          assert.equal(updated.sha256, sha256(canonicalJson(updated.body)));
          assert.equal(
            (
              await api.request('getConfig', {
                query: {
                  repo_id: repo,
                  client_version: '2.10.0',
                  current_config_version: updated.revision,
                },
              })
            ).outcome,
            'unchanged',
          );
          for (const client_version of ['2.8.0', 'latest', '2.10.0-beta.1'])
            assert.equal(
              (await configurations.get(alice, { repo_id: repo, client_version })).outcome,
              'incompatible',
            );
          assert.deepEqual(
            (
              await admin.query(
                'SELECT id,used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 ORDER BY id',
                [alice.tenantId],
              )
            ).rows,
            before,
          );
        },
      );
      await t.test(
        'B09 rule withdrawal and grant revocation during real evidence I/O fail closed without charging config quota',
        async () => {
          const count = async () =>
            (
              await admin.query(
                'SELECT reads FROM akb.config_windows WHERE tenant_id=$1 AND actor_id=$2',
                [alice.tenantId, alice.actorId],
              )
            ).rows;
          const before = await count();
          await admin.query(
            "UPDATE akb.knowledge_entries SET serving_status='suspended' WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, configTarget],
          );
          try {
            await assert.rejects(
              configurations.get(alice, { repo_id: repo, client_version: '2.10.0' }),
              code('PUBLICATION_BLOCKED'),
            );
          } finally {
            await admin.query(
              "UPDATE akb.knowledge_entries SET serving_status='enabled' WHERE tenant_id=$1 AND id=$2",
              [alice.tenantId, configTarget],
            );
          }
          const intercepted = {
            write: evidence.write.bind(evidence),
            read: async (...args: Parameters<typeof evidence.read>) => {
              const text = await evidence.read(...args);
              await admin.query(
                "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='config:read'",
                [alice.tenantId, alice.actorId],
              );
              return text;
            },
          };
          try {
            await assert.rejects(
              new PostgresConfigurationService(pool, intercepted, git).get(alice, {
                repo_id: repo,
                client_version: '2.10.0',
              }),
              AccessDeniedError,
            );
          } finally {
            await admin.query(
              "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='config:read'",
              [alice.tenantId, alice.actorId],
            );
          }
          assert.deepEqual(await count(), before);
          const racing = {
            read: async (...args: Parameters<typeof git.read>) => {
              const text = await git.read(...args);
              await configurations.revoke(alice, effectiveConfig.id, mutation(effectiveConfig));
              return text;
            },
            write: git.write.bind(git),
          };
          await assert.rejects(
            new PostgresConfigurationService(pool, evidence, racing).get(alice, {
              repo_id: repo,
              client_version: '2.10.0',
            }),
            code('TEMPORARILY_UNAVAILABLE'),
          );
          assert.deepEqual(await count(), before);
          const restored = await configurations.create(alice, {
            operation_id: randomUUID(),
            body: configBody,
          });
          effectiveConfig = await configurations.activate(alice, restored.id, mutation(restored));
        },
      );
      await t.test(
        'B09 explicit revocation returns inert tombstones; rollback copies content into a new approved version',
        async () => {
          const op = mutation(effectiveConfig);
          const revoked = await configurations.revoke(alice, effectiveConfig.id, op);
          assert.equal(revoked.outcome, 'revoked');
          assert.equal(revoked.body.mandatory_rules.length, 0);
          assert.equal(revoked.sha256, sha256(canonicalJson(revoked.body)));
          assert.deepEqual(await configurations.revoke(alice, effectiveConfig.id, op), revoked);
          assert.equal(
            (
              await configurations.get(alice, {
                repo_id: repo,
                client_version: '2.10.0',
                current_config_version: effectiveConfig.revision,
              })
            ).outcome,
            'revoked',
          );
          await assert.rejects(
            configurations.activate(alice, effectiveConfig.id, mutation(effectiveConfig)),
            code('PUBLICATION_BLOCKED'),
          );
          const next = await configurations.create(alice, {
            operation_id: randomUUID(),
            body: configBody,
          });
          assert.notEqual(next.id, effectiveConfig.id);
          assert.ok(next.revision > effectiveConfig.revision);
          effectiveConfig = await configurations.activate(alice, next.id, mutation(next));
          assert.equal(effectiveConfig.status, 'active');
          await assert.rejects(
            pool.query("UPDATE akb.configs SET body='{}'::jsonb WHERE id=$1", [next.id]),
            /permission denied/,
          );
          await assert.rejects(
            pool.query("UPDATE akb.config_events SET reason='rewrite' WHERE config_id=$1", [
              next.id,
            ]),
            /permission denied/,
          );
          await assert.rejects(
            admin.query("UPDATE akb.configs SET status='active' WHERE tenant_id=$1 AND id=$2", [
              alice.tenantId,
              revoked.id,
            ]),
            /cannot be reactivated/,
          );
          await assert.rejects(
            admin.query(
              "UPDATE akb.configs SET sha256=repeat('a',64) WHERE tenant_id=$1 AND id=$2",
              [alice.tenantId, next.id],
            ),
            /immutable/,
          );
        },
      );
      await t.test(
        'B09 multi-domain config selection requires explicit grants and never widens mandatory rule scope',
        async () => {
          const domain = id(3901),
            secondRepo = id(3902),
            secondScope = id(3903),
            domainScope = id(3904);
          await admin.query(
            "INSERT INTO akb.domains(tenant_id,id,name) VALUES($1,$2,'B09 second domain')",
            [alice.tenantId, domain],
          );
          await admin.query(
            "INSERT INTO akb.repos(tenant_id,id,domain_id,name,canonical_remote) VALUES($1,$2,$3,'B09 repo','synthetic:b09-second')",
            [alice.tenantId, secondRepo, domain],
          );
          await admin.query(
            "INSERT INTO akb.scopes(tenant_id,id,kind,repo_id) VALUES($1,$2,'repo',$3)",
            [alice.tenantId, secondScope, secondRepo],
          );
          await admin.query(
            "INSERT INTO akb.scopes(tenant_id,id,kind,domain_id) VALUES($1,$2,'domain',$3)",
            [alice.tenantId, domainScope, domain],
          );
          const body = { ...configBody, repo_id: secondRepo, mandatory_rules: [] };
          await assert.rejects(
            configurations.create(alice, { operation_id: randomUUID(), body }),
            AccessDeniedError,
          );
          for (const capability of ['config:read', 'config:manage'])
            await admin.query(
              'INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,$5)',
              [alice.tenantId, randomUUID(), alice.actorId, domainScope, capability],
            );
          const second = await configurations.create(alice, { operation_id: randomUUID(), body });
          await configurations.activate(alice, second.id, mutation(second));
          assert.equal(
            (await configurations.get(alice, { repo_id: secondRepo, client_version: '2.10.0' }))
              .body.repo_id,
            secondRepo,
          );
          await assert.rejects(
            configurations.get(reviewer, { repo_id: secondRepo, client_version: '2.10.0' }),
            AccessDeniedError,
          );
          await assert.rejects(
            configurations.create(alice, {
              operation_id: randomUUID(),
              body: { ...body, mandatory_rules: configBody.mandatory_rules },
            }),
            code('PUBLICATION_BLOCKED'),
          );
        },
      );
      await t.test(
        'B09 management history uses signed scoped paging and rechecks read permissions',
        async () => {
          const first = await api.request('listConfigVersions', {
            query: { scope_id: scope.id, limit: 1 },
          });
          assert.equal(first.items.length, 1);
          assert.ok(first.next_cursor);
          const next = await api.request('listConfigVersions', {
            query: { scope_id: scope.id, limit: 1, cursor: first.next_cursor },
          });
          assert.notEqual(first.items[0]!.id, next.items[0]!.id);
          await assert.rejects(
            configurations.list(reviewer, {
              scope_id: scope.id,
              limit: 1,
              cursor: first.next_cursor,
            }),
            code('INVALID_INPUT'),
          );
          assert.equal((await app.inject('/api/v1/config/versions?limit=0')).statusCode, 400);
          await admin.query(
            "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='config:read'",
            [alice.tenantId, alice.actorId],
          );
          try {
            await assert.rejects(
              configurations.list(alice, { scope_id: scope.id }),
              AccessDeniedError,
            );
          } finally {
            await admin.query(
              "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='config:read'",
              [alice.tenantId, alice.actorId],
            );
          }
        },
      );
      await t.test(
        'B09 real MCP get-config calls HTTP and preserves unchanged or incompatible outcomes',
        async () => {
          const client = new Client({ name: 'b09-config-test', version: '1.0.0' });
          try {
            await client.connect(
              new StdioClientTransport({
                command: process.execPath,
                args: [
                  '--import',
                  'tsx',
                  fileURLToPath(new URL('../../apps/tool/src/cli.ts', import.meta.url)),
                  'mcp',
                  'serve',
                ],
                env: { ...process.env, AKB_SYNTHETIC_TOOLS: '1', AKB_ENDPOINT: endpoint } as Record<
                  string,
                  string
                >,
                stderr: 'pipe',
              }),
            );
            const response = await client.callTool({
              name: 'get-config',
              arguments: {
                repo_id: repo,
                client_version: '2.10.0',
                current_config_version: effectiveConfig.revision,
              },
            });
            assert.equal(response.isError, undefined);
            assertSchema('Config', response.structuredContent);
            assert.equal(
              (response.structuredContent as SchemaTypes['Config']).outcome,
              'unchanged',
            );
          } finally {
            await client.close();
          }
        },
      );
      await t.test(
        'B09 config reads use an independent actor quota that concurrent retries and repo changes cannot refill',
        async () => {
          await admin.query('DELETE FROM akb.config_windows WHERE tenant_id=$1 AND actor_id=$2', [
            alice.tenantId,
            alice.actorId,
          ]);
          const result = await Promise.allSettled(
            Array.from({ length: 65 }, () =>
              configurations.get(alice, { repo_id: repo, client_version: '2.10.0' }),
            ),
          );
          assert.equal(result.filter((r) => r.status === 'fulfilled').length, 60);
          assert.equal(
            result.filter((r) => r.status === 'rejected' && code('RATE_LIMITED')(r.reason)).length,
            5,
          );
          await assert.rejects(
            configurations.get(alice, { repo_id: id(3902), client_version: '2.10.0' }),
            code('RATE_LIMITED'),
          );
        },
      );
      await t.test(
        'Web knowledge list uses real scoped paging, excludes withdrawn bodies and does not spend task reads',
        async () => {
          const before = (
            await admin.query(
              'SELECT id,used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 ORDER BY id',
              [alice.tenantId],
            )
          ).rows;
          const first = await api.request('listKnowledge', {
            query: { scope_id: scope.id, limit: 1 },
          });
          assertSchema('KnowledgeSummaryPage', first);
          assert.equal(first.items.length, 1);
          assert.ok(first.next_cursor);
          assert.equal(first.items[0]!.id, configTarget);
          const next = await api.request('listKnowledge', {
            query: { scope_id: scope.id, limit: 1, cursor: first.next_cursor },
          });
          assert.equal(next.items.length, 1);
          assert.notEqual(next.items[0]!.id, first.items[0]!.id);
          await assert.rejects(
            knowledge.list(reviewer, { scope_id: scope.id, limit: 1, cursor: first.next_cursor }),
            code('INVALID_INPUT'),
          );
          assert.deepEqual(
            (
              await admin.query(
                'SELECT id,used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 ORDER BY id',
                [alice.tenantId],
              )
            ).rows,
            before,
          );
          await admin.query(
            "UPDATE akb.knowledge_entries SET serving_status='suspended' WHERE tenant_id=$1 AND id=$2",
            [alice.tenantId, configTarget],
          );
          try {
            assert.notEqual(
              (await knowledge.list(alice, { scope_id: scope.id, limit: 1 })).items[0]?.id,
              configTarget,
            );
          } finally {
            await admin.query(
              "UPDATE akb.knowledge_entries SET serving_status='enabled' WHERE tenant_id=$1 AND id=$2",
              [alice.tenantId, configTarget],
            );
          }
        },
      );
      await t.test(
        'Web knowledge list rechecks evidence revocation during actual file reads and never exposes titles on failure',
        async () => {
          const intercepted = {
            write: evidence.write.bind(evidence),
            read: async (...args: Parameters<typeof evidence.read>) => {
              const text = await evidence.read(...args);
              await admin.query(
                "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
                [alice.tenantId, alice.actorId],
              );
              return text;
            },
          };
          try {
            await assert.rejects(
              new PostgresKnowledgeGovernance(pool, intercepted, git).list(alice, {
                scope_id: scope.id,
                limit: 1,
              }),
              AccessDeniedError,
            );
          } finally {
            await admin.query(
              "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
              [alice.tenantId, alice.actorId],
            );
          }
        },
      );
    } finally {
      await app.close();
      await pool.end();
      await workerPool.end();
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
