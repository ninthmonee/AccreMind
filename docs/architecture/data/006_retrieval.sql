-- B07 additive read reservations, policy windows and measurable execution cost.
BEGIN;
ALTER TABLE akb.tasks ADD COLUMN environment jsonb;
ALTER TABLE akb.operations ADD COLUMN generation bigint NOT NULL DEFAULT 0;
ALTER TABLE akb.operations ADD COLUMN read_window_start timestamptz;
CREATE TABLE akb.read_windows (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, window_start timestamptz NOT NULL,
 used integer NOT NULL DEFAULT 0 CHECK(used>=0), reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0),
 PRIMARY KEY(tenant_id,principal_id,window_start),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES akb.principals(tenant_id,id),
 CHECK(used+reserved<=20)
);
CREATE TABLE akb.retrieval_costs (
 tenant_id uuid NOT NULL, id uuid NOT NULL, operation_id uuid NOT NULL, actor_id uuid NOT NULL,
 generation bigint NOT NULL, elapsed_ms integer NOT NULL CHECK(elapsed_ms>=0), returned_tokens integer NOT NULL CHECK(returned_tokens>=0),
 outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,operation_id) REFERENCES akb.operations(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES akb.principals(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['read_windows','retrieval_costs'] LOOP
  EXECUTE format('ALTER TABLE akb.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE akb.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON akb.%I USING (tenant_id=nullif(current_setting(''akb.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''akb.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
COMMIT;
