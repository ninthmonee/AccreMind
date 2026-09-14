-- B06 additive governance state; immutable evidence lineage and request/result recovery.
BEGIN;
CREATE TABLE akb.retained_evidence_sources (
 tenant_id uuid NOT NULL, evidence_id uuid NOT NULL, evidence_revision bigint NOT NULL,
 source_id uuid NOT NULL, source_revision bigint NOT NULL, locator text NOT NULL,
 PRIMARY KEY(tenant_id,evidence_id,evidence_revision),
 FOREIGN KEY(tenant_id,evidence_id,evidence_revision) REFERENCES akb.evidence(tenant_id,id,revision),
 FOREIGN KEY(tenant_id,source_id,source_revision) REFERENCES akb.evidence(tenant_id,id,revision)
);
ALTER TABLE akb.retained_evidence_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE akb.retained_evidence_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON akb.retained_evidence_sources
 USING (tenant_id = nullif(current_setting('akb.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = nullif(current_setting('akb.tenant_id',true),'')::uuid);
ALTER TABLE akb.reviews ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE akb.publications ADD COLUMN result jsonb NOT NULL DEFAULT '{}';
ALTER TABLE akb.publications ADD COLUMN authz_version bigint NOT NULL DEFAULT 1;
ALTER TABLE akb.publications ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE akb.operations ADD COLUMN response jsonb;
COMMIT;
