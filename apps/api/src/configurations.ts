import { randomUUID } from 'node:crypto';
import { assertSchema } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext, ContentStore } from '@accremind/domain';
import { AccessDeniedError, withPrincipalTransaction } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';
import { allowedScopesSql, allowedScopesInTransaction } from './authorization.js';
import { AssessmentCursor } from './assessment-cursor.js';
import {
  assertCapability,
  governanceInput,
  operation,
  finish,
  stale,
  blocked,
} from './governance-state.js';
import { canonicalJson } from './contribution-input.js';
import { sha256 } from './evidence-store.js';
import type { FileEvidenceStore } from './evidence-store.js';
import { evidenceMetadata, checkEvidenceFiles } from './assessment-evidence.js';
import { compatibleHost, mandatoryRuleText, stableHostVersion } from './configuration-rules.js';
import { ContributionError, invalidInput } from './contribution-errors.js';

type ConfigRow = {
  id: string;
  scope_id: string;
  revision: string;
  status: SchemaTypes['Config']['status'];
  body: SchemaTypes['ConfigBody'];
  sha256: string;
  base_generation: string | null;
  created_at: Date;
};
type RuleSnapshot = {
  body: SchemaTypes['CandidateBody'];
  source_refs: SchemaTypes['EvidenceRef'][];
};
export class PostgresConfigurationService {
  private readonly cursors = new AssessmentCursor(0);
  constructor(
    private readonly pool: TransactionPool,
    private readonly evidence: Pick<FileEvidenceStore, 'read' | 'write'>,
    private readonly content: ContentStore,
  ) {}

  async create(
    ctx: PrincipalContext,
    value: SchemaTypes['ConfigWrite'],
  ): Promise<SchemaTypes['Config']> {
    const input = governanceInput<SchemaTypes['ConfigWrite']>('ConfigWrite', value);
    if (!stableHostVersion(input.body.min_host_version))
      invalidInput('Minimum host version must be stable numeric semver');
    if (
      new Set(input.body.mandatory_rules.map((r) => r.knowledge_id)).size !==
      input.body.mandatory_rules.length
    )
      invalidInput('Duplicate mandatory rule');
    const identity = { ...ctx },
      hash = sha256(canonicalJson(input)),
      route = 'createConfig';
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const scope = await this.repoScope(client, identity, input.body.repo_id, 'config:manage');
      const head = await this.head(client, identity, scope);
      const previous = await operation(client, identity, input.operation_id, route, hash);
      if (previous) {
        const saved = previous.response as SchemaTypes['Config'];
        const row = await this.row(client, identity, saved.id, 'config:manage');
        if (row.status === 'revoked') return this.view(row, 'revoked');
        await this.rules(client, identity, scope, input.body);
        return saved;
      }
      await this.rules(client, identity, scope, input.body);
      await assertCapability(client, identity, scope, 'config:manage');
      const row = (
        await client.query<ConfigRow>(
          `INSERT INTO akb.configs(tenant_id,id,scope_id,revision,status,body,sha256,publisher_id,base_generation) VALUES($1,$2,$3,$4,'draft',$5::jsonb,$6,$7,$8) RETURNING *`,
          [
            identity.tenantId,
            randomUUID(),
            scope,
            head.next_revision,
            JSON.stringify(input.body),
            sha256(canonicalJson(input.body)),
            identity.actorId,
            head.generation,
          ],
        )
      ).rows[0]!;
      await client.query(
        'UPDATE akb.config_heads SET next_revision=next_revision+1 WHERE tenant_id=$1 AND scope_id=$2',
        [identity.tenantId, scope],
      );
      await this.event(
        client,
        identity,
        row,
        input.operation_id,
        'created',
        'Explicit configuration draft',
      );
      const result = this.view(row);
      await finish(client, identity, input.operation_id, route, hash, result);
      return result;
    });
  }

  async activate(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['Mutation'],
  ): Promise<SchemaTypes['Config']> {
    return this.change(ctx, id, value, false);
  }
  /** Operator command only: the frozen HTTP contract has no revoke resource. */
  async revoke(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['Mutation'],
  ): Promise<SchemaTypes['Config']> {
    return this.change(ctx, id, value, true);
  }
  private async change(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['Mutation'],
    revoke: boolean,
  ): Promise<SchemaTypes['Config']> {
    const input = governanceInput<SchemaTypes['Mutation']>('Mutation', value),
      identity = { ...ctx },
      route = `${revoke ? 'revoke' : 'activate'}Config:${id}`,
      hash = sha256(canonicalJson(input));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const initial = await this.row(client, identity, id, 'config:manage');
      const head = await this.head(client, identity, initial.scope_id);
      const row = await this.row(client, identity, id, 'config:manage');
      const previous = await operation(client, identity, input.operation_id, route, hash);
      if (previous) {
        if (row.status === 'revoked') return this.view(row, 'revoked');
        await this.rules(client, identity, row.scope_id, row.body);
        return previous.response as SchemaTypes['Config'];
      }
      if (row.revision !== String(input.expected_revision)) stale('Configuration version changed');
      if (row.status === 'revoked')
        blocked('A revoked configuration ID cannot be activated or reused');
      if (!revoke) {
        if (row.status !== 'draft') stale('Configuration is already active');
        if (row.base_generation === null || row.base_generation !== head.generation)
          stale('Configuration activation base changed; create a new draft');
        await this.rules(client, identity, row.scope_id, row.body);
        const active = (
          await client.query<ConfigRow>(
            "SELECT * FROM akb.configs WHERE tenant_id=$1 AND scope_id=$2 AND status='active'",
            [identity.tenantId, row.scope_id],
          )
        ).rows[0];
        if (active) {
          await client.query(
            "UPDATE akb.configs SET status='revoked' WHERE tenant_id=$1 AND id=$2",
            [identity.tenantId, active.id],
          );
          await this.event(
            client,
            identity,
            active,
            input.operation_id,
            'superseded',
            input.reason,
          );
        }
      }
      await assertCapability(client, identity, row.scope_id, 'config:manage');
      await client.query('UPDATE akb.configs SET status=$3 WHERE tenant_id=$1 AND id=$2', [
        identity.tenantId,
        id,
        revoke ? 'revoked' : 'active',
      ]);
      if (!revoke || row.status === 'active')
        await client.query(
          'UPDATE akb.config_heads SET generation=generation+1 WHERE tenant_id=$1 AND scope_id=$2',
          [identity.tenantId, row.scope_id],
        );
      row.status = revoke ? 'revoked' : 'active';
      await this.event(
        client,
        identity,
        row,
        input.operation_id,
        revoke ? 'revoked' : 'activated',
        input.reason,
      );
      const result = this.view(row, revoke ? 'revoked' : 'updated');
      await finish(client, identity, input.operation_id, route, hash, result);
      return result;
    });
  }

  async get(
    ctx: PrincipalContext,
    query: { repo_id: string; client_version: string; current_config_version?: number },
  ): Promise<SchemaTypes['Config']> {
    const identity = { ...ctx };
    if (
      query.current_config_version !== undefined &&
      (!Number.isSafeInteger(query.current_config_version) || query.current_config_version < 1)
    )
      invalidInput('Invalid current configuration version');
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const scope = await this.repoScope(client, identity, query.repo_id, 'config:read');
      const row = (
        await client.query<ConfigRow>(
          "SELECT * FROM akb.configs WHERE tenant_id=$1 AND scope_id=$2 AND status IN ('active','revoked') ORDER BY (status='active') DESC,revision DESC LIMIT 1",
          [identity.tenantId, scope],
        )
      ).rows[0];
      if (!row)
        throw new ContributionError(
          'TEMPORARILY_UNAVAILABLE',
          503,
          'No effective configuration is published',
        );
      if (row.status !== 'revoked') await this.rules(client, identity, scope, row.body);
      // File I/O can run concurrently; only the final status check and quota commit serialize.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${identity.tenantId}:config:${scope}`,
      ]);
      const latest = (
        await client.query<{ id: string; status: string }>(
          "SELECT id,status FROM akb.configs WHERE tenant_id=$1 AND scope_id=$2 AND status IN ('active','revoked') ORDER BY (status='active') DESC,revision DESC LIMIT 1",
          [identity.tenantId, scope],
        )
      ).rows[0];
      if (latest?.id !== row.id || latest.status !== row.status)
        throw new ContributionError(
          'TEMPORARILY_UNAVAILABLE',
          503,
          'Configuration changed during resolution; retry the read',
        );
      await assertCapability(client, identity, scope, 'config:read');
      const count = (
        await client.query<{ reads: number }>(
          `INSERT INTO akb.config_windows(tenant_id,actor_id,window_start,reads) VALUES($1,$2,date_trunc('hour',now()),1) ON CONFLICT(tenant_id,actor_id,window_start) DO UPDATE SET reads=akb.config_windows.reads+1 RETURNING reads`,
          [identity.tenantId, identity.actorId],
        )
      ).rows[0]!.reads;
      if (count > 60)
        throw new ContributionError('RATE_LIMITED', 429, 'Configuration read quota exhausted');
      return this.view(
        row,
        row.status === 'revoked'
          ? 'revoked'
          : !compatibleHost(query.client_version, row.body.min_host_version)
            ? 'incompatible'
            : query.current_config_version === Number(row.revision)
              ? 'unchanged'
              : 'updated',
      );
    });
  }

  async list(
    ctx: PrincipalContext,
    query: { scope_id?: string; cursor?: string; limit?: number },
  ): Promise<SchemaTypes['ConfigPage']> {
    const identity = { ...ctx },
      limit = query.limit ?? 20,
      filter = { endpoint: 'config-versions', scope: query.scope_id ?? null };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalidInput('Invalid page limit');
    const position = query.cursor ? this.cursors.decode(identity, filter, query.cursor) : undefined;
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const allowed = await allowedScopesInTransaction(client, identity, 'config:manage');
      if (query.scope_id && !allowed.has(query.scope_id)) throw new AccessDeniedError();
      const rows = (
        await client.query<ConfigRow>(
          `WITH allowed AS (${allowedScopesSql}) SELECT c.* FROM akb.configs c JOIN allowed a ON a.id=c.scope_id WHERE c.tenant_id=$1 AND ($5::uuid IS NULL OR c.scope_id=$5) AND ($6::timestamptz IS NULL OR (c.created_at,c.id)<($6,$7::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT $8`,
          [
            identity.tenantId,
            identity.actorId,
            identity.authzVersion,
            'config:manage',
            query.scope_id ?? null,
            position?.date ?? null,
            position?.id ?? null,
            limit + 1,
          ],
        )
      ).rows;
      const page = rows.slice(0, limit);
      for (const row of page) {
        if (row.status !== 'revoked') await this.rules(client, identity, row.scope_id, row.body);
        await assertCapability(client, identity, row.scope_id, 'config:manage');
      }
      for (const row of page) {
        const latest = await this.row(client, identity, row.id, 'config:manage');
        row.status = latest.status;
        if (row.status !== 'revoked')
          await assertCapability(client, identity, row.scope_id, 'config:read');
      }
      const last = page.at(-1);
      return {
        items: page.map((row) => this.view(row)),
        next_cursor:
          rows.length > limit && last
            ? this.cursors.encode(identity, filter, {
                rank: 0,
                date: last.created_at.toISOString(),
                id: last.id,
              })
            : '',
      };
    });
  }

  private view(row: ConfigRow, outcome?: SchemaTypes['Config']['outcome']): SchemaTypes['Config'] {
    assertSchema('ConfigBody', row.body);
    if (sha256(canonicalJson(row.body)) !== row.sha256)
      throw new Error('Configuration integrity mismatch');
    // A revoked response is an inert tombstone, never a fallback copy of withdrawn rules.
    const body =
      row.status === 'revoked'
        ? {
            ...row.body,
            gateway_text: 'Configuration revoked. Stop using this managed version.',
            mandatory_rules: [],
          }
        : row.body;
    const result = {
      id: row.id,
      revision: Number(row.revision),
      body,
      sha256: sha256(canonicalJson(body)),
      status: row.status,
      outcome: outcome ?? (row.status === 'revoked' ? 'revoked' : 'updated'),
    };
    assertSchema('Config', result);
    return result;
  }
  private async repoScope(
    client: TransactionClient,
    ctx: PrincipalContext,
    repo: string,
    capability: string,
  ): Promise<string> {
    const row = (
      await client.query<{ id: string }>(
        "SELECT id FROM akb.scopes WHERE tenant_id=$1 AND repo_id=$2 AND kind='repo'",
        [ctx.tenantId, repo],
      )
    ).rows[0];
    if (!row) throw new AccessDeniedError();
    await assertCapability(client, ctx, row.id, capability);
    return row.id;
  }
  private async row(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
    capability: string,
  ): Promise<ConfigRow> {
    const row = (
      await client.query<ConfigRow>('SELECT * FROM akb.configs WHERE tenant_id=$1 AND id=$2', [
        ctx.tenantId,
        id,
      ])
    ).rows[0];
    if (!row) throw new AccessDeniedError();
    await assertCapability(client, ctx, row.scope_id, capability);
    return row;
  }
  private async head(client: TransactionClient, ctx: PrincipalContext, scope: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${ctx.tenantId}:config:${scope}`,
    ]);
    await client.query(
      'INSERT INTO akb.config_heads(tenant_id,scope_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [ctx.tenantId, scope],
    );
    return (
      await client.query<{ generation: string; next_revision: string }>(
        'SELECT generation,next_revision FROM akb.config_heads WHERE tenant_id=$1 AND scope_id=$2 FOR UPDATE',
        [ctx.tenantId, scope],
      )
    ).rows[0]!;
  }
  private async event(
    client: TransactionClient,
    ctx: PrincipalContext,
    row: ConfigRow,
    op: string,
    action: string,
    reason: string,
  ) {
    await client.query(
      'INSERT INTO akb.config_events(tenant_id,id,config_id,config_revision,actor_id,operation_id,action,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [ctx.tenantId, randomUUID(), row.id, row.revision, ctx.actorId, op, action, reason],
    );
    await client.query(
      'INSERT INTO akb.audit(tenant_id,id,actor_id,action,object_id,object_revision,reason,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        ctx.tenantId,
        randomUUID(),
        ctx.actorId,
        `config.${action}`,
        row.id,
        row.revision,
        reason,
        op,
      ],
    );
  }
  private async rules(
    client: TransactionClient,
    ctx: PrincipalContext,
    scope: string,
    body: SchemaTypes['ConfigBody'],
  ) {
    assertSchema('ConfigBody', body);
    const actual = await this.repoScope(client, ctx, body.repo_id, 'config:read');
    if (actual !== scope) throw new AccessDeniedError();
    const resolved: {
      id: string;
      revision: number;
      scope: string;
      refs: SchemaTypes['EvidenceRef'][];
    }[] = [];
    for (const rule of body.mandatory_rules) {
      const target = (
        await client.query<{
          scope_id: string;
          active_content_revision: string;
          publication_status: string;
          serving_status: string;
          content_ref: string;
          content_hash: string;
        }>(
          `SELECT k.scope_id,k.active_content_revision,k.publication_status,k.serving_status,r.content_ref,r.content_hash FROM akb.knowledge_entries k JOIN akb.knowledge_revisions r ON r.tenant_id=k.tenant_id AND r.knowledge_id=k.id AND r.revision=$3 WHERE k.tenant_id=$1 AND k.id=$2`,
          [ctx.tenantId, rule.knowledge_id, rule.revision],
        )
      ).rows[0];
      if (!target) throw new AccessDeniedError();
      await assertCapability(client, ctx, target.scope_id, 'knowledge:read');
      const applicable = (
        await client.query(
          `SELECT 1 FROM akb.scopes source JOIN akb.repos repo ON repo.tenant_id=source.tenant_id AND repo.id=$3 WHERE source.tenant_id=$1 AND source.id=$2 AND (source.id=$4 OR source.kind='team' OR (source.kind='domain' AND source.domain_id=repo.domain_id))`,
          [ctx.tenantId, target.scope_id, body.repo_id, scope],
        )
      ).rowCount;
      if (
        !applicable ||
        target.publication_status !== 'published' ||
        target.serving_status !== 'enabled' ||
        target.active_content_revision !== String(rule.revision)
      )
        blocked('Mandatory rule is unavailable or outside the repository scope');
      const snapshot = JSON.parse(
        await this.content.read(ctx.tenantId, target.content_ref, target.content_hash),
      ) as RuleSnapshot;
      assertSchema('CandidateBody', snapshot.body);
      if (
        snapshot.body.scope.id !== target.scope_id ||
        !Array.isArray(snapshot.source_refs) ||
        !snapshot.source_refs.length
      )
        blocked('Mandatory rule has no valid publication provenance');
      if (rule.text !== mandatoryRuleText(snapshot.body))
        blocked('Mandatory rule text must preserve the exact published rule and its conditions');
      const metadata = await evidenceMetadata(client, ctx, snapshot.source_refs);
      if (metadata.some((e) => e.evidence_kind !== 'retained'))
        blocked('Mandatory rules require retained proof');
      await checkEvidenceFiles(this.evidence, ctx, metadata);
      await assertCapability(client, ctx, target.scope_id, 'knowledge:read');
      await evidenceMetadata(client, ctx, snapshot.source_refs);
      const latest = (
        await client.query(
          "SELECT 1 FROM akb.knowledge_entries WHERE tenant_id=$1 AND id=$2 AND active_content_revision=$3 AND publication_status='published' AND serving_status='enabled'",
          [ctx.tenantId, rule.knowledge_id, rule.revision],
        )
      ).rowCount;
      if (latest !== 1) blocked('Mandatory rule changed during configuration resolution');
      resolved.push({
        id: rule.knowledge_id,
        revision: rule.revision,
        scope: target.scope_id,
        refs: snapshot.source_refs,
      });
    }
    // Later file reads can revoke an earlier rule's grants; recheck the entire bundle.
    for (const rule of resolved) {
      await assertCapability(client, ctx, rule.scope, 'knowledge:read');
      await evidenceMetadata(client, ctx, rule.refs);
      if (
        (
          await client.query(
            "SELECT 1 FROM akb.knowledge_entries WHERE tenant_id=$1 AND id=$2 AND active_content_revision=$3 AND publication_status='published' AND serving_status='enabled'",
            [ctx.tenantId, rule.id, rule.revision],
          )
        ).rowCount !== 1
      )
        blocked('Mandatory rule changed during configuration resolution');
    }
    await assertCapability(client, ctx, scope, 'config:read');
  }
}
