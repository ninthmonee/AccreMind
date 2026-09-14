-- Explicit local development role upgrade; no identity-token or history mutation access.
BEGIN;
GRANT SELECT,INSERT,UPDATE ON akb.read_windows TO akb_api;
GRANT SELECT,INSERT ON akb.retrieval_costs TO akb_api;
GRANT SELECT ON akb.search_documents TO akb_api;
GRANT UPDATE ON akb.tasks,akb.operations TO akb_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON akb.search_documents TO akb_worker;
GRANT SELECT,INSERT ON akb.jobs TO akb_worker;
GRANT SELECT,UPDATE ON akb.outbox TO akb_worker;
GRANT INSERT ON akb.jobs TO akb_api;
COMMIT;
