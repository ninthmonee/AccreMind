-- Explicit additive provisioning for existing migrated synthetic dev databases.
-- Run as owner after migration 003; do not rerun CREATE ROLE or reset volumes.
BEGIN;
GRANT USAGE ON SCHEMA akb TO akb_api;
GRANT SELECT ON akb.principals,akb.scopes,akb.grants TO akb_api;
GRANT SELECT,INSERT ON akb.tasks,akb.contributions,akb.source_events,akb.contribution_evidence,
 akb.candidates,akb.candidate_revisions,akb.jobs,akb.outbox,akb.operations,akb.audit TO akb_api;
GRANT SELECT,INSERT ON akb.evidence TO akb_api;
GRANT SELECT ON akb.repos TO akb_api;
COMMIT;
