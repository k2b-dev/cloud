import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Values are replaceable; binding revisions are immutable and live until their Code is deleted. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.migrate',0))`;
    await tx`CREATE TABLE IF NOT EXISTS code.secret_bindings (
      code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'),
      binding_revision UUID NOT NULL DEFAULT gen_random_uuid(), binding JSONB NOT NULL,
      PRIMARY KEY(code_id,name,binding_revision), CHECK (jsonb_typeof(binding)='object')
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.secrets (
      code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      name TEXT NOT NULL, binding_revision UUID NOT NULL, encrypted TEXT,
      PRIMARY KEY(code_id,name),
      FOREIGN KEY(code_id,name,binding_revision) REFERENCES code.secret_bindings(code_id,name,binding_revision)
    )`.simple();
    await tx`CREATE OR REPLACE FUNCTION code.guard_secret_binding() RETURNS TRIGGER AS $$
    BEGIN RAISE EXCEPTION 'code secret bindings are immutable' USING ERRCODE='55000'; END $$ LANGUAGE plpgsql`.simple();
    await tx`DROP TRIGGER IF EXISTS secret_binding_immutable ON code.secret_bindings`.simple();
    await tx`CREATE TRIGGER secret_binding_immutable BEFORE UPDATE ON code.secret_bindings FOR EACH ROW EXECUTE FUNCTION code.guard_secret_binding()`.simple();
  });
};
