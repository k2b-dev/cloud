import { createHash } from "node:crypto";
import { sql } from "bun";

/** Idempotent upgrade: existing public URLs survive, their bearer tokens do not stay in the database. */
export async function migrateSharing(): Promise<void> {
  await sql.begin(async (tx) => {
    // Multiple application instances may start together; no instance observes a half-migrated token table.
    await tx`SELECT pg_advisory_xact_lock(hashtext('filesv2.sharing-migration'))`;
    await tx`ALTER TABLE filesv2.shares ADD COLUMN IF NOT EXISTS token_hash TEXT`.simple();
    const columns = await tx<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_schema='filesv2' AND table_name='shares' AND column_name='token'`;
    if (columns.length) {
      for (;;) {
        const rows = await tx<
          { id: string; token: string }[]
        >`SELECT id,token FROM filesv2.shares WHERE token_hash IS NULL LIMIT 200 FOR UPDATE`;
        if (!rows.length) break;
        for (const row of rows)
          await tx`UPDATE filesv2.shares SET token_hash=${createHash("sha256").update(row.token).digest("hex")} WHERE id=${row.id}::uuid`;
      }
      await tx`ALTER TABLE filesv2.shares DROP COLUMN token`.simple();
    }
    await tx`ALTER TABLE filesv2.shares ALTER COLUMN token_hash SET NOT NULL`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS filesv2_share_token_hash ON filesv2.shares(token_hash)`.simple();
    await tx`ALTER TABLE filesv2.shares ALTER COLUMN expires_at DROP NOT NULL`.simple();
    await tx`ALTER TABLE filesv2.shares ADD COLUMN IF NOT EXISTS max_file_size BIGINT NOT NULL DEFAULT 104857600,
      ADD COLUMN IF NOT EXISTS max_total_size BIGINT NOT NULL DEFAULT 1073741824,
      ADD COLUMN IF NOT EXISTS show_upload_names BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS public_note TEXT`.simple();
    await tx`ALTER TABLE filesv2.uploads ADD COLUMN IF NOT EXISTS filegate_session_id TEXT,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS error_code TEXT,
      ADD COLUMN IF NOT EXISTS server_url TEXT NOT NULL DEFAULT ''`.simple();
    await tx`ALTER TABLE filesv2.uploads DROP CONSTRAINT IF EXISTS uploads_state_check,
      ADD CONSTRAINT uploads_state_check CHECK(state IN ('open','committed','aborted','expired'))`.simple();
    await tx`CREATE INDEX IF NOT EXISTS filesv2_upload_share_state ON filesv2.uploads(share_id,state)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS filesv2_share_owner_page ON filesv2.shares(created_by,created_at DESC,id DESC)`.simple();
  });
}
