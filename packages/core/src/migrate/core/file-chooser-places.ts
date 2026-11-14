import { sql } from "@k2b/cloud";
import { CAPABILITY_APP_ID_MAX_LENGTH } from "@k2b/cloud/contracts/capabilities";
import type { SQL } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db
    .unsafe(`
    CREATE TABLE IF NOT EXISTS auth.file_chooser_places (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      app_id TEXT NOT NULL CHECK (length(app_id) BETWEEN 1 AND ${CAPABILITY_APP_ID_MAX_LENGTH}),
      folders JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(folders) = 'array'),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
    .simple();
};
