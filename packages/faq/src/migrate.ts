import { sql } from "bun";

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS faq`.simple();
  console.log("  ✓ faq schema");

  await sql`
    CREATE TABLE IF NOT EXISTS faq.entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      translations JSONB NOT NULL CHECK (
        jsonb_typeof(translations) = 'object'
        AND translations ? 'en'
      ),
      audience TEXT[] NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  console.log("  ✓ faq.entries table");
};
