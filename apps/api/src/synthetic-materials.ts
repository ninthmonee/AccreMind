import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import type { TransactionClient } from './database.js';
import type { EvidenceStore } from './evidence-store.js';
import { sha256 } from './evidence-store.js';

export const syntheticBaselineCommit = 'synthetic-baseline-v1';
const fixtures: [SchemaTypes['Material']['material_kind'], string, string][] = [
  ['code', 'synthetic:baseline/code', '合成代码：贡献接收返回 accepted 状态。'],
  ['test', 'synthetic:baseline/test', '合成测试：重复提交返回同一份贡献。'],
  ['authoritative_doc', 'synthetic:baseline/adr', '合成权威文档：接收、审核与发布是不同状态。'],
  [
    'history',
    'synthetic:baseline/history',
    '合成讨论记录：团队因独立审核要求保留人工判定，不自动发布。',
  ],
];
export const syntheticMaterials = fixtures.map(([kind, source, content], index) => ({
  evidenceId: `00000000-0000-4000-8000-00000000010${index}`,
  content,
  material: {
    source_ref: source,
    source_revision: syntheticBaselineCommit,
    locator: 'line:1',
    content_hash: sha256(content),
    material_kind: kind,
  } satisfies SchemaTypes['Material'],
}));

/** Synthetic owner fixture only. Runtime cannot register material kinds or authoritative sources. */
export async function seedSyntheticMaterials(
  client: TransactionClient,
  ctx: PrincipalContext,
  repo: string,
  scope: string,
  store: EvidenceStore,
) {
  for (const [index, fixture] of syntheticMaterials.entries()) {
    const material = fixture.material;
    let objectKey: string;
    try {
      objectKey = await store.write(ctx.tenantId, fixture.evidenceId, fixture.content);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      objectKey = `${ctx.tenantId}.${fixture.evidenceId}.1.${material.content_hash}`;
      await store.read(ctx.tenantId, objectKey, material.content_hash);
    }
    await client.query(
      `INSERT INTO akb.evidence(tenant_id,id,revision,scope_id,source_ref,source_revision,locator,object_key,sha256,evidence_kind,status,expires_at)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,'raw','available',now()+interval '30 days') ON CONFLICT DO NOTHING`,
      [
        ctx.tenantId,
        fixture.evidenceId,
        scope,
        material.source_ref,
        material.source_revision,
        material.locator,
        objectKey,
        material.content_hash,
      ],
    );
    const valid = await client.query(
      `SELECT id FROM akb.evidence WHERE tenant_id=$1 AND id=$2 AND revision=1 AND scope_id=$3 AND source_ref=$4
      AND source_revision=$5 AND locator=$6 AND object_key=$7 AND sha256=$8 AND status='available' AND expires_at>now()`,
      [
        ctx.tenantId,
        fixture.evidenceId,
        scope,
        material.source_ref,
        material.source_revision,
        material.locator,
        objectKey,
        material.content_hash,
      ],
    );
    if (valid.rowCount !== 1) throw new Error('Synthetic material identity conflict');
    await client.query(
      `INSERT INTO akb.baseline_materials(tenant_id,id,repo_id,source_ref,source_revision,locator,content_hash,material_kind,evidence_id,evidence_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1) ON CONFLICT DO NOTHING`,
      [
        ctx.tenantId,
        `00000000-0000-4000-8000-00000000011${index}`,
        repo,
        material.source_ref,
        material.source_revision,
        material.locator,
        material.content_hash,
        material.material_kind,
        fixture.evidenceId,
      ],
    );
  }
}
