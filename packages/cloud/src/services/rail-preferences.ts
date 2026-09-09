import { type SQL, sql } from "bun";
import { defaultRailPreferences, type RailPreferences, RailPreferencesSchema } from "../contracts/rail-preferences";

/** Core-owned data, read by the platform SSR seam without a process-wide cache. */
export const createRailPreferencesService = (db: SQL = sql) => ({
  async get(userId: string): Promise<RailPreferences> {
    const [row] = await db<{ revision: number; visibility: unknown; shortcuts: unknown }[]>`
      SELECT revision, visibility, shortcuts FROM auth.rail_preferences WHERE user_id = ${userId}::uuid
    `;
    return row ? RailPreferencesSchema.parse(row) : defaultRailPreferences();
  },
  async save(userId: string, input: RailPreferences): Promise<RailPreferences | null> {
    const value = RailPreferencesSchema.parse(input);
    const [row] = await db<{ revision: number; visibility: unknown; shortcuts: unknown }[]>`
      INSERT INTO auth.rail_preferences (user_id, revision, visibility, shortcuts)
      SELECT ${userId}::uuid, 1, (${JSON.stringify(value.visibility)}::text)::jsonb, (${JSON.stringify(value.shortcuts)}::text)::jsonb
      WHERE ${value.revision} = 0 OR EXISTS (SELECT 1 FROM auth.rail_preferences WHERE user_id = ${userId}::uuid)
      ON CONFLICT (user_id) DO UPDATE SET
        revision = auth.rail_preferences.revision + 1,
        visibility = EXCLUDED.visibility, shortcuts = EXCLUDED.shortcuts
      WHERE auth.rail_preferences.revision = ${value.revision}
      RETURNING revision, visibility, shortcuts
    `;
    return row ? RailPreferencesSchema.parse(row) : null;
  },
});
export const railPreferences = createRailPreferencesService();
