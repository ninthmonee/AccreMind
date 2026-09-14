-- B03: preserve safe task context; raw evidence content remains in controlled file storage.
BEGIN;
ALTER TABLE akb.contributions ADD COLUMN environment jsonb NOT NULL DEFAULT '{}'
 CHECK(jsonb_typeof(environment)='object');
COMMIT;
