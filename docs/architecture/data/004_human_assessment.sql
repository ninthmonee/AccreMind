-- B05 additive migration: append-only checks, immutable registered baseline materials.
BEGIN;
ALTER TABLE akb.assessments ADD COLUMN evidence_set_hash text NOT NULL DEFAULT repeat('0',64)
 CHECK(evidence_set_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE akb.navigation_items ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE akb.baseline_materials (
 tenant_id uuid NOT NULL, id uuid NOT NULL, repo_id uuid NOT NULL,
 source_ref text NOT NULL, source_revision text NOT NULL, locator text NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 material_kind text NOT NULL CHECK(material_kind IN ('code','test','authoritative_doc','history')),
 evidence_id uuid NOT NULL, evidence_revision bigint NOT NULL CHECK(evidence_revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,repo_id,source_ref,source_revision,locator,content_hash,material_kind),
 FOREIGN KEY(tenant_id,repo_id) REFERENCES akb.repos(tenant_id,id),
 FOREIGN KEY(tenant_id,evidence_id,evidence_revision) REFERENCES akb.evidence(tenant_id,id,revision)
);
ALTER TABLE akb.baseline_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE akb.baseline_materials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON akb.baseline_materials
 USING(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid);
CREATE INDEX assessment_current ON akb.assessments(tenant_id,candidate_id,candidate_revision,revision DESC);
CREATE INDEX navigation_assessment ON akb.navigation_items(tenant_id,assessment_id,assessment_revision);
COMMIT;
