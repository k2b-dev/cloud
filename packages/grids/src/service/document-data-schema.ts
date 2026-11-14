import type { SQL } from "bun";

export const defineDocumentDataSchema = async (sql: SQL) => {
  await sql`CREATE TABLE IF NOT EXISTS grids.document_data (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    short_id text NOT NULL UNIQUE CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
    base_id uuid NOT NULL REFERENCES grids.bases(id) ON DELETE RESTRICT,
    operation_key text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
    request_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (base_id, operation_key), UNIQUE (id, base_id)
  )`.simple();
  await sql`CREATE OR REPLACE FUNCTION grids.reject_document_data_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Document data is immutable'; END IF; RETURN OLD; END $$`.simple();
  await sql`DROP TRIGGER IF EXISTS document_data_immutable ON grids.document_data`.simple();
  await sql`CREATE TRIGGER document_data_immutable BEFORE UPDATE ON grids.document_data FOR EACH ROW EXECUTE FUNCTION grids.reject_document_data_update()`.simple();
  await sql`ALTER TABLE grids.documents ADD COLUMN IF NOT EXISTS domain_data_id uuid`.simple();
  await sql`ALTER TABLE grids.document_issuances ADD COLUMN IF NOT EXISTS domain_data_id uuid REFERENCES grids.document_data(id) ON DELETE RESTRICT`.simple();
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_domain_data_fkey' AND conrelid = 'grids.documents'::regclass) THEN
      ALTER TABLE grids.documents ADD CONSTRAINT documents_domain_data_fkey FOREIGN KEY (domain_data_id, base_id) REFERENCES grids.document_data(id, base_id) ON DELETE RESTRICT;
      ALTER TABLE grids.documents DROP CONSTRAINT documents_source_binding_chk;
      ALTER TABLE grids.documents ADD CONSTRAINT documents_source_binding_chk CHECK (
        (domain_data_id IS NULL AND (
          (template_id IS NOT NULL AND snapshot_id IS NOT NULL AND table_id IS NOT NULL AND record_id IS NOT NULL)
          OR (template_id IS NULL AND snapshot_id IS NULL AND table_id IS NULL AND record_id IS NULL AND workflow_run_id IS NOT NULL)
        )) OR (domain_data_id IS NOT NULL AND template_id IS NULL AND snapshot_id IS NULL AND table_id IS NULL AND record_id IS NULL
          AND workflow_run_id IS NULL AND workflow_step_key IS NULL AND query_data_id IS NULL AND associated_query_data_id IS NULL)
      );
    END IF;
  END $$`.simple();
};
