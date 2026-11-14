import type { sql } from "bun";

/** Retained provenance has no FK to executable workflow definitions or versions. */
export const migrateSourceNames = async (db: typeof sql): Promise<void> => {
  await db`CREATE TABLE IF NOT EXISTS mail.workflow_source_names (
    version_id uuid PRIMARY KEY,
    workflow_id uuid NOT NULL,
    name text NOT NULL,
    active boolean NOT NULL DEFAULT false
  )`;
  await db`CREATE INDEX IF NOT EXISTS workflow_source_names_workflow_idx ON mail.workflow_source_names (workflow_id)`;
  await db`INSERT INTO mail.workflow_source_names (version_id, workflow_id, name, active)
    SELECT version.id, workflow.id, workflow.name, false
    FROM workflows.version version JOIN workflows.workflow workflow ON workflow.id = version.workflow_id
    WHERE workflow.app_id = 'mail'
    ON CONFLICT (version_id) DO NOTHING`;
};
