import { sql } from "bun";

/** Observation guards and comparison schedules expire with history. */
export async function migrateActivityObservations(): Promise<void> {
  await sql`ALTER TABLE filesv2.activity ADD COLUMN IF NOT EXISTS observation_key text,
    ADD COLUMN IF NOT EXISTS observation_next_at timestamptz,
    ADD COLUMN IF NOT EXISTS observation_checks integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS observation_error text`.simple();
  await sql`ALTER TABLE filesv2.activity ALTER COLUMN observation_next_at SET DEFAULT now()`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_observation_identity ON filesv2.activity(server_url,coalesce(root_after,root),item_after_id,finished_at DESC,id DESC)
    WHERE state='done' AND actor_kind<>'observed' AND item_after_id IS NOT NULL`.simple();
  // NULL schedules from before this migration join the same ordered scan; no bulk backfill.
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_observation_due ON filesv2.activity(coalesce(observation_next_at,'-infinity'::timestamptz),id)
    WHERE state='done' AND actor_kind<>'observed' AND path_after IS NOT NULL AND coalesce(base_after_id,base_id) IS NOT NULL
      AND action IN ('folder.create','item.rename','item.move','item.copy','file.upload','file.overwrite','file.create','file.edit',
        'version.restore','version.restore_copy','item.restore')`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_observation_root_due ON filesv2.activity(server_url,coalesce(root_after,root),coalesce(observation_next_at,'-infinity'::timestamptz),id)
    WHERE state='done' AND actor_kind<>'observed' AND path_after IS NOT NULL AND coalesce(base_after_id,base_id) IS NOT NULL
      AND action IN ('folder.create','item.rename','item.move','item.copy','file.upload','file.overwrite','file.create','file.edit',
        'version.restore','version.restore_copy','item.restore')`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS filesv2_activity_observation_key ON filesv2.activity(observation_key) WHERE observation_key IS NOT NULL`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_observation_destination ON filesv2.activity(coalesce(root_after,root),left(path_after,400))`.simple();
}
