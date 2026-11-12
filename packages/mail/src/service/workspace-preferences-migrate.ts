import type { sql } from "bun";

/** Additive workspace preferences; run inside Mail's existing migration transaction. */
export const migrateWorkspacePreferences = async (db: typeof sql): Promise<void> => {
  await db`ALTER TABLE mail.personal_mailbox_preferences
    ADD COLUMN IF NOT EXISTS list_share double precision CHECK (list_share >= 0 AND list_share <= 1),
    ADD COLUMN IF NOT EXISTS seen_hints text[] NOT NULL DEFAULT '{}'`;
};
