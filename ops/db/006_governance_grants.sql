-- Synthetic development provisioning, separate from immutable schema history.
BEGIN;
GRANT SELECT,INSERT ON akb.retained_evidence_sources,akb.reviews,akb.publications TO akb_api;
GRANT SELECT ON akb.knowledge_entries,akb.knowledge_revisions TO akb_api;
GRANT UPDATE ON akb.knowledge_entries TO akb_api;
GRANT SELECT ON akb.principals,akb.scopes,akb.grants,akb.repos,akb.evidence,
 akb.retained_evidence_sources,akb.baseline_materials,akb.candidates,akb.candidate_revisions,
 akb.assessments,akb.reviews,akb.publications,akb.contributions,akb.knowledge_entries,akb.knowledge_revisions TO akb_worker;
GRANT UPDATE ON akb.publications,akb.candidates,akb.contributions,akb.jobs TO akb_worker;
GRANT INSERT ON akb.knowledge_entries,akb.knowledge_revisions,akb.outbox,akb.audit TO akb_worker;
GRANT UPDATE ON akb.knowledge_entries TO akb_worker;
COMMIT;
