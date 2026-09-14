-- B09 immutable configuration versions, scoped activation generation and history.
BEGIN;
ALTER TABLE akb.configs ADD COLUMN base_generation bigint;
CREATE UNIQUE INDEX configuration_scope_version ON akb.configs(tenant_id,scope_id,revision);
CREATE TABLE akb.config_heads (
 tenant_id uuid NOT NULL, scope_id uuid NOT NULL, generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 next_revision bigint NOT NULL DEFAULT 1 CHECK(next_revision>0),
 PRIMARY KEY(tenant_id,scope_id), FOREIGN KEY(tenant_id,scope_id) REFERENCES akb.scopes(tenant_id,id)
);
INSERT INTO akb.config_heads(tenant_id,scope_id,next_revision)
 SELECT tenant_id,scope_id,max(revision)+1 FROM akb.configs GROUP BY tenant_id,scope_id;
CREATE TABLE akb.config_events (
 tenant_id uuid NOT NULL, id uuid NOT NULL, config_id uuid NOT NULL, config_revision bigint NOT NULL,
 actor_id uuid NOT NULL, operation_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('created','activated','revoked','superseded')),
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,config_id,operation_id,action),
 FOREIGN KEY(tenant_id,config_id) REFERENCES akb.configs(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES akb.principals(tenant_id,id)
);
CREATE TABLE akb.config_windows (
 tenant_id uuid NOT NULL, actor_id uuid NOT NULL, window_start timestamptz NOT NULL, reads integer NOT NULL CHECK(reads>=0),
 PRIMARY KEY(tenant_id,actor_id,window_start), FOREIGN KEY(tenant_id,actor_id) REFERENCES akb.principals(tenant_id,id)
);
CREATE FUNCTION akb.configuration_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.tenant_id,NEW.id,NEW.scope_id,NEW.revision,NEW.body,NEW.sha256,NEW.publisher_id,NEW.created_at,NEW.base_generation)
  IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.scope_id,OLD.revision,OLD.body,OLD.sha256,OLD.publisher_id,OLD.created_at,OLD.base_generation)
 THEN RAISE EXCEPTION 'configuration version is immutable'; END IF;
 IF NEW.status<>OLD.status AND NOT ((OLD.status='draft' AND NEW.status IN ('active','revoked')) OR (OLD.status='active' AND NEW.status='revoked'))
 THEN RAISE EXCEPTION 'configuration status cannot be reactivated'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER configuration_immutable BEFORE UPDATE ON akb.configs FOR EACH ROW EXECUTE FUNCTION akb.configuration_immutable();
ALTER TABLE akb.config_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE akb.config_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON akb.config_heads USING(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid);
ALTER TABLE akb.config_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE akb.config_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON akb.config_events USING(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid);
ALTER TABLE akb.config_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE akb.config_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON akb.config_windows USING(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('akb.tenant_id',true),'')::uuid);
COMMIT;
