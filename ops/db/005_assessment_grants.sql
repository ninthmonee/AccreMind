-- Additive owner provisioning for B05; no approval/publication/token permissions.
BEGIN;
GRANT SELECT ON akb.baseline_materials TO akb_api;
GRANT SELECT,INSERT ON akb.assessments,akb.assessment_claims,akb.claim_evidence,akb.navigation_items TO akb_api;
GRANT UPDATE ON akb.candidates,akb.contributions,akb.jobs TO akb_api;
COMMIT;
