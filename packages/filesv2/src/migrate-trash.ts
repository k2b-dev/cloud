import { sql } from "bun";

/** Upgrade existing records without changing their restore locations. */
export async function migrateTrash(): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='filesv2.trash'::regclass
      AND conname='trash_state_check' AND position('pending' in pg_get_constraintdef(oid))=0) THEN
      ALTER TABLE filesv2.trash DROP CONSTRAINT trash_state_check;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='filesv2.trash'::regclass AND conname='trash_state_check') THEN
      ALTER TABLE filesv2.trash ADD CONSTRAINT trash_state_check
        CHECK (state IN ('pending','trashed','restoring','restored','gone'));
    END IF;
  END $$`.simple();
  await sql`ALTER TABLE filesv2.trash ALTER COLUMN original DROP NOT NULL`.simple();
  await sql`ALTER TABLE filesv2.trash ADD COLUMN IF NOT EXISTS snapshot JSONB,
    ADD COLUMN IF NOT EXISTS restore_path TEXT,
    ADD COLUMN IF NOT EXISTS error_code TEXT,
    ADD COLUMN IF NOT EXISTS server_url TEXT`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_trash_visible
    ON filesv2.trash(base_id,deleted_at DESC,id)
    WHERE state IN ('pending','trashed','restoring')`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS filesv2_trash_pending_source
    ON filesv2.trash(base_id,original) WHERE state='pending'`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_trash_path ON filesv2.trash(base_id,trashed)`.simple();
}
