import type { sql } from "bun";

/*
 * ALTER TABLE, CREATE INDEX and CREATE TRIGGER lock their table before they look whether the object exists, and a
 * concurrent index build holds a conflicting lock for as long as it waits for older snapshots, possibly hours. On a
 * table that a background build may hold, Mail's start therefore runs such a statement only when the catalog shows that
 * it changes something. `migrate-startup.integration.test.ts` holds that lock on every such table while Mail migrates.
 */

const INDEX = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)\.[a-z0-9_]+/;
const COLUMN = /^ALTER TABLE ([a-z0-9_]+\.[a-z0-9_]+) ADD COLUMN IF NOT EXISTS ([a-z0-9_]+)\s/;
// A second clause would change the table even when the column exists.
const SECOND_CLAUSE =
  /,\s*(?:ADD|ALTER|DROP|RENAME|VALIDATE|SET|RESET|OWNER|ENABLE|DISABLE|INHERIT|NO|CLUSTER|REPLICA|FORCE|ATTACH|DETACH)\s/i;

const hasColumn = async (db: typeof sql, table: string, column: string) => {
  const [row] = await db<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = ${table}::regclass AND attname = ${column} AND attnum > 0 AND NOT attisdropped) AS present`;
  return row?.present ?? false;
};

const hasRelation = async (db: typeof sql, name: string) => {
  const [row] = await db<{ present: boolean }[]>`SELECT to_regclass(${name}) IS NOT NULL AS present`;
  return row?.present ?? false;
};

/**
 * Runs one `CREATE [UNIQUE] INDEX IF NOT EXISTS` or single-column `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statement
 * only when its index or column is missing. Any other statement runs as given.
 */
export const applyIfMissing = async (db: typeof sql, statement: string): Promise<void> => {
  const text = statement.replace(/^(?:\s*--[^\n]*\n)*/, "").trim();
  const index = INDEX.exec(text);
  if (index && (await hasRelation(db, `${index[2]}.${index[1]}`))) return;
  const column = COLUMN.exec(text);
  if (column && !SECOND_CLAUSE.test(text) && (await hasColumn(db, column[1]!, column[2]!))) return;
  await db.unsafe(text).simple();
};

/** A schema file of plain statements, each run through `applyIfMissing`; function bodies (`$$`) are not supported. */
export const applySchemaScript = async (db: typeof sql, script: string): Promise<void> => {
  if (script.includes("$$")) throw new Error("A schema script with function bodies cannot be split into statements");
  for (const statement of script.split(/;\s*(?:\n|$)/)) {
    if (statement.replace(/--[^\n]*/g, "").trim()) await applyIfMissing(db, statement);
  }
};

const TRIGGER = /^CREATE TRIGGER ([a-z_]+) .+ ON (mail\.[a-z_]+) FOR EACH ROW EXECUTE FUNCTION /;

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
