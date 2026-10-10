import { sql } from "bun";

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS dashboard`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS dashboard.user_settings (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      gradient TEXT NOT NULL DEFAULT 'default',
      hidden_widgets TEXT[] NOT NULL DEFAULT '{}'::text[],
      shortcuts JSONB NOT NULL DEFAULT '[]'::jsonb,
      widget_layout JSONB NOT NULL DEFAULT '{"widgets":[],"order":[]}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

  await sql`
    ALTER TABLE dashboard.user_settings
    ADD COLUMN IF NOT EXISTS widget_layout JSONB NOT NULL DEFAULT '{"widgets":[],"order":[]}'::jsonb
  `.simple();

  // `NULL` follows the default board. The columns from before widgets had sizes stay until the page has converted
  // each person's settings into a board, once, on their next visit (see `migrateLegacyDashboardLayout`).
  await sql`ALTER TABLE dashboard.user_settings ADD COLUMN IF NOT EXISTS board JSONB`.simple();

  await sql`
    DO $$
    DECLARE
      r RECORD;
      parsed JSONB;
    BEGIN
      FOR r IN
        SELECT user_id, shortcuts #>> '{}' AS raw_shortcuts
        FROM dashboard.user_settings
        WHERE jsonb_typeof(shortcuts) = 'string'
      LOOP
        BEGIN
          parsed := r.raw_shortcuts::jsonb;
          IF jsonb_typeof(parsed) = 'array' THEN
            UPDATE dashboard.user_settings
            SET shortcuts = parsed, updated_at = now()
            WHERE user_id = r.user_id;
          END IF;
        EXCEPTION WHEN others THEN
          NULL;
        END;
      END LOOP;
    END $$;
  `.simple();
};
