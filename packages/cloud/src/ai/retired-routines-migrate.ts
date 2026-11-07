import type { SQL } from "bun";
import { sql } from "../runtime/clients";

/** Freeze existing routine definitions and evidence; fresh installs have no task definitions. */
export async function retireChatRoutines(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ai.retire-chat-routines-v1'))`;
    // Old Core replicas cannot insert or restart routine turns after the cut migration commits.
    await tx`CREATE OR REPLACE FUNCTION ai.reject_retired_routine_turn() RETURNS trigger AS $$
      BEGIN
        IF (NEW.run_config ? 'background' OR NEW.run_config ? 'mandate') AND (TG_OP = 'INSERT' OR NEW.status IN ('queued', 'running', 'waiting_for_action')) THEN
          RAISE EXCEPTION 'Scheduled chat routines are retired';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
    await tx`DROP TRIGGER IF EXISTS ai_retired_routine_turn ON ai.turns`;
    await tx`CREATE TRIGGER ai_retired_routine_turn BEFORE INSERT OR UPDATE ON ai.turns
      FOR EACH ROW EXECUTE FUNCTION ai.reject_retired_routine_turn()`;
    await tx`CREATE OR REPLACE FUNCTION ai.reject_retired_routine_mandate() RETURNS trigger AS $$
      BEGIN
        IF NEW.owner_app_id = 'core' AND NEW.workload_type = 'ai.chat-task' AND NEW.state <> 'revoked' THEN
          RAISE EXCEPTION 'Scheduled chat routines are retired';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
    await tx`DROP TRIGGER IF EXISTS ai_retired_routine_mandate ON auth.mandates`;
    await tx`CREATE TRIGGER ai_retired_routine_mandate BEFORE INSERT OR UPDATE ON auth.mandates
      FOR EACH ROW EXECUTE FUNCTION ai.reject_retired_routine_mandate()`;
    // Snapshot authority as evidence before revocation or later owner deletion. The column is
    // a one-time checkpoint: subsequent startups never write to the frozen archive.
    await tx`DO $$ BEGIN
      IF to_regclass('ai.chat_tasks') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'chat_tasks'
          AND column_name = 'retired_mandate'
      ) THEN
        ALTER TABLE ai.chat_tasks ADD COLUMN retired_mandate JSONB;
        UPDATE ai.chat_tasks task SET retired_mandate = to_jsonb(mandate)
          FROM auth.mandates mandate WHERE mandate.id = task.mandate_id;
      END IF;
    END $$`;
    const [authority] = await tx<{ present: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM auth.mandates
        WHERE owner_app_id = 'core' AND workload_type = 'ai.chat-task' AND state <> 'revoked'
    ) AS present`;
    // Fresh databases have no routine authority to revoke. They must not need
    // Core's audit schema just to initialize AI; real revocations still require
    // the audit insert to commit in the same transaction.
    if (authority?.present)
      await tx`
      WITH revoked AS (
        UPDATE auth.mandates SET state = 'revoked', revision = revision + 1, updated_at = now(),
          revoked_at = now(), revoked_by_app_id = 'core', revoke_reason = 'Scheduled chat routines retired'
        WHERE owner_app_id = 'core' AND workload_type = 'ai.chat-task' AND state <> 'revoked'
        RETURNING id, workload_id
      ) INSERT INTO audit.events(action, outcome, target_type, target_id, reason, metadata)
        SELECT 'mandate.revoke', 'allowed', 'mandate', id::text, 'Scheduled chat routines retired',
          jsonb_build_object('ownerAppId', 'core', 'workloadType', 'ai.chat-task', 'workloadId', workload_id)
        FROM revoked`;
    await tx`UPDATE ai.pending_actions SET status = 'aborted', resolved_at = COALESCE(resolved_at, now())
      WHERE status = 'pending' AND turn_id IN (SELECT id FROM ai.turns WHERE (run_config ? 'background' OR run_config ? 'mandate'))`;
    await tx`UPDATE ai.turns SET status = 'aborted', completed_at = COALESCE(completed_at, now()),
      cancel_requested_at = COALESCE(cancel_requested_at, now()), lease_owner = NULL, lease_expires_at = NULL,
      error = 'Scheduled chat routines retired'
      WHERE (run_config ? 'background' OR run_config ? 'mandate') AND status IN ('queued', 'running', 'waiting_for_action')`;
    await tx`CREATE OR REPLACE FUNCTION ai.read_only_routine_archive() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Retired routine history is read-only'; END $$ LANGUAGE plpgsql`;
    await tx`DO $$ DECLARE archive TEXT; fk RECORD;
      BEGIN
        FOREACH archive IN ARRAY ARRAY['chat_tasks', 'chat_task_occurrences', 'task_messages'] LOOP
          IF to_regclass('ai.' || archive) IS NULL THEN CONTINUE; END IF;
          -- Keep IDs as historical coordinates; deleting a live user/chat/turn must not cascade into the archive.
          FOR fk IN SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('ai.' || archive)
            AND contype = 'f' AND confrelid NOT IN (COALESCE(to_regclass('ai.chat_tasks')::oid, 0::oid), COALESCE(to_regclass('ai.chat_task_occurrences')::oid, 0::oid)) LOOP
            EXECUTE format('ALTER TABLE ai.%I DROP CONSTRAINT %I', archive, fk.conname);
          END LOOP;
          IF archive = 'chat_tasks' THEN
            EXECUTE 'DROP TRIGGER IF EXISTS ai_chat_task_mandate_clear ON ai.chat_tasks';
            EXECUTE 'DROP TRIGGER IF EXISTS ai_chat_task_mandate_revoke ON ai.chat_tasks';
            EXECUTE 'DROP TRIGGER IF EXISTS ai_live_chat_tasks_changed ON ai.chat_tasks';
          ELSIF archive = 'chat_task_occurrences' THEN
            EXECUTE 'DROP TRIGGER IF EXISTS ai_live_chat_task_occurrences_changed ON ai.chat_task_occurrences';
          END IF;
          EXECUTE format('DROP TRIGGER IF EXISTS ai_routine_archive_read_only ON ai.%I', archive);
          EXECUTE format('CREATE TRIGGER ai_routine_archive_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ai.%I FOR EACH STATEMENT EXECUTE FUNCTION ai.read_only_routine_archive()', archive);
        END LOOP;
      END $$`;
  });
}
