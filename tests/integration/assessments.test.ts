import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertSchema, createApiClient } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import { loadDevelopmentConfig } from '@accremind/domain';
import { createApp } from '../../apps/api/src/app.js';
import {
  AccessDeniedError,
  createDatabasePool,
  withPrincipalTransaction,
} from '../../apps/api/src/database.js';
import { PostgresContributionService } from '../../apps/api/src/contributions.js';
import { PostgresAssessmentService } from '../../apps/api/src/assessments.js';
import { ContributionError } from '../../apps/api/src/contribution-errors.js';
import { FileEvidenceStore, sha256 } from '../../apps/api/src/evidence-store.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const alice = { tenantId: id(2101), actorId: id(2201), authzVersion: 1 };
const bob = { ...alice, actorId: id(2202) };
const checker = { ...alice, actorId: id(2203) };
const other = { tenantId: id(2102), actorId: id(2204), authzVersion: 1 };
const apiUrl = process.env.ACCREMIND_TEST_DATABASE_URL;
const ownerUrl = process.env.ACCREMIND_TEST_OWNER_URL;

test(
  'B05 real PostgreSQL human checks, five-way routing, provenance, concurrency and navigation',
  { skip: !apiUrl || !ownerUrl, timeout: 60000 },
  async (t) => {
    assert.ok(apiUrl && ownerUrl);
    for (const value of [apiUrl, ownerUrl]) {
      const url = new URL(value);
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(url.pathname, '/accremind_test');
    }
    const admin = createDatabasePool(ownerUrl, 1);
    const pool = createDatabasePool(apiUrl, 4);
    const root = await mkdtemp(join(tmpdir(), 'accremind-b05-'));
    const store = new FileEvidenceStore(root);
    const contributions = new PostgresContributionService(pool, store);
    const service = new PostgresAssessmentService(pool, store);
    const isInvalid = (error: unknown) =>
      error instanceof ContributionError && error.code === 'INVALID_INPUT';
    try {
      const guard = await admin.query<{ token: string }>(
        'SELECT token FROM public.accremind_test_guard',
      );
      assert.ok(process.env.ACCREMIND_TEST_GUARD);
      assert.equal(guard.rows[0]?.token, process.env.ACCREMIND_TEST_GUARD);
      for (const [ctx, repo, scope, domain] of [
        [alice, 2411, 2303, 2401],
        [bob, 2412, 2304, 2401],
        [other, 2413, 2305, 2402],
      ] as const) {
        await admin.query('INSERT INTO akb.tenants(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
          ctx.tenantId,
          'synthetic B05',
        ]);
        await admin.query(
          "INSERT INTO akb.principals(tenant_id,id,oidc_issuer,oidc_subject,display_name) VALUES($1,$2::uuid,'synthetic',$2::text,$2::text)",
          [ctx.tenantId, ctx.actorId],
        );
        await admin.query(
          'INSERT INTO akb.domains(tenant_id,id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [ctx.tenantId, id(domain), 'synthetic'],
        );
        await admin.query(
          'INSERT INTO akb.repos(tenant_id,id,domain_id,name,canonical_remote) VALUES($1,$2::uuid,$3,$2::text,$2::text)',
          [ctx.tenantId, id(repo), id(domain)],
        );
        await admin.query(
          "INSERT INTO akb.scopes(tenant_id,id,kind,repo_id) VALUES($1,$2,'repo',$3)",
          [ctx.tenantId, id(scope), id(repo)],
        );
        for (const capability of [
          'knowledge:read',
          'knowledge:contribute',
          'evidence:read',
          'knowledge:assess',
          'knowledge:review',
        ])
          await admin.query(
            'INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,$5)',
            [ctx.tenantId, randomUUID(), ctx.actorId, id(scope), capability],
          );
      }
      await admin.query(
        "INSERT INTO akb.principals(tenant_id,id,oidc_issuer,oidc_subject,display_name) VALUES($1,$2,'synthetic','checker','checker')",
        [checker.tenantId, checker.actorId],
      );
      for (const capability of [
        'knowledge:read',
        'evidence:read',
        'knowledge:assess',
        'knowledge:review',
      ])
        await admin.query(
          'INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,$5)',
          [alice.tenantId, randomUUID(), checker.actorId, id(2303), capability],
        );
      const commit = 'b05-commit';
      const fixtures = new Map<
        SchemaTypes['Material']['material_kind'],
        { material: SchemaTypes['Material']; ref: SchemaTypes['EvidenceRef'] }
      >();
      for (const kind of ['code', 'test', 'authoritative_doc', 'history'] as const) {
        const evidenceId = randomUUID();
        const content = `合成 ${kind} 材料：接收行为、规范和历史动机分开记录。`;
        const key = await store.write(alice.tenantId, evidenceId, content);
        const material: SchemaTypes['Material'] = {
          source_ref: `synthetic:b05/${kind}`,
          source_revision: commit,
          locator: 'line:1',
          content_hash: sha256(content),
          material_kind: kind,
        };
        await admin.query(
          `INSERT INTO akb.evidence(tenant_id,id,revision,scope_id,source_ref,source_revision,locator,object_key,sha256,evidence_kind,status,expires_at)
          VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,'raw','available',now()+interval '1 day')`,
          [
            alice.tenantId,
            evidenceId,
            id(2303),
            material.source_ref,
            commit,
            material.locator,
            key,
            material.content_hash,
          ],
        );
        await admin.query(
          `INSERT INTO akb.baseline_materials(tenant_id,id,repo_id,source_ref,source_revision,locator,content_hash,material_kind,evidence_id,evidence_revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
          [
            alice.tenantId,
            randomUUID(),
            id(2411),
            material.source_ref,
            commit,
            material.locator,
            material.content_hash,
            kind,
            evidenceId,
          ],
        );
        fixtures.set(kind, { material, ref: { id: evidenceId, revision: 1, locator: 'line:1' } });
      }
      const source = (kind: SchemaTypes['Material']['material_kind']) => fixtures.get(kind)!;
      const body = (title = '合成候选', mirror = false): SchemaTypes['CandidateBody'] => ({
        type: 'decision',
        presentation: 'article',
        title,
        claim: '有来源的合成断言。',
        scope: { kind: 'repo', id: id(2303) },
        owner_id: alice.actorId,
        context: {
          preconditions: ['合成环境'],
          exclusions: [],
          dependency_constraints: [],
          verification_method: '人工检查',
        },
        rationale: { text: '依据合成来源', evidence_refs: [source('history').ref] },
        invalidation_triggers: ['材料改变'],
        alternatives: [],
        enforcement: { kind: 'none', status: 'proposed', artifact_refs: [] },
        ...(mirror
          ? {
              knowledge_role: 'authoritative_mirror' as const,
              mirror: {
                authority_ref: source('authoritative_doc').ref,
                sync_owner_id: alice.actorId,
                reason: '合成镜像例外演练',
              },
            }
          : { knowledge_role: 'experience' as const }),
      });
      const task = await contributions.createTask(alice, {
        operation_id: randomUUID(),
        repo_id: id(2411),
        client_session_id: 'B05 tests',
      });
      const packet = async (bodies: SchemaTypes['CandidateBody'][] = [body()]) => {
        const content = '合成手工贡献包';
        const input: SchemaTypes['IngestRequest'] = {
          idempotency_key: randomUUID(),
          repo_id: id(2411),
          task_id: task.id,
          source_event_ids: [randomUUID()],
          environment: { commit, dependencies: {} },
          candidates: bodies,
          evidence: [
            {
              client_evidence_id: randomUUID(),
              source_kind: 'selected_text',
              source_ref: 'synthetic:b05/contribution',
              source_revision: '1',
              locator: 'line:1',
              content,
              sha256: sha256(content),
            },
          ],
        };
        const received = await contributions.ingest(alice, input);
        return contributions.get(alice, received.contribution_id);
      };
      const check = (disposition: SchemaTypes['Disposition']): SchemaTypes['Assessment'] => {
        const complete = disposition !== 'needs_confirmation' && disposition !== 'discard';
        const baseline = source(disposition === 'link_existing' ? 'authoritative_doc' : 'code');
        return {
          question: '当前代码与权威材料能够恢复哪些信息？',
          assessment_method: 'human_review',
          rule_version: 'human-v1',
          checked_context: {
            repo_id: id(2411),
            commit,
            materials: complete ? [structuredClone(baseline.material)] : [],
            queries: complete ? ['查阅已登记材料'] : [],
            completed: complete,
            incomplete_reason: complete ? 'none' : 'not_checked',
            elapsed_ms: 20,
            input_tokens: 0,
            output_tokens: 0,
            tool_calls: complete ? 1 : 0,
          },
          baseline_answer: {
            text: complete ? '实际查阅的合成材料覆盖了行为或规范。' : '尚未执行基线检查。',
            evidence_refs: complete ? [{ ...baseline.ref }] : [],
          },
          discoverability: !complete
            ? 'inconclusive'
            : disposition === 'index_only'
              ? 'code_recoverable'
              : disposition === 'link_existing'
                ? 'authoritative_source'
                : 'missing_context',
          knowledge_delta:
            disposition === 'knowledge_candidate'
              ? [
                  {
                    claim_id: randomUUID(),
                    text: '历史动机是独立增量。',
                    evidence_refs: [source('history').ref],
                    support: 'confirmed_decision',
                  },
                ]
              : [],
          omission_consequence: '是否遗漏必要上下文由人工确认。',
          priority: 'P1',
          disposition,
          reason:
            disposition === 'discard'
              ? '显式人工判定：合成条目无复用价值。'
              : '依据检查与证据分流。',
          confirmation_questions:
            disposition === 'needs_confirmation' ? ['请补充实际基线检查。'] : [],
        };
      };
      const write = (
        candidate: SchemaTypes['Candidate'],
        assessment: SchemaTypes['Assessment'],
      ): SchemaTypes['AssessmentWrite'] => ({
        operation_id: randomUUID(),
        expected_revision: candidate.revision,
        assessment,
      });
      let routed: SchemaTypes['Contribution'];

      await t.test(
        'five dispositions survive sibling concurrency with consistent counts and no publication',
        async () => {
          const routes: SchemaTypes['Disposition'][] = [
            'index_only',
            'link_existing',
            'knowledge_candidate',
            'needs_confirmation',
            'discard',
          ];
          const contribution = await packet(routes.map((route) => body(`route:${route}`)));
          await Promise.all(
            contribution.candidates.map((candidate) =>
              service.saveHumanCheck(
                alice,
                candidate.id,
                write(
                  candidate,
                  check(routes.find((route) => candidate.body.title === `route:${route}`)!),
                ),
              ),
            ),
          );
          routed = await contributions.get(alice, contribution.id);
          assertSchema('Contribution', routed);
          for (const route of routes) assert.equal(routed.route_counts[route], 1);
          assert.equal(routed.processing_status, 'waiting_confirmation');
          assert.deepEqual(routed.published_ids, []);
          assert.ok(routed.candidates.every((candidate) => candidate.assessment_id !== null));
          assert.equal(
            (
              await admin.query(
                "SELECT id FROM akb.jobs WHERE tenant_id=$1 AND dedupe_key=$2 AND status='succeeded'",
                [alice.tenantId, contribution.id],
              )
            ).rowCount,
            1,
          );
          const view = await service.getReview(checker, routed.candidates[0]!.id);
          assertSchema('ReviewView', view);
          assert.equal(view.current_approval, null);
          assert.deepEqual(view.allowed_actions, []);
        },
      );

      await t.test(
        'all index/link/discard is completed zero knowledge output, not a fabricated candidate',
        async () => {
          const routes: SchemaTypes['Disposition'][] = ['index_only', 'link_existing', 'discard'];
          const contribution = await packet(routes.map((route) => body(`zero:${route}`)));
          for (const candidate of contribution.candidates)
            await service.saveHumanCheck(
              alice,
              candidate.id,
              write(
                candidate,
                check(routes.find((route) => candidate.body.title === `zero:${route}`)!),
              ),
            );
          const state = await contributions.get(alice, contribution.id);
          assert.equal(state.processing_status, 'completed');
          assert.equal(state.route_counts.knowledge_candidate, 0);
          assert.deepEqual(state.published_ids, []);
          assert.equal(
            (
              await admin.query('SELECT id FROM akb.knowledge_entries WHERE tenant_id=$1', [
                alice.tenantId,
              ])
            ).rowCount,
            0,
          );
        },
      );

      await t.test(
        'incomplete, P0 unsupported, contradictory routes and fake isolated execution are rejected or confirmed',
        async () => {
          const candidate = (await packet()).candidates[0]!;
          const incomplete = check('needs_confirmation');
          incomplete.discoverability = 'missing_context';
          incomplete.disposition = 'knowledge_candidate';
          await assert.rejects(
            service.saveHumanCheck(alice, candidate.id, write(candidate, incomplete)),
            isInvalid,
          );
          const unsupported = check('knowledge_candidate');
          unsupported.priority = 'P0';
          unsupported.knowledge_delta[0]!.support = 'inference';
          await assert.rejects(
            service.saveHumanCheck(alice, candidate.id, write(candidate, unsupported)),
            isInvalid,
          );
          unsupported.disposition = 'needs_confirmation';
          assert.equal(
            (await service.saveHumanCheck(alice, candidate.id, write(candidate, unsupported)))
              .assessment.disposition,
            'needs_confirmation',
          );
          const fresh = (await packet()).candidates[0]!;
          const isolated = check('index_only');
          isolated.assessment_method = 'isolated_check';
          await assert.rejects(
            service.saveHumanCheck(alice, fresh.id, write(fresh, isolated)),
            isInvalid,
          );
          const wrong = check('index_only');
          wrong.disposition = 'knowledge_candidate';
          await assert.rejects(
            service.saveHumanCheck(alice, fresh.id, write(fresh, wrong)),
            isInvalid,
          );
          const duplicate = check('knowledge_candidate');
          duplicate.knowledge_delta.push({ ...duplicate.knowledge_delta[0]! });
          await assert.rejects(
            service.saveHumanCheck(alice, fresh.id, write(fresh, duplicate)),
            isInvalid,
          );
          const repo = check('index_only');
          repo.checked_context.repo_id = id(2412);
          await assert.rejects(
            service.saveHumanCheck(alice, fresh.id, write(fresh, repo)),
            isInvalid,
          );
          repo.checked_context.repo_id = id(2411);
          repo.checked_context.commit = 'different';
          await assert.rejects(
            service.saveHumanCheck(alice, fresh.id, write(fresh, repo)),
            isInvalid,
          );
        },
      );

      await t.test(
        'registered source kinds, hashes, exact references and checked citations cannot be forged',
        async () => {
          const candidate = (await packet()).candidates[0]!;
          for (const mutate of [
            (a: SchemaTypes['Assessment']) => {
              a.checked_context.materials[0]!.content_hash = 'f'.repeat(64);
            },
            (a: SchemaTypes['Assessment']) => {
              a.checked_context.materials[0]!.material_kind = 'authoritative_doc';
            },
            (a: SchemaTypes['Assessment']) => {
              a.checked_context.materials[0]!.locator = 'line:2';
            },
          ]) {
            const a = check('index_only');
            mutate(a);
            await assert.rejects(
              service.saveHumanCheck(alice, candidate.id, write(candidate, a)),
              AccessDeniedError,
            );
          }
          const bad = check('knowledge_candidate');
          bad.knowledge_delta[0]!.evidence_refs[0] = { ...source('history').ref, revision: 2 };
          await assert.rejects(
            service.saveHumanCheck(alice, candidate.id, write(candidate, bad)),
            AccessDeniedError,
          );
          const uncited = check('index_only');
          uncited.baseline_answer.evidence_refs = [source('history').ref];
          await assert.rejects(
            service.saveHumanCheck(alice, candidate.id, write(candidate, uncited)),
            isInvalid,
          );
          const cause = check('knowledge_candidate');
          cause.knowledge_delta[0]!.evidence_refs = [source('code').ref];
          await assert.rejects(
            service.saveHumanCheck(alice, candidate.id, write(candidate, cause)),
            isInvalid,
          );
          cause.checked_context.materials = [structuredClone(source('authoritative_doc').material)];
          cause.baseline_answer.evidence_refs = [{ ...source('authoritative_doc').ref }];
          await assert.rejects(
            service.saveHumanCheck(alice, candidate.id, write(candidate, cause)),
            isInvalid,
          );
        },
      );

      await t.test(
        'different operations racing one candidate yield one CAS winner and append-only history',
        async () => {
          const candidate = (await packet()).candidates[0]!;
          const outcomes = await Promise.allSettled([
            service.saveHumanCheck(alice, candidate.id, write(candidate, check('index_only'))),
            service.saveHumanCheck(checker, candidate.id, write(candidate, check('link_existing'))),
          ]);
          assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
          const loser = outcomes.find((result) => result.status === 'rejected');
          assert.ok(
            loser?.status === 'rejected' &&
              loser.reason instanceof ContributionError &&
              loser.reason.code === 'REVISION_CONFLICT',
          );
          assert.equal(
            (
              await admin.query(
                'SELECT id FROM akb.assessments WHERE tenant_id=$1 AND candidate_id=$2',
                [alice.tenantId, candidate.id],
              )
            ).rowCount,
            1,
          );
          assert.equal((await service.getReview(alice, candidate.id)).candidate.revision, 2);
        },
      );

      await t.test(
        'same operation restores its exact historical check after later revisions and rejects changed payload',
        async () => {
          const candidate = (await packet()).candidates[0]!;
          const input = write(candidate, check('index_only'));
          const results = await Promise.all(
            Array.from({ length: 6 }, () => service.saveHumanCheck(alice, candidate.id, input)),
          );
          for (const result of results) assert.deepEqual(result, results[0]);
          const current = (await service.getReview(alice, candidate.id)).candidate;
          const second = await service.saveHumanCheck(
            alice,
            candidate.id,
            write(current, check('discard')),
          );
          assert.equal(second.id, results[0]!.id);
          assert.equal(second.revision, 2);
          assert.deepEqual(await service.saveHumanCheck(alice, candidate.id, input), results[0]);
          const changed = structuredClone(input);
          changed.assessment.reason = 'changed';
          await assert.rejects(
            service.saveHumanCheck(alice, candidate.id, changed),
            (error: unknown) =>
              error instanceof ContributionError && error.code === 'IDEMPOTENCY_CONFLICT',
          );
          assert.equal(
            (
              await admin.query(
                'SELECT id FROM akb.assessments WHERE tenant_id=$1 AND candidate_id=$2',
                [alice.tenantId, candidate.id],
              )
            ).rowCount,
            2,
          );
        },
      );

      await t.test(
        'candidate edit binds received evidence, invalidates current check and navigation while retaining history',
        async () => {
          const contribution = await packet();
          const candidate = contribution.candidates[0]!;
          const first = await service.saveHumanCheck(
            alice,
            candidate.id,
            write(candidate, check('index_only')),
          );
          const view = await service.getReview(alice, candidate.id);
          const nextBody = {
            ...view.candidate.body,
            claim: '修改后的断言',
            rationale: {
              text: '绑定新上传证据',
              evidence_refs: [contribution.evidence_mappings[0]!.evidence_ref],
            },
          };
          const input: SchemaTypes['CandidatePatch'] = {
            operation_id: randomUUID(),
            expected_revision: view.candidate.revision,
            body: nextBody,
          };
          const updated = await service.updateCandidate(alice, candidate.id, input);
          assert.equal(updated.assessment_id, null);
          assert.equal(updated.revision, 3);
          assert.notEqual(updated.evidence_set_hash, view.candidate.evidence_set_hash);
          assert.deepEqual(await service.updateCandidate(alice, candidate.id, input), updated);
          const state = await contributions.get(alice, contribution.id);
          assert.equal(state.processing_status, 'accepted');
          assert.equal(state.route_counts.index_only, 0);
          assert.ok(
            !(await service.listNavigation(alice, { scope_id: id(2303) })).items.some(
              (item) => item.assessment_id === first.id,
            ),
          );
          const second = await service.saveHumanCheck(
            alice,
            candidate.id,
            write(updated, check('knowledge_candidate')),
          );
          assert.equal(second.id, first.id);
          assert.equal(second.revision, 2);
          const scope = structuredClone(input);
          scope.operation_id = randomUUID();
          scope.expected_revision = 4;
          scope.body.scope.id = id(2304);
          await assert.rejects(service.updateCandidate(alice, candidate.id, scope), isInvalid);
        },
      );

      await t.test(
        'authoritative mirror preserves link_existing and waits for independent mirror approval',
        async () => {
          const contribution = await packet([body('mirror', true)]);
          const candidate = contribution.candidates[0]!;
          await service.saveHumanCheck(
            alice,
            candidate.id,
            write(candidate, check('link_existing')),
          );
          const state = await contributions.get(alice, contribution.id);
          assert.equal(state.route_counts.link_existing, 1);
          assert.equal(state.route_counts.knowledge_candidate, 0);
          assert.equal(state.processing_status, 'waiting_review');
          const view = await service.getReview(alice, candidate.id);
          assert.ok(
            view.blocking_reasons.some((reason) => reason.code === 'MIRROR_APPROVAL_REQUIRED'),
          );
          assert.equal(view.current_approval, null);
        },
      );

      await t.test(
        'review priority, signed navigation paging and filters expose only current authorized sources',
        async () => {
          const low = (await packet([body('priority-low')])).candidates[0]!;
          const high = (await packet([body('priority-high')])).candidates[0]!;
          const lowCheck = check('knowledge_candidate');
          lowCheck.priority = 'P2';
          const highCheck = check('knowledge_candidate');
          highCheck.priority = 'P0';
          await service.saveHumanCheck(alice, low.id, write(low, lowCheck));
          await service.saveHumanCheck(alice, high.id, write(high, highCheck));
          const queue = await service.listReviews(alice, { scope_id: id(2303), limit: 100 });
          assert.ok(
            queue.items.findIndex((item) => item.id === high.id) <
              queue.items.findIndex((item) => item.id === low.id),
          );
          const first = await service.listNavigation(alice, { scope_id: id(2303), limit: 1 });
          assert.equal(first.items.length, 1);
          assert.ok(first.next_cursor);
          const second = await service.listNavigation(alice, {
            scope_id: id(2303),
            limit: 1,
            cursor: first.next_cursor,
          });
          assert.equal(second.items.length, 1);
          assert.notEqual(second.items[0]!.id, first.items[0]!.id);
          await assert.rejects(
            service.listNavigation(alice, {
              scope_id: id(2303),
              query: 'different',
              cursor: first.next_cursor,
            }),
          );
          await assert.rejects(
            service.listNavigation(bob, { scope_id: id(2303), cursor: first.next_cursor }),
          );
          assert.ok(
            (
              await service.listNavigation(alice, { scope_id: id(2303), query: 'zero:' })
            ).items.every((item) => item.title.startsWith('zero:')),
          );
        },
      );

      await t.test(
        'HTTP SDK saves and reads real checks while body/actor forgery and absent capability fail safely',
        async () => {
          const candidate = (await packet()).candidates[0]!;
          const app = createApp(loadDevelopmentConfig({}), {
            checkDatabase: async () => true,
            contributions,
            assessments: service,
            resolvePrincipal: async () => ({ ...alice }),
          });
          const client = createApiClient({
            baseUrl: 'http://127.0.0.1/api/v1',
            fetch: async (input, init) => {
              const url = new URL(String(input));
              const response = await app.inject({
                method: init?.method as 'GET' | 'PUT' | 'PATCH',
                url: url.pathname + url.search,
                ...(typeof init?.body === 'string'
                  ? { payload: init.body, headers: { 'content-type': 'application/json' } }
                  : {}),
              });
              return new Response(response.body, { status: response.statusCode });
            },
          });
          try {
            const saved = await client.request('writeAssessment', {
              path: { id: candidate.id },
              body: write(candidate, check('index_only')),
            });
            assertSchema('AssessmentRecord', saved);
            const view = await client.request('getCandidateReview', { path: { id: candidate.id } });
            assert.equal(view.assessment?.id, saved.id);
            assertSchema(
              'NavigationPage',
              await client.request('listNavigation', { query: { scope_id: id(2303), limit: 1 } }),
            );
            const forged = await app.inject({
              method: 'PUT',
              url: `/api/v1/candidates/${candidate.id}/assessment`,
              payload: { ...write(view.candidate, check('index_only')), checked_by: bob.actorId },
            });
            assert.equal(forged.statusCode, 400);
            assert.equal((await app.inject('/api/v1/navigation?limit=1')).statusCode, 400);
            assert.equal((await app.inject('/api/v1/reviews?limit=101')).statusCode, 400);
          } finally {
            await app.close();
          }
          await assert.rejects(service.getReview(bob, candidate.id), AccessDeniedError);
          await assert.rejects(service.getReview(other, candidate.id), AccessDeniedError);
          await assert.rejects(
            service.saveHumanCheck(bob, candidate.id, write(candidate, check('index_only'))),
            AccessDeniedError,
          );
          await assert.rejects(
            withPrincipalTransaction(pool, alice, (client) =>
              client.query(
                'INSERT INTO akb.baseline_materials SELECT * FROM akb.baseline_materials WHERE false',
              ),
            ),
          );
        },
      );

      await t.test(
        'revocation during evidence I/O rolls back the decision; reviewers get safe placeholders',
        async () => {
          const candidate = (await packet([body('secret-title-for-review')])).candidates[0]!;
          let revoked = false;
          const slowService = new PostgresAssessmentService(pool, {
            write: store.write.bind(store),
            read: async (...args) => {
              const content = await store.read(...args);
              if (!revoked) {
                revoked = true;
                await admin.query(
                  "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
                  [alice.tenantId, alice.actorId],
                );
              }
              return content;
            },
          });
          await assert.rejects(
            slowService.saveHumanCheck(
              alice,
              candidate.id,
              write(candidate, check('knowledge_candidate')),
            ),
            AccessDeniedError,
          );
          assert.equal(
            (
              await admin.query(
                'SELECT id FROM akb.assessments WHERE tenant_id=$1 AND candidate_id=$2',
                [alice.tenantId, candidate.id],
              )
            ).rowCount,
            0,
          );
          const view = await service.getReview(alice, candidate.id);
          assert.equal(view.candidate.body.title, '内容不可访问');
          assert.equal(view.assessment, null);
          assert.deepEqual(view.evidence_refs, []);
          assert.ok(!JSON.stringify(view).includes('secret-title-for-review'));
          assert.deepEqual(
            (await service.listNavigation(alice, { scope_id: id(2303), limit: 100 })).items,
            [],
          );
          await admin.query(
            "UPDATE akb.grants SET revoked_at=NULL WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
            [alice.tenantId, alice.actorId],
          );
        },
      );
    } finally {
      await pool.end();
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
