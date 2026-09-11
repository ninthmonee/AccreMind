-- Identity boundary before tenant is known. No model/worker access.
BEGIN;
CREATE SCHEMA akb_identity;
CREATE TABLE akb_identity.login_tickets (
 id uuid PRIMARY KEY, challenge_sha256 text NOT NULL, state_hash text NOT NULL,
 client_name text NOT NULL, status text NOT NULL CHECK(status IN ('pending','approved','denied','expired','consumed')),
 tenant_id uuid, principal_id uuid, expires_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES akb.principals(tenant_id,id),
 CHECK((tenant_id IS NULL)=(principal_id IS NULL))
);
CREATE TABLE akb_identity.sessions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, refresh_hash text UNIQUE, kind text NOT NULL CHECK(kind IN ('web','tool')),
 expires_at timestamptz NOT NULL, refresh_expires_at timestamptz, revoked_at timestamptz,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES akb.principals(tenant_id,id)
);
COMMIT;
