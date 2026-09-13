-- Identity boundary before tenant is known. No model/worker access.
BEGIN;
CREATE SCHEMA akb_identity;
CREATE TABLE akb_identity.login_tickets (
 id uuid PRIMARY KEY, challenge_sha256 text NOT NULL CHECK(challenge_sha256 ~ '^[a-f0-9]{64}$'),
 state_hash text NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 client_name text NOT NULL, status text NOT NULL CHECK(status IN ('pending','approved','denied','expired','consumed')),
 tenant_id uuid, principal_id uuid, expires_at timestamptz NOT NULL,
 requested_capabilities jsonb NOT NULL CHECK(jsonb_typeof(requested_capabilities)='array'),
 decision_operation_id uuid UNIQUE, decision_payload_hash text CHECK(decision_payload_hash ~ '^[a-f0-9]{64}$'),
 decided_at timestamptz, consumed_at timestamptz,
 decision_oidc_issuer text, decision_oidc_subject text,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES akb.principals(tenant_id,id),
 CHECK((tenant_id IS NULL)=(principal_id IS NULL)),
 CHECK(status NOT IN ('approved','consumed') OR (tenant_id IS NOT NULL AND decided_at IS NOT NULL)),
 CHECK(status<>'consumed' OR consumed_at IS NOT NULL),
 CHECK(status NOT IN ('approved','denied','consumed') OR (decision_oidc_issuer IS NOT NULL AND decision_oidc_subject IS NOT NULL
 AND decided_at IS NOT NULL AND decision_operation_id IS NOT NULL AND decision_payload_hash IS NOT NULL))
);
CREATE TABLE akb_identity.sessions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), kind text NOT NULL CHECK(kind IN ('web','tool')),
 expires_at timestamptz NOT NULL, refresh_expires_at timestamptz, revoked_at timestamptz,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES akb.principals(tenant_id,id),
 CHECK(kind<>'tool' OR (refresh_expires_at IS NOT NULL AND refresh_expires_at>expires_at))
);
-- Tool sessions.id is the refresh-token family ID. Store all historical hashes;
-- replacing one current hash cannot implement family revocation on reuse.
CREATE TABLE akb_identity.refresh_tokens (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 session_id uuid NOT NULL REFERENCES akb_identity.sessions(id),
 status text NOT NULL CHECK(status IN ('active','consumed','revoked','expired')),
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, replaced_by_hash text,
 UNIQUE(session_id,token_hash),
 FOREIGN KEY(session_id,replaced_by_hash) REFERENCES akb_identity.refresh_tokens(session_id,token_hash) DEFERRABLE INITIALLY DEFERRED,
 CHECK(expires_at>issued_at),
 CHECK(status<>'consumed' OR (consumed_at IS NOT NULL AND replaced_by_hash IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_refresh_per_family ON akb_identity.refresh_tokens(session_id) WHERE status='active';
CREATE INDEX refresh_family_history ON akb_identity.refresh_tokens(session_id,expires_at);
COMMIT;
