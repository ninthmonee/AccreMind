-- Synthetic local environment ONLY. Production provisioning is organization-owned.
BEGIN;
CREATE ROLE akb_api LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE akb_worker LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE akb_auth LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
DO $$ BEGIN
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO akb_api,akb_worker,akb_auth',current_database());
END $$;
GRANT USAGE ON SCHEMA akb TO akb_api,akb_worker,akb_auth;
-- Authorization reads; identity-token tables remain inaccessible to API.
GRANT SELECT ON akb.principals,akb.scopes,akb.grants,akb.repos,akb.evidence TO akb_api;
-- B03 receive-only writes. No approval, knowledge publication or token access.
GRANT SELECT,INSERT ON akb.tasks,akb.contributions,akb.source_events,akb.contribution_evidence,
 akb.candidates,akb.candidate_revisions,akb.jobs,akb.outbox,akb.operations,akb.audit TO akb_api;
GRANT INSERT ON akb.evidence TO akb_api;
-- B05 human checks: history and baseline registry remain immutable to runtime.
GRANT SELECT ON akb.baseline_materials TO akb_api;
GRANT SELECT,INSERT ON akb.assessments,akb.assessment_claims,akb.claim_evidence,akb.navigation_items TO akb_api;
GRANT UPDATE ON akb.candidates,akb.contributions,akb.jobs TO akb_api;
GRANT SELECT ON akb.jobs TO akb_worker;
GRANT SELECT ON akb.principals TO akb_auth;
GRANT USAGE ON SCHEMA akb_identity TO akb_auth;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA akb_identity TO akb_auth;

GRANT SELECT,INSERT ON akb.retained_evidence_sources,akb.reviews,akb.publications TO akb_api;
GRANT SELECT ON akb.knowledge_entries,akb.knowledge_revisions TO akb_api;
GRANT UPDATE ON akb.knowledge_entries TO akb_api;
GRANT SELECT ON akb.principals,akb.scopes,akb.grants,akb.repos,akb.evidence,
 akb.retained_evidence_sources,akb.baseline_materials,akb.candidates,akb.candidate_revisions,
 akb.assessments,akb.reviews,akb.publications,akb.contributions,akb.knowledge_entries,akb.knowledge_revisions TO akb_worker;
GRANT UPDATE ON akb.publications,akb.candidates,akb.contributions,akb.jobs TO akb_worker;
GRANT INSERT ON akb.knowledge_entries,akb.knowledge_revisions,akb.outbox,akb.audit TO akb_worker;
GRANT UPDATE ON akb.knowledge_entries TO akb_worker;

GRANT SELECT,INSERT,UPDATE ON akb.read_windows TO akb_api;
GRANT SELECT,INSERT ON akb.retrieval_costs TO akb_api;
GRANT SELECT ON akb.search_documents TO akb_api;
GRANT UPDATE ON akb.tasks,akb.operations TO akb_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON akb.search_documents TO akb_worker;
GRANT SELECT,INSERT ON akb.jobs TO akb_worker;
GRANT SELECT,UPDATE ON akb.outbox TO akb_worker;
GRANT INSERT ON akb.jobs TO akb_api;
GRANT SELECT,INSERT ON akb.usage_events,akb.feedback,akb.validations,akb.validation_reviews TO akb_api;
GRANT UPDATE(revision,reviewer_id,review_status) ON akb.validations TO akb_api;
GRANT UPDATE(maturity,freshness,last_validated_at,review_due_at) ON akb.knowledge_revisions TO akb_api;
GRANT SELECT,INSERT ON akb.configs,akb.config_events TO akb_api;
GRANT UPDATE(status) ON akb.configs TO akb_api;
GRANT SELECT,INSERT,UPDATE ON akb.config_heads,akb.config_windows TO akb_api;
COMMIT;
