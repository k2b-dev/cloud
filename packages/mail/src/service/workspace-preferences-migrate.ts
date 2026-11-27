import { addColumns } from "@k2b/cloud/services/migration-ddl";
import type { sql } from "bun";

/** Additive workspace preferences; run inside Mail's existing migration transaction. */
export const migrateWorkspacePreferences = async (db: typeof sql): Promise<void> => {
  await addColumns(db, "mail.personal_mailbox_preferences", {
    list_share: "double precision CHECK (list_share >= 0 AND list_share <= 1)",
    seen_hints: "text[] NOT NULL DEFAULT '{}'",
  });
};
