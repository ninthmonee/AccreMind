-- Synthetic tenant-isolation exercise only; same-tenant content ACL is not implemented.
BEGIN;
INSERT INTO akb.tenants(id,name) VALUES
 ('00000000-0000-4000-8000-000000000101','synthetic team A'),
 ('00000000-0000-4000-8000-000000000102','synthetic team B');
INSERT INTO akb.principals(tenant_id,id,oidc_issuer,oidc_subject,display_name) VALUES
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','synthetic','A','synthetic A'),
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000202','synthetic','B','synthetic B');
SET LOCAL ROLE akb_api;
DO $$ BEGIN
 IF (SELECT count(*) FROM akb.principals)<>0 THEN RAISE EXCEPTION 'missing tenant context leaked principals'; END IF;
 IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'runtime role bypasses RLS'; END IF;
 IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname IN ('akb','akb_identity') AND tableowner=current_user) THEN RAISE EXCEPTION 'runtime role owns protected tables'; END IF;
END $$;
SELECT set_config('akb.tenant_id','00000000-0000-4000-8000-000000000101',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM akb.principals)<>1 THEN RAISE EXCEPTION 'tenant A not correctly isolated'; END IF;
 IF EXISTS(SELECT 1 FROM akb.principals WHERE tenant_id='00000000-0000-4000-8000-000000000102') THEN RAISE EXCEPTION 'tenant B visible in A context'; END IF;
 BEGIN
  PERFORM 1 FROM akb_identity.sessions;
  RAISE EXCEPTION 'API role unexpectedly reads authentication tokens';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE akb_worker;
DO $$ BEGIN
 BEGIN
  PERFORM 1 FROM akb_identity.refresh_tokens;
  RAISE EXCEPTION 'Worker unexpectedly reads refresh tokens';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
