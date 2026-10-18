import { CAPABILITY_APP_ID_MAX_LENGTH } from "@k2b/cloud/contracts/capabilities";
import { type SQL, sql } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db
    .unsafe(`
    CREATE TABLE IF NOT EXISTS auth.panel_context_consent (
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND ${CAPABILITY_APP_ID_MAX_LENGTH}),
      allowed BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, provider)
    )
  `)
    .simple();
};
