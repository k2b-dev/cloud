import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Ephemeral authoring state belongs to Core, independently of immutable submitted versions. */
export async function migrate(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.chat-drafts.migrate',0))`;
    await tx`CREATE TABLE IF NOT EXISTS code.chat_drafts (
      code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL, entry TEXT NOT NULL, files JSONB NOT NULL, tests JSONB NOT NULL,
      base_version_id UUID, updated_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(code_id,conversation_id)
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS code_chat_drafts_expiry ON code.chat_drafts(expires_at)`.simple();
  });
}
