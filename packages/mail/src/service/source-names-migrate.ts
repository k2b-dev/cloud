import type { sql } from "bun";

/** Retained provenance has no FK to executable workflow definitions or versions. */
export const migrateSourceNames = async (db: typeof sql): Promise<void> => {
  const [installed] = await db<{ present: boolean }[]>`SELECT
    to_regclass('mail.workflow_source_names') IS NOT NULL
    AND to_regprocedure('mail.capture_workflow_source_name()') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('workflows.version')
      AND tgname = 'mail_capture_workflow_version_source' AND NOT tgisinternal)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('workflows.workflow')
      AND tgname = 'mail_capture_workflow_source' AND NOT tgisinternal) AS present`;
  if (installed?.present) return;
  // Never wait while holding half of the kernel DDL locks: creators and publishers
  // take these tables in different orders. The owning migration retries 55P03.
  await db`LOCK TABLE workflows.workflow, workflows.version IN SHARE ROW EXCLUSIVE MODE NOWAIT`;

  await db`CREATE TABLE IF NOT EXISTS mail.workflow_source_names (
    version_id uuid PRIMARY KEY,
    workflow_id uuid NOT NULL,
    name text NOT NULL,
    active boolean NOT NULL DEFAULT false
  )`;
  await db`CREATE INDEX IF NOT EXISTS workflow_source_names_workflow_idx ON mail.workflow_source_names (workflow_id)`;
  // Preserve today's rename/active-version behavior while the rule product remains.
  // The deletion slice removes these capture triggers, keeping the materialized names.
  await db`CREATE OR REPLACE FUNCTION mail.capture_workflow_source_name() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME = 'version' THEN
        INSERT INTO mail.workflow_source_names (version_id, workflow_id, name, active)
          SELECT NEW.id, workflow.id, workflow.name, COALESCE(workflow.active_version_id = NEW.id, false)
          FROM workflows.workflow workflow WHERE workflow.id = NEW.workflow_id AND workflow.app_id = 'mail' FOR SHARE
          ON CONFLICT (version_id) DO NOTHING;
      ELSIF TG_OP = 'DELETE' THEN
        UPDATE mail.workflow_source_names SET active = false WHERE workflow_id = OLD.id;
      ELSE
        UPDATE mail.workflow_source_names SET name = NEW.name, active = COALESCE(version_id = NEW.active_version_id, false)
          WHERE workflow_id = NEW.id;
      END IF;
      RETURN NULL;
    END
  $$`;
  await db`CREATE OR REPLACE TRIGGER mail_capture_workflow_version_source AFTER INSERT ON workflows.version
    FOR EACH ROW EXECUTE FUNCTION mail.capture_workflow_source_name()`;
  await db`CREATE OR REPLACE TRIGGER mail_capture_workflow_source AFTER UPDATE OF name, active_version_id OR DELETE ON workflows.workflow
    FOR EACH ROW EXECUTE FUNCTION mail.capture_workflow_source_name()`;
  // Capture first, then backfill under the trigger DDL locks: old writers cannot fall through the gap.
  await db`INSERT INTO mail.workflow_source_names (version_id, workflow_id, name, active)
    SELECT version.id, workflow.id, workflow.name, COALESCE(workflow.active_version_id = version.id, false)
    FROM workflows.version version JOIN workflows.workflow workflow ON workflow.id = version.workflow_id
    WHERE workflow.app_id = 'mail'
    ON CONFLICT (version_id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active
      WHERE (workflow_source_names.name, workflow_source_names.active) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.active)`;
};
