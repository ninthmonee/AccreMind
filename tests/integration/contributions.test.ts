import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { assertSchema, createApiClient } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import { loadDevelopmentConfig } from '@accremind/domain';
import { createApp } from '../../apps/api/src/app.js';
import { AccessDeniedError, createDatabasePool } from '../../apps/api/src/database.js';
import { PostgresContributionService } from '../../apps/api/src/contributions.js';
import { PostgresAssessmentService } from '../../apps/api/src/assessments.js';
import { ContributionError } from '../../apps/api/src/contribution-errors.js';
import { FileEvidenceStore, sha256 } from '../../apps/api/src/evidence-store.js';
import { migrateDatabase } from '../../apps/api/src/migrations.js';
import {
  syntheticContributionIdentity,
  syntheticContributionsEnabled,
  syntheticRepoId,
  syntheticCapabilities,
} from '../../apps/api/src/synthetic-contributions.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const alice = { tenantId: id(1101), actorId: id(1201), authzVersion: 1 };
const bob = { ...alice, actorId: id(1202) };
const other = { tenantId: id(1102), actorId: id(1203), authzVersion: 1 };
const apiUrl = process.env.ACCREMIND_TEST_DATABASE_URL;
const ownerUrl = process.env.ACCREMIND_TEST_OWNER_URL;

test(
  'B03 real PostgreSQL receive, immutable evidence, idempotency, restart and HTTP boundary',
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
    const root = await mkdtemp(join(tmpdir(), 'accremind-b03-'));
    const store = new FileEvidenceStore(root);
    const service = new PostgresContributionService(pool, store);
    const isConflict = (error: unknown) =>
      error instanceof ContributionError && error.code === 'IDEMPOTENCY_CONFLICT';
    try {
      const guard = await admin.query<{ token: string }>(
        'SELECT token FROM public.accremind_test_guard',
      );
      assert.ok(process.env.ACCREMIND_TEST_GUARD);
      assert.equal(guard.rows[0]?.token, process.env.ACCREMIND_TEST_GUARD);
      for (const [ctx, repo, scope, domain] of [
        [alice, 1411, 1303, 1401],
        [bob, 1412, 1304, 1401],
        [other, 1413, 1305, 1402],
      ] as const) {
        await admin.query('INSERT INTO akb.tenants(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
          ctx.tenantId,
          'synthetic B03',
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
        for (const capability of ['knowledge:read', 'knowledge:contribute', 'evidence:read'])
          await admin.query(
            'INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,$5)',
            [ctx.tenantId, randomUUID(), ctx.actorId, id(scope), capability],
          );
      }
      const task = await service.createTask(alice, {
        operation_id: randomUUID(),
        repo_id: id(1411),
        client_session_id: 'synthetic B03',
      });
      const bundle = (): SchemaTypes['IngestRequest'] => ({
        idempotency_key: randomUUID(),
        repo_id: id(1411),
        task_id: task.id,
        source_event_ids: [randomUUID()],
        environment: { commit: 'synthetic-commit', dependencies: { node: '24' } },
        evidence: [
          {
            client_evidence_id: randomUUID(),
            source_kind: 'selected_text',
            source_ref: 'synthetic:note',
            source_revision: '1',
            locator: 'line:1',
            content: '合成来源支持这条断言。',
            sha256: sha256('合成来源支持这条断言。'),
          },
        ],
      });
      const input = bundle();
      let accepted: SchemaTypes['IngestResult'];

      await t.test(
        'concurrent retries produce one contribution, source, evidence, job, outbox and stable mapping',
        async () => {
          const results = await Promise.all(
            Array.from({ length: 8 }, () => service.ingest(alice, structuredClone(input))),
          );
          assert.equal(results.filter((result) => result.result === 'accepted').length, 1);
          accepted = results[0]!;
          for (const result of results) {
            assertSchema('IngestResult', result);
            assert.equal(result.contribution_id, accepted.contribution_id);
            assert.deepEqual(result.evidence_mappings, accepted.evidence_mappings);
          }
          for (const table of [
            'contributions',
            'source_events',
            'evidence',
            'contribution_evidence',
            'jobs',
            'outbox',
            'operations',
            'audit',
          ]) {
            const result = await admin.query<{ count: string }>(
              `SELECT count(*) FROM akb.${table} WHERE tenant_id=$1`,
              [alice.tenantId],
            );
            assert.equal(Number(result.rows[0]!.count), table === 'operations' ? 2 : 1, table);
          }
          const read = await service.get(alice, accepted.contribution_id);
          assert.equal(read.processing_status, 'accepted');
          assert.equal(read.candidates.length, 0);
          assert.equal(read.job_ids.length, 1);
          assert.deepEqual(read.published_ids, []);
        },
      );

      await t.test(
        'changed payload, duplicate event under a new key and operation route collisions are deterministic',
        async () => {
          const changed = structuredClone(input);
          changed.environment.commit = 'different';
          await assert.rejects(service.ingest(alice, changed), isConflict);
          const replay = { ...input, idempotency_key: randomUUID() };
          const duplicate = await service.ingest(alice, replay);
          assert.equal(duplicate.result, 'duplicate');
          assert.equal(duplicate.contribution_id, accepted.contribution_id);
          const changedEvent = { ...changed, idempotency_key: randomUUID() };
          await assert.rejects(service.ingest(alice, changedEvent), isConflict);
          await assert.rejects(
            service.createTask(alice, {
              operation_id: input.idempotency_key,
              repo_id: input.repo_id,
              client_session_id: 'collision',
            }),
            isConflict,
          );
        },
      );

      await t.test(
        'raw evidence and durable pending work survive new DB pool and storage instances',
        async () => {
          const restartedPool = createDatabasePool(apiUrl, 1);
          try {
            const restarted = new PostgresContributionService(
              restartedPool,
              new FileEvidenceStore(root),
            );
            const contribution = await restarted.get(alice, accepted.contribution_id);
            assert.deepEqual(contribution.evidence_mappings, accepted.evidence_mappings);
            assert.equal(contribution.job_ids.length, 1);
            const ref = accepted.evidence_mappings[0]!.evidence_ref;
            const evidence = await restarted.getEvidence(alice, ref.id, ref.revision);
            assertSchema('Evidence', evidence);
            assert.equal(evidence.content, input.evidence[0]!.content);
            assert.equal(evidence.evidence_kind, 'raw');
          } finally {
            await restartedPool.end();
          }
        },
      );

      await t.test(
        'idempotency is tenant-bound and a key cannot be reused by another actor',
        async () => {
          const otherTask = await service.createTask(other, {
            operation_id: randomUUID(),
            repo_id: id(1413),
            client_session_id: 'other tenant',
          });
          const otherBundle = { ...input, repo_id: id(1413), task_id: otherTask.id };
          assert.notEqual(
            (await service.ingest(other, otherBundle)).contribution_id,
            accepted.contribution_id,
          );
          const grant = randomUUID();
          await admin.query(
            "INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,'knowledge:contribute')",
            [alice.tenantId, grant, bob.actorId, id(1303)],
          );
          try {
            await assert.rejects(service.ingest(bob, input), isConflict);
          } finally {
            await admin.query('UPDATE akb.grants SET revoked_at=now() WHERE id=$1', [grant]);
          }
        },
      );

      await t.test(
        'manual candidate references existing authorized evidence and stays unassessed/unpublished',
        async () => {
          const manual = bundle();
          manual.candidates = [
            {
              type: 'decision',
              presentation: 'article',
              title: '合成手工候选',
              claim: '这是有来源的合成断言。',
              scope: { kind: 'repo', id: id(1303) },
              owner_id: alice.actorId,
              knowledge_role: 'experience',
              context: {
                preconditions: ['合成环境'],
                exclusions: [],
                dependency_constraints: [],
                verification_method: '人工检查',
              },
              rationale: {
                text: '依据已接收的合成证据',
                evidence_refs: [accepted.evidence_mappings[0]!.evidence_ref],
              },
              invalidation_triggers: ['来源发生改变'],
              alternatives: [],
              enforcement: { kind: 'none', status: 'proposed', artifact_refs: [] },
            },
          ];
          const result = await service.ingest(alice, manual);
          const contribution = await service.get(alice, result.contribution_id);
          assertSchema('Contribution', contribution);
          assert.equal(contribution.candidates.length, 1);
          assert.equal(contribution.candidates[0]!.assessment_id, null);
          assert.equal(contribution.candidates[0]!.publication_status, 'candidate');
          const forged = structuredClone(manual);
          forged.idempotency_key = randomUUID();
          forged.source_event_ids = [randomUUID()];
          forged.candidates![0]!.rationale.evidence_refs[0]!.id =
            forged.evidence[0]!.client_evidence_id;
          await assert.rejects(service.ingest(alice, forged), AccessDeniedError);
          const revision = structuredClone(forged);
          revision.candidates![0]!.rationale.evidence_refs = [
            { ...accepted.evidence_mappings[0]!.evidence_ref, revision: 2 },
          ];
          await assert.rejects(service.ingest(alice, revision), AccessDeniedError);
          const scope = structuredClone(manual);
          scope.idempotency_key = randomUUID();
          scope.source_event_ids = [randomUUID()];
          scope.candidates![0]!.scope.id = id(1304);
          await assert.rejects(service.ingest(alice, scope), AccessDeniedError);
        },
      );

      await t.test(
        'failed storage rolls back the whole DB admission and retry remains possible',
        async () => {
          const failure = bundle();
          failure.evidence.push({ ...failure.evidence[0]!, client_evidence_id: randomUUID() });
          let writes = 0;
          const failing = new PostgresContributionService(pool, {
            read: store.read.bind(store),
            write: async (...args) => {
              if (++writes === 2) throw new Error('synthetic disk failure');
              return store.write(...args);
            },
          });
          await assert.rejects(failing.ingest(alice, failure), /synthetic disk failure/);
          assert.equal(
            (
              await admin.query(
                'SELECT id FROM akb.contributions WHERE tenant_id=$1 AND idempotency_key=$2',
                [alice.tenantId, failure.idempotency_key],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await admin.query(
                'SELECT id FROM akb.source_events WHERE tenant_id=$1 AND external_event_id=$2',
                [alice.tenantId, failure.source_event_ids[0]],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await admin.query('SELECT id FROM akb.operations WHERE tenant_id=$1 AND id=$2', [
                alice.tenantId,
                failure.idempotency_key,
              ])
            ).rowCount,
            0,
          );
          assert.equal((await service.ingest(alice, failure)).result, 'accepted');
        },
      );

      await t.test('repo, actor, tenant and task authorization reject forged context', async () => {
        await assert.rejects(service.ingest(bob, bundle()), AccessDeniedError);
        await assert.rejects(service.get(bob, accepted.contribution_id), AccessDeniedError);
        const ref = accepted.evidence_mappings[0]!.evidence_ref;
        await assert.rejects(service.getEvidence(bob, ref.id, ref.revision), AccessDeniedError);
        await assert.rejects(service.get(other, accepted.contribution_id), AccessDeniedError);
        const foreign = bundle();
        foreign.repo_id = id(1412);
        await assert.rejects(service.ingest(alice, foreign), AccessDeniedError);
        await assert.rejects(
          service.ingest({ ...alice, authzVersion: 2 }, bundle()),
          AccessDeniedError,
        );
        await admin.query("UPDATE akb.tasks SET expires_at=now()-interval '1 second' WHERE id=$1", [
          task.id,
        ]);
        await assert.rejects(service.ingest(alice, bundle()), AccessDeniedError);
        assert.equal((await service.ingest(alice, input)).result, 'duplicate');
        await admin.query("UPDATE akb.tasks SET expires_at=now()+interval '1 hour' WHERE id=$1", [
          task.id,
        ]);
      });

      await t.test(
        'signed pagination binds actor, tenant and scope and retains exact ordering',
        async () => {
          const first = await service.list(alice, { limit: 1, scope_id: id(1303) });
          assert.equal(first.items.length, 1);
          assert.ok(first.next_cursor);
          const second = await service.list(alice, {
            limit: 1,
            scope_id: id(1303),
            cursor: first.next_cursor,
          });
          assert.equal(second.items.length, 1);
          assert.notEqual(second.items[0]!.id, first.items[0]!.id);
          await assert.rejects(
            service.list(bob, { limit: 1, scope_id: id(1303), cursor: first.next_cursor }),
          );
          await assert.rejects(service.list(alice, { limit: 1, cursor: first.next_cursor }));
          await assert.rejects(
            service.list(alice, { limit: 1, scope_id: id(1303), cursor: `${first.next_cursor}x` }),
          );
          assert.deepEqual((await service.list(alice, { scope_id: id(1304) })).items, []);
        },
      );

      await t.test(
        'HTTP and generated SDK exercise real service; rejects credential and actor forgery',
        async () => {
          const app = createApp(loadDevelopmentConfig({}), {
            checkDatabase: async () => true,
            contributions: service,
            resolvePrincipal: async () => ({ ...alice }),
          });
          const client = createApiClient({
            baseUrl: 'http://127.0.0.1/api/v1',
            fetch: async (input, init) => {
              const url = new URL(String(input));
              const result = await app.inject({
                method: init?.method as 'GET' | 'POST',
                url: url.pathname + url.search,
                ...(typeof init?.body === 'string'
                  ? { payload: init.body, headers: { 'content-type': 'application/json' } }
                  : {}),
              });
              return new Response(result.body, { status: result.statusCode });
            },
          });
          try {
            const created = await client.request('createTask', {
              body: { operation_id: randomUUID(), repo_id: id(1411), client_session_id: 'SDK' },
            });
            const next = bundle();
            next.task_id = created.id;
            const result = await client.request('ingestContribution', { body: next });
            assert.equal(result.processing_status, 'accepted');
            assert.equal(
              (await client.request('getContribution', { path: { id: result.contribution_id } }))
                .job_ids.length,
              1,
            );
            const ref = result.evidence_mappings[0]!.evidence_ref;
            assert.equal(
              (
                await client.request('getEvidence', {
                  path: { id: ref.id },
                  query: { revision: ref.revision },
                })
              ).content,
              next.evidence[0]!.content,
            );
            const forged = await app.inject({
              method: 'POST',
              url: '/api/v1/contributions',
              payload: { ...next, actor_id: bob.actorId },
            });
            assert.equal(forged.statusCode, 400);
            assert.equal(
              (
                await app.inject({
                  url: '/api/v1/contributions',
                  headers: { authorization: 'Bearer forged-token' },
                })
              ).statusCode,
              401,
            );
            const unknown = await app.inject(`/api/v1/evidence/${randomUUID()}?revision=1`);
            assert.equal(unknown.statusCode, 404);
            assertSchema('Error', unknown.json());
          } finally {
            await app.close();
          }
        },
      );

      await t.test(
        'explicit synthetic seed command is repeatable and its real identity adapter can receive',
        async () => {
          await admin.query(
            "CREATE ROLE akb_migration LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
          );
          await admin.query('CREATE DATABASE accremind_dev OWNER akb_migration');
          const devOwnerUrl = new URL(ownerUrl);
          devOwnerUrl.pathname = '/accremind_dev';
          devOwnerUrl.username = 'akb_migration';
          devOwnerUrl.password = 'synthetic-only';
          const devApiUrl = new URL(apiUrl);
          devApiUrl.pathname = '/accremind_dev';
          const devOwner = createDatabasePool(devOwnerUrl.toString(), 1);
          const devApi = createDatabasePool(devApiUrl.toString(), 1);
          try {
            await migrateDatabase(devOwner);
            for (let attempt = 0; attempt < 2; attempt++) {
              const seed = spawnSync(
                process.execPath,
                ['--import', 'tsx', 'apps/api/src/seed-synthetic.ts'],
                {
                  encoding: 'utf8',
                  env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    AKB_MODE: 'synthetic',
                    HOST: '127.0.0.1',
                    MODEL_ENDPOINT: '',
                    MODEL_ID: '',
                    MIGRATION_DATABASE_URL: devOwnerUrl.toString(),
                    AKB_SYNTHETIC_EVIDENCE_DIR: root,
                  },
                },
              );
              assert.equal(seed.status, 0, seed.stdout + seed.stderr);
              assert.equal((JSON.parse(seed.stdout) as { real_login: boolean }).real_login, false);
            }
            const config = loadDevelopmentConfig({ DATABASE_URL: devApiUrl.toString() });
            assert.equal(
              syntheticContributionsEnabled({ AKB_SYNTHETIC_CONTRIBUTIONS: '1' }, config),
              true,
            );
            const app = createApp(config, {
              checkDatabase: async () => true,
              contributions: new PostgresContributionService(devApi, store),
              assessments: new PostgresAssessmentService(devApi, store),
              ...syntheticContributionIdentity(devApi),
            });
            try {
              const me = await app.inject('/api/v1/me');
              assert.equal(me.statusCode, 200);
              assert.deepEqual((me.json() as { data: SchemaTypes['Me'] }).data.capabilities, [
                ...syntheticCapabilities,
              ]);
              const response = await app.inject({
                method: 'POST',
                url: '/api/v1/tasks',
                payload: {
                  operation_id: randomUUID(),
                  repo_id: syntheticRepoId,
                  client_session_id: 'synthetic seed acceptance',
                },
              });
              assert.equal(response.statusCode, 201);
              const next = bundle();
              next.repo_id = syntheticRepoId;
              next.task_id = (response.json() as { data: SchemaTypes['Task'] }).data.id;
              const received = await app.inject({
                method: 'POST',
                url: '/api/v1/contributions',
                payload: next,
              });
              assert.equal(received.statusCode, 202);
              assertSchema('IngestResult', (received.json() as { data: unknown }).data);
              const address = await app.listen({ host: '127.0.0.1', port: 0 });
              const demo = await new Promise<{ status: number | null; output: string }>(
                (resolve, reject) => {
                  const child = spawn(process.execPath, ['scripts/demo-contribution.mjs'], {
                    env: { ...process.env, AKB_ENDPOINT: address },
                    stdio: ['ignore', 'pipe', 'pipe'],
                  });
                  let output = '';
                  let errors = '';
                  child.stdout.on('data', (chunk: Buffer) => {
                    output += chunk.toString();
                  });
                  child.stderr.on('data', (chunk: Buffer) => {
                    errors += chunk.toString();
                  });
                  child.once('error', reject);
                  child.once('close', (status) => {
                    resolve({ status, output: status === 0 ? output : errors });
                  });
                },
              );
              assert.equal(demo.status, 0, demo.output);
              const report = JSON.parse(demo.output) as {
                retry: string;
                evidence_integrity: boolean;
                manual_contribution: SchemaTypes['Contribution'];
              };
              assert.equal(report.retry, 'duplicate');
              assert.equal(report.evidence_integrity, true);
              assert.equal(report.manual_contribution.candidates.length, 1);
              const assessmentDemo = await new Promise<{ status: number | null; output: string }>(
                (resolve, reject) => {
                  const child = spawn(
                    process.execPath,
                    ['--import', 'tsx', 'scripts/demo-assessment.mjs'],
                    {
                      env: { ...process.env, AKB_ENDPOINT: address },
                      stdio: ['ignore', 'pipe', 'pipe'],
                    },
                  );
                  let output = '';
                  let errors = '';
                  child.stdout.on('data', (chunk: Buffer) => {
                    output += chunk.toString();
                  });
                  child.stderr.on('data', (chunk: Buffer) => {
                    errors += chunk.toString();
                  });
                  child.once('error', reject);
                  child.once('close', (status) =>
                    resolve({ status, output: status === 0 ? output : errors }),
                  );
                },
              );
              assert.equal(assessmentDemo.status, 0, assessmentDemo.output);
              const assessmentReport = JSON.parse(assessmentDemo.output) as {
                outcomes: { disposition: string; idempotent: boolean; published_ids: string[] }[];
              };
              assert.deepEqual(
                assessmentReport.outcomes.map((outcome) => outcome.disposition),
                [
                  'index_only',
                  'link_existing',
                  'knowledge_candidate',
                  'needs_confirmation',
                  'discard',
                ],
              );
              assert.ok(
                assessmentReport.outcomes.every(
                  (outcome) => outcome.idempotent && outcome.published_ids.length === 0,
                ),
              );
            } finally {
              await app.close();
            }
          } finally {
            await devOwner.end();
            await devApi.end();
          }
        },
      );

      await t.test(
        'quarantine, expiry and evidence revocation hide exact IDs and locators on retries',
        async () => {
          const ref = accepted.evidence_mappings[0]!.evidence_ref;
          for (const status of ['quarantined', 'expired', 'deleted']) {
            await admin.query('UPDATE akb.evidence SET status=$1 WHERE id=$2', [status, ref.id]);
            await assert.rejects(
              service.getEvidence(alice, ref.id, ref.revision),
              AccessDeniedError,
            );
            assert.deepEqual((await service.ingest(alice, input)).evidence_mappings, []);
          }
          await admin.query(
            "UPDATE akb.evidence SET status='available',expires_at=now()-interval '1 second' WHERE id=$1",
            [ref.id],
          );
          await assert.rejects(service.getEvidence(alice, ref.id, ref.revision), AccessDeniedError);
          await admin.query(
            "UPDATE akb.evidence SET expires_at=now()+interval '1 day' WHERE id=$1",
            [ref.id],
          );
          await admin.query(
            "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='evidence:read'",
            [alice.tenantId, alice.actorId],
          );
          await assert.rejects(service.getEvidence(alice, ref.id, ref.revision), AccessDeniedError);
          const duplicate = await service.ingest(alice, input);
          assert.deepEqual(duplicate.evidence_mappings, []);
          const listed = await service.list(alice);
          assert.ok(
            listed.items.every(
              (item) => item.evidence_mappings.length === 0 && item.candidates.length === 0,
            ),
          );
          await admin.query(
            "UPDATE akb.grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2 AND capability='knowledge:contribute'",
            [alice.tenantId, alice.actorId],
          );
          await assert.rejects(service.ingest(alice, input), AccessDeniedError);
          await assert.rejects(service.get(alice, accepted.contribution_id), AccessDeniedError);
        },
      );
    } finally {
      await pool.end();
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
