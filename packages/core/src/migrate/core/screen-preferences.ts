import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** A row exists only after a person changed a screen preference; without one the contract's defaults apply. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`
    CREATE TABLE IF NOT EXISTS auth.screen_preferences (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      privacy_timer_seconds INTEGER NOT NULL CHECK (privacy_timer_seconds >= 0)
    )
  `.simple();
};
