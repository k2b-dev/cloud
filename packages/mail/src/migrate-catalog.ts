import { addMissingColumns, createIndexIfMissing } from "@k2b/cloud/services/concurrent-index";
import type { sql } from "bun";

/*
 * ALTER TABLE, CREATE INDEX and CREATE TRIGGER lock their table before they look whether the object exists, and a
 * concurrent index build holds a conflicting lock for as long as it waits for older snapshots, possibly hours. On a
 * table that a background build may hold, Mail's start therefore runs such a statement only when the catalog shows that
 * it changes something (`addMissingColumns`, `createIndexIfMissing` and the two below).
 * `migrate-startup.integration.test.ts` holds that lock on every such table while Mail migrates.
 */

const INDEX = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS ([a-z0-9_]+)\s+ON\s+([a-z0-9_]+\.[a-z0-9_]+)\s+(.+)$/s;
// One column only: a second clause would change the table even when the column exists.
const COLUMN = /^ALTER TABLE ([a-z0-9_]+\.[a-z0-9_]+) ADD COLUMN IF NOT EXISTS ([a-z0-9_]+)\s+([^,]+)$/s;

/**
 * A schema file of plain statements: each index or single-column addition goes through the catalog check, any other
 * statement (`CREATE TABLE IF NOT EXISTS`, which takes no lock on an existing table) runs as written. Function bodies
 * (`$$`) are not supported.
 */
export const applySchemaScript = async (db: typeof sql, script: string): Promise<void> => {
  if (script.includes("$$")) throw new Error("A schema script with function bodies cannot be split into statements");
  for (const raw of script.split(/;\s*(?:\n|$)/)) {
    const statement = raw.replace(/^(?:\s*--[^\n]*\n)*/, "").trim();
    if (!statement) continue;
    const index = INDEX.exec(statement);
    const column = COLUMN.exec(statement);
    if (index) await createIndexIfMissing(db, { unique: Boolean(index[1]), name: index[2]!, table: index[3]!, definition: index[4]! });
    else if (column) await addMissingColumns(db, column[1]!, { [column[2]!]: column[3]! });
    else await db.unsafe(statement).simple();
  }
};

const TRIGGER = /^CREATE TRIGGER ([a-z0-9_]+) .+ ON (mail\.[a-z0-9_]+) FOR EACH ROW EXECUTE FUNCTION /;

/**
 * Creates or replaces a trigger only when its stored definition differs. `definition` is written exactly as
 * `pg_get_triggerdef` prints it, so an unchanged trigger compares equal and its table is not locked.
 */
export const replaceTrigger = async (db: typeof sql, definition: string): Promise<void> => {
  const match = TRIGGER.exec(definition);
  if (!match) throw new Error(`Not a trigger definition in pg_get_triggerdef form: ${definition}`);
  const [stored] = await db<{ definition: string }[]>`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
    WHERE tgrelid = ${match[2]!}::regclass AND tgname = ${match[1]!} AND NOT tgisinternal`;
  if (stored?.definition === definition) return;
  await db.unsafe(definition.replace(/^CREATE TRIGGER /, "CREATE OR REPLACE TRIGGER ")).simple();
};
