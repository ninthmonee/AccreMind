-- Synthetic local environment ONLY. Production provisioning is organization-owned.
BEGIN;
CREATE ROLE akb_api LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE akb_worker LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE akb_auth LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
DO $$ BEGIN
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO akb_api,akb_worker,akb_auth',current_database());
END $$;
GRANT USAGE ON SCHEMA akb TO akb_api,akb_worker,akb_auth;
-- No business writes/grants before service and ACL implementations exist.
GRANT SELECT ON akb.principals,akb.scopes,akb.grants TO akb_api;
GRANT SELECT ON akb.jobs TO akb_worker;
GRANT SELECT ON akb.principals TO akb_auth;
GRANT USAGE ON SCHEMA akb_identity TO akb_auth;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA akb_identity TO akb_auth;
COMMIT;
