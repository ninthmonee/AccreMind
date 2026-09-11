-- AccreMind PRD V2.1; design migration 001, PostgreSQL 17.
-- Run as migration owner in an empty database. Runtime roles must not own tables
-- and must have NOBYPASSRLS. Provision roles/grants separately per B11.
BEGIN;
CREATE SCHEMA akb;
SET search_path = akb, public;

CREATE TABLE tenants (
 id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE principals (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
 oidc_issuer text NOT NULL, oidc_subject text NOT NULL,
 display_name text NOT NULL, active boolean NOT NULL DEFAULT true,
 authz_version bigint NOT NULL DEFAULT 1 CHECK(authz_version>0),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,oidc_issuer,oidc_subject)
);
CREATE TABLE domains (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
 name text NOT NULL, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE repos (
 tenant_id uuid NOT NULL, id uuid NOT NULL, domain_id uuid NOT NULL,
 name text NOT NULL, canonical_remote text NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,canonical_remote),
 FOREIGN KEY(tenant_id,domain_id) REFERENCES domains(tenant_id,id)
);
CREATE TABLE scopes (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('team','domain','repo')),
 domain_id uuid, repo_id uuid, PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,domain_id) REFERENCES domains(tenant_id,id),
 FOREIGN KEY(tenant_id,repo_id) REFERENCES repos(tenant_id,id),
 CHECK ((kind='team' AND domain_id IS NULL AND repo_id IS NULL)
 OR (kind='domain' AND domain_id IS NOT NULL AND repo_id IS NULL)
 OR (kind='repo' AND repo_id IS NOT NULL AND domain_id IS NULL))
);
CREATE UNIQUE INDEX one_team_scope ON scopes(tenant_id) WHERE kind='team';
CREATE UNIQUE INDEX one_domain_scope ON scopes(tenant_id,domain_id) WHERE kind='domain';
CREATE UNIQUE INDEX one_repo_scope ON scopes(tenant_id,repo_id) WHERE kind='repo';
CREATE TABLE grants (
 tenant_id uuid NOT NULL, id uuid NOT NULL, principal_id uuid NOT NULL,
 scope_id uuid NOT NULL, capability text NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id)
);
CREATE UNIQUE INDEX live_grant ON grants(tenant_id,principal_id,scope_id,capability) WHERE revoked_at IS NULL;
CREATE TABLE tasks (
 tenant_id uuid NOT NULL, id uuid NOT NULL, principal_id uuid NOT NULL, repo_id uuid NOT NULL,
 client_session_id text NOT NULL, limit_reads integer NOT NULL DEFAULT 3 CHECK(limit_reads BETWEEN 1 AND 20),
 used_reads integer NOT NULL DEFAULT 0 CHECK(used_reads>=0),
 reserved_reads integer NOT NULL DEFAULT 0 CHECK(reserved_reads>=0), expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id), CHECK(used_reads+reserved_reads<=limit_reads),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,repo_id) REFERENCES repos(tenant_id,id)
);
CREATE INDEX task_session ON tasks(tenant_id,principal_id,repo_id,client_session_id);
CREATE TABLE contributions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, actor_id uuid NOT NULL, repo_id uuid NOT NULL, task_id uuid NOT NULL,
 idempotency_key uuid NOT NULL, payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 processing_status text NOT NULL CHECK(processing_status IN ('accepted','processing','waiting_review','waiting_confirmation','completed','failed')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,repo_id) REFERENCES repos(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id)
);
CREATE TABLE source_events (
 tenant_id uuid NOT NULL, id uuid NOT NULL, contribution_id uuid NOT NULL,
 source text NOT NULL, external_event_id uuid NOT NULL, content_hash text NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,source,external_event_id),
 FOREIGN KEY(tenant_id,contribution_id) REFERENCES contributions(tenant_id,id)
);
CREATE TABLE evidence (
 tenant_id uuid NOT NULL, id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0), scope_id uuid NOT NULL,
 contribution_id uuid, source_ref text NOT NULL, source_revision text NOT NULL, locator text NOT NULL,
 object_key text NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 evidence_kind text NOT NULL CHECK(evidence_kind IN ('raw','retained')),
 status text NOT NULL CHECK(status IN ('available','quarantined','expired','deleted')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id,revision),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,contribution_id) REFERENCES contributions(tenant_id,id)
);
CREATE INDEX evidence_expiry ON evidence(expires_at) WHERE status='available';
CREATE TABLE candidates (
 tenant_id uuid NOT NULL, id uuid NOT NULL, contribution_id uuid NOT NULL,
 contributor_id uuid NOT NULL, scope_id uuid NOT NULL, owner_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 publication_status text NOT NULL DEFAULT 'candidate' CHECK(publication_status IN ('candidate','in_review','published','rejected','withdrawn','archived')),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 knowledge_role text NOT NULL CHECK(knowledge_role IN ('experience','authoritative_mirror')),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,contribution_id) REFERENCES contributions(tenant_id,id),
 FOREIGN KEY(tenant_id,contributor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id)
);
CREATE TABLE candidate_revisions (
 tenant_id uuid NOT NULL, candidate_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 body jsonb NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,candidate_id,revision),
 FOREIGN KEY(tenant_id,candidate_id) REFERENCES candidates(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE assessments (
 tenant_id uuid NOT NULL, id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 candidate_id uuid NOT NULL, candidate_revision bigint NOT NULL,
 checked_by uuid NOT NULL, assessment_method text NOT NULL CHECK(assessment_method IN ('human_review','isolated_check')),
 discoverability text NOT NULL CHECK(discoverability IN ('code_recoverable','authoritative_source','missing_context','inconclusive')),
 disposition text NOT NULL CHECK(disposition IN ('index_only','link_existing','knowledge_candidate','needs_confirmation','discard')),
 priority text NOT NULL CHECK(priority IN ('P0','P1','P2')),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id,revision),
 UNIQUE(tenant_id,candidate_id,candidate_revision,id,revision),
 FOREIGN KEY(tenant_id,candidate_id,candidate_revision) REFERENCES candidate_revisions(tenant_id,candidate_id,revision),
 FOREIGN KEY(tenant_id,checked_by) REFERENCES principals(tenant_id,id),
 CHECK(discoverability<>'inconclusive' OR disposition IN ('needs_confirmation','discard'))
);
CREATE TABLE assessment_claims (
 tenant_id uuid NOT NULL, assessment_id uuid NOT NULL, assessment_revision bigint NOT NULL,
 claim_id uuid NOT NULL, text text NOT NULL,
 support text NOT NULL CHECK(support IN ('observed','confirmed_decision','inference','unconfirmed')),
 PRIMARY KEY(tenant_id,assessment_id,assessment_revision,claim_id),
 FOREIGN KEY(tenant_id,assessment_id,assessment_revision) REFERENCES assessments(tenant_id,id,revision)
);
CREATE TABLE claim_evidence (
 tenant_id uuid NOT NULL, assessment_id uuid NOT NULL, assessment_revision bigint NOT NULL,
 claim_id uuid NOT NULL, evidence_id uuid NOT NULL, evidence_revision bigint NOT NULL, locator text NOT NULL,
 PRIMARY KEY(tenant_id,assessment_id,assessment_revision,claim_id,evidence_id,evidence_revision),
 FOREIGN KEY(tenant_id,assessment_id,assessment_revision,claim_id) REFERENCES assessment_claims(tenant_id,assessment_id,assessment_revision,claim_id),
 FOREIGN KEY(tenant_id,evidence_id,evidence_revision) REFERENCES evidence(tenant_id,id,revision)
);
CREATE TABLE reviews (
 tenant_id uuid NOT NULL, id uuid NOT NULL, candidate_id uuid NOT NULL, candidate_revision bigint NOT NULL,
 assessment_id uuid NOT NULL, assessment_revision bigint NOT NULL, reviewer_id uuid NOT NULL,
 evidence_set_hash text NOT NULL CHECK(evidence_set_hash ~ '^[a-f0-9]{64}$'), scope_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('approve','return','reject','route')),
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,candidate_id,candidate_revision) REFERENCES candidate_revisions(tenant_id,candidate_id,revision),
 FOREIGN KEY(tenant_id,assessment_id,assessment_revision) REFERENCES assessments(tenant_id,id,revision),
 FOREIGN KEY(tenant_id,reviewer_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id)
);
CREATE TABLE knowledge_entries (
 tenant_id uuid NOT NULL, id uuid NOT NULL, scope_id uuid NOT NULL, owner_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), active_content_revision bigint,
 publication_status text NOT NULL CHECK(publication_status IN ('candidate','in_review','published','rejected','withdrawn','archived')),
 maturity text NOT NULL DEFAULT 'draft' CHECK(maturity IN ('draft','verified','proven')),
 freshness text NOT NULL DEFAULT 'unknown' CHECK(freshness IN ('current','review_due','stale','unknown')),
 serving_status text NOT NULL DEFAULT 'enabled' CHECK(serving_status IN ('enabled','suspended')),
 review_due_at timestamptz, critical boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES principals(tenant_id,id),
 CHECK(publication_status<>'published' OR active_content_revision IS NOT NULL)
);
CREATE TABLE knowledge_revisions (
 tenant_id uuid NOT NULL, knowledge_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 candidate_id uuid NOT NULL, candidate_revision bigint NOT NULL, review_id uuid NOT NULL,
 content_ref text NOT NULL, content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,knowledge_id,revision),
 FOREIGN KEY(tenant_id,knowledge_id) REFERENCES knowledge_entries(tenant_id,id),
 FOREIGN KEY(tenant_id,candidate_id,candidate_revision) REFERENCES candidate_revisions(tenant_id,candidate_id,revision),
 FOREIGN KEY(tenant_id,review_id) REFERENCES reviews(tenant_id,id)
);
ALTER TABLE knowledge_entries ADD CONSTRAINT active_revision_fk
 FOREIGN KEY(tenant_id,id,active_content_revision) REFERENCES knowledge_revisions(tenant_id,knowledge_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE publications (
 tenant_id uuid NOT NULL, id uuid NOT NULL, candidate_id uuid NOT NULL, candidate_revision bigint NOT NULL,
 operation_id uuid NOT NULL, actor_id uuid NOT NULL, review_id uuid NOT NULL,
 knowledge_id uuid, status text NOT NULL CHECK(status IN ('pending','published','failed')),
 content_ref text, index_status text NOT NULL DEFAULT 'pending' CHECK(index_status IN ('pending','ready','failed')),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,candidate_id,candidate_revision) REFERENCES candidate_revisions(tenant_id,candidate_id,revision),
 FOREIGN KEY(tenant_id,review_id) REFERENCES reviews(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,knowledge_id) REFERENCES knowledge_entries(tenant_id,id)
);
CREATE UNIQUE INDEX one_publication_per_candidate_revision ON publications(tenant_id,candidate_id,candidate_revision) WHERE status IN ('pending','published');
CREATE TABLE navigation_items (
 tenant_id uuid NOT NULL, id uuid NOT NULL, scope_id uuid NOT NULL,
 assessment_id uuid NOT NULL, assessment_revision bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('index_only','link_existing')), source_ref text NOT NULL, source_revision text NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,assessment_id,assessment_revision) REFERENCES assessments(tenant_id,id,revision)
);
CREATE TABLE usage_events (
 tenant_id uuid NOT NULL, id uuid NOT NULL, event_id uuid NOT NULL, actor_id uuid NOT NULL, task_id uuid NOT NULL,
 knowledge_id uuid NOT NULL, knowledge_revision bigint NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('retrieved','cited','applied','validation_submitted','validation_accepted')),
 used_in text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,actor_id,event_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,knowledge_id,knowledge_revision) REFERENCES knowledge_revisions(tenant_id,knowledge_id,revision)
);
CREATE TABLE validations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 submitter_id uuid NOT NULL, reviewer_id uuid, task_id uuid NOT NULL, knowledge_id uuid NOT NULL, knowledge_revision bigint NOT NULL,
 evidence_method_hash text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('success','failure','inconclusive')),
 review_status text NOT NULL CHECK(review_status IN ('pending','accepted','rejected')), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,task_id,knowledge_id,knowledge_revision,evidence_method_hash),
 CHECK(reviewer_id IS NULL OR reviewer_id<>submitter_id),
 CHECK(review_status='pending' OR reviewer_id IS NOT NULL),
 FOREIGN KEY(tenant_id,submitter_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,reviewer_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,knowledge_id,knowledge_revision) REFERENCES knowledge_revisions(tenant_id,knowledge_id,revision)
);
CREATE TABLE feedback (
 tenant_id uuid NOT NULL, id uuid NOT NULL, actor_id uuid NOT NULL, knowledge_id uuid NOT NULL, knowledge_revision bigint NOT NULL,
 category text NOT NULL, description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,knowledge_id,knowledge_revision) REFERENCES knowledge_revisions(tenant_id,knowledge_id,revision)
);
CREATE TABLE jobs (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, actor_id uuid NOT NULL,
 scope_id uuid NOT NULL, kind text NOT NULL, dedupe_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 payload jsonb NOT NULL, checkpoint jsonb NOT NULL DEFAULT '{}',
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), generation bigint NOT NULL DEFAULT 0,
 lease_owner text, lease_until timestamptz, next_run_at timestamptz NOT NULL DEFAULT now(),
 last_error_code text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,kind,dedupe_key),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id)
);
CREATE INDEX claim_job ON jobs(tenant_id,next_run_at,created_at) WHERE status='queued';
CREATE INDEX expired_lease ON jobs(tenant_id,lease_until) WHERE status='running';
CREATE TABLE outbox (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, event_key text NOT NULL,
 event_type text NOT NULL, aggregate_id uuid NOT NULL, aggregate_revision bigint NOT NULL,
 payload jsonb NOT NULL, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_key)
);
CREATE INDEX pending_outbox ON outbox(tenant_id,created_at) WHERE delivered_at IS NULL;
CREATE TABLE operations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, actor_id uuid NOT NULL, route text NOT NULL,
 payload_hash text NOT NULL, status text NOT NULL CHECK(status IN ('pending','completed','failed')),
 result_ref text, error_code text NOT NULL DEFAULT '', budget_task_id uuid,
 reserved_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,budget_task_id) REFERENCES tasks(tenant_id,id)
);
CREATE TABLE search_documents (
 tenant_id uuid NOT NULL, knowledge_id uuid NOT NULL, knowledge_revision bigint NOT NULL,
 scope_id uuid NOT NULL, title text NOT NULL, segmented_text text NOT NULL, lexemes tsvector NOT NULL,
 index_version text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,knowledge_id),
 FOREIGN KEY(tenant_id,knowledge_id,knowledge_revision) REFERENCES knowledge_revisions(tenant_id,knowledge_id,revision),
 FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id)
);
CREATE INDEX search_lexemes ON search_documents USING gin(lexemes);
CREATE TABLE configs (
 tenant_id uuid NOT NULL, id uuid NOT NULL, scope_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 status text NOT NULL CHECK(status IN ('draft','active','revoked')), body jsonb NOT NULL,
 sha256 text NOT NULL, publisher_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,publisher_id) REFERENCES principals(tenant_id,id)
);
CREATE UNIQUE INDEX one_active_config ON configs(tenant_id,scope_id) WHERE status='active';
CREATE TABLE governance_requests (
 tenant_id uuid NOT NULL, id uuid NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 scope_id uuid NOT NULL, actor_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('conflict','scope_change','deletion')),
 status text NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE audit (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, object_id uuid NOT NULL, object_revision bigint, reason text NOT NULL,
 request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE notifications (
 tenant_id uuid NOT NULL, id uuid NOT NULL, principal_id uuid NOT NULL, knowledge_id uuid NOT NULL,
 knowledge_revision bigint NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,knowledge_id,knowledge_revision) REFERENCES knowledge_revisions(tenant_id,knowledge_id,revision)
);
CREATE TABLE metric_observations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, scope_id uuid NOT NULL, task_id uuid,
 name text NOT NULL, numerator numeric NOT NULL, denominator numeric NOT NULL,
 sample_size integer NOT NULL CHECK(sample_size>=0), metadata jsonb NOT NULL DEFAULT '{}', observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,scope_id) REFERENCES scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id)
);

-- Tenant isolation is defense in depth, not a replacement for content ACL.
-- Each request begins a transaction then SET LOCAL akb.tenant_id = authenticated tenant.
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='akb' AND tablename<>'tenants' LOOP
  EXECUTE format('ALTER TABLE akb.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE akb.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON akb.%I USING (tenant_id = nullif(current_setting(''akb.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''akb.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
COMMIT;
