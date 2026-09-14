-- B08 additive event identity, independent proof and immutable human review history.
BEGIN;
ALTER TABLE akb.usage_events ADD COLUMN payload_hash text;
ALTER TABLE akb.feedback ADD COLUMN event_id uuid;
ALTER TABLE akb.feedback ADD COLUMN payload_hash text;
CREATE UNIQUE INDEX feedback_event_identity ON akb.feedback(tenant_id,actor_id,event_id) WHERE event_id IS NOT NULL;
ALTER TABLE akb.validations ADD COLUMN event_id uuid;
ALTER TABLE akb.validations ADD COLUMN request_hash text;
ALTER TABLE akb.validations ADD COLUMN proof_fingerprint text;
ALTER TABLE akb.validations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX validation_event_identity ON akb.validations(tenant_id,submitter_id,event_id) WHERE event_id IS NOT NULL;
CREATE TABLE akb.validation_reviews (
 tenant_id uuid NOT NULL, id uuid NOT NULL, validation_id uuid NOT NULL, validation_revision bigint NOT NULL,
 operation_id uuid NOT NULL, submitter_id uuid NOT NULL, reviewer_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('accept','reject')), reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,operation_id),
 UNIQUE(tenant_id,validation_id,validation_revision),
 CHECK(submitter_id<>reviewer_id),
 FOREIGN KEY(tenant_id,validation_id) REFERENCES akb.validations(tenant_id,id),
 FOREIGN KEY(tenant_id,submitter_id) REFERENCES akb.principals(tenant_id,id),
 FOREIGN KEY(tenant_id,reviewer_id) REFERENCES akb.principals(tenant_id,id)
);
ALTER TABLE akb.validation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE akb.validation_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON akb.validation_reviews USING(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid);
COMMIT;
