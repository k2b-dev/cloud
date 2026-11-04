import { sql } from "@k2b/cloud";
import { createCodeAccountHandle } from "../../code/service-account";

/** Idempotent in-place migration: account IDs and their grants never move. */
export const migrateCodeAccountHandles = async () => {
  await sql`ALTER TABLE auth.service_accounts ADD COLUMN IF NOT EXISTS title TEXT NULL,
    ADD COLUMN IF NOT EXISTS handle TEXT NULL`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS service_accounts_handle_unique ON auth.service_accounts(handle)`.simple();
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='service_accounts_handle_check' AND conrelid='auth.service_accounts'::regclass) THEN
      ALTER TABLE auth.service_accounts ADD CONSTRAINT service_accounts_handle_check
        CHECK (handle IS NULL OR (kind='code' AND handle ~ '^code-[0123456789abcdefghjkmnpqrstvwxyz]{10}$'));
    END IF;
  END $$`.simple();
  // Work in bounded batches; another migration or a collision can only leave a row for the next pass.
  for (;;) {
    const rows = await sql<
      { id: string }[]
    >`SELECT id FROM auth.service_accounts WHERE kind='code' AND handle IS NULL ORDER BY id LIMIT 500`;
    if (!rows.length) break;
    for (const row of rows) {
      try {
        await sql`UPDATE auth.service_accounts SET handle=${createCodeAccountHandle()} WHERE id=${row.id}::uuid AND handle IS NULL`;
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "errno" in error && error.errno === "23505")) throw error;
      }
    }
  }
};
