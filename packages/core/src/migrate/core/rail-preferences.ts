import { type SQL, sql } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`
    CREATE TABLE IF NOT EXISTS auth.rail_preferences (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      visibility JSONB NOT NULL DEFAULT '{}',
      shortcuts JSONB NOT NULL DEFAULT '[]'
    )
  `.simple();
};
