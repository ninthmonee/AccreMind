-- Explicit B09 role upgrade; never recreate roles or change content permissions.
BEGIN;
GRANT SELECT,INSERT ON akb.configs,akb.config_events TO akb_api;
GRANT UPDATE(status) ON akb.configs TO akb_api;
GRANT SELECT,INSERT,UPDATE ON akb.config_heads,akb.config_windows TO akb_api;
COMMIT;
