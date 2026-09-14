-- Explicit synthetic upgrade. No content rewrite, token access or review-history mutation.
BEGIN;
GRANT SELECT,INSERT ON akb.usage_events,akb.feedback,akb.validations,akb.validation_reviews TO akb_api;
GRANT UPDATE(revision,reviewer_id,review_status) ON akb.validations TO akb_api;
GRANT UPDATE(maturity,freshness,last_validated_at,review_due_at) ON akb.knowledge_revisions TO akb_api;
COMMIT;
