import { crypto } from "@k2b/stdlib";
import { isUniqueViolation, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { type SQL, sql } from "bun";

export const SHORT_ID_REGEX = /^[0-9A-Za-z]{6}$/;
export const SHORT_ID_LENGTH = 6;

export type ShortIdTable = "venue" | "openingRule" | "override" | "template" | "assignment" | "section";

const MAX_ATTEMPTS = 10;
const BACKFILL_BATCH_SIZE = 500;

const tableInfo: Record<ShortIdTable, { table: string; index: string }> = {
  venue: { table: "venues", index: "idx_venue_venues_short_id" },
  openingRule: { table: "opening_rules", index: "idx_venue_opening_rules_short_id" },
  override: { table: "date_overrides", index: "idx_venue_date_overrides_short_id" },
  template: { table: "shift_templates", index: "idx_venue_shift_templates_short_id" },
  assignment: { table: "shift_assignments", index: "idx_venue_shift_assignments_short_id" },
  section: { table: "public_sections", index: "idx_venue_public_sections_short_id" },
};

export const newShortId = (): string => crypto.common.readableId(SHORT_ID_LENGTH);

export const withShortIdRetry = async <T>(tables: readonly ShortIdTable[], write: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!tables.some((table) => isUniqueViolation(error, tableInfo[table].index))) throw error;
    }
  }
  throw new Error(`Failed to allocate a Venue short ID for ${tables.join(", ")}`);
};

export const withShortId = <T>(table: ShortIdTable, write: (shortId: string) => Promise<T>): Promise<T> =>
  withShortIdRetry([table], () => write(newShortId()));

type SavepointedSql = SQL & { savepoint: <T>(write: (db: SQL) => Promise<T>) => Promise<T> };
const isTransaction = (db: SQL): db is SavepointedSql => typeof (db as Partial<SavepointedSql>).savepoint === "function";

export const withShortIdDb = <T>(db: SQL, table: ShortIdTable, write: (db: SQL, shortId: string) => Promise<T>): Promise<T> =>
  withShortId(table, (shortId) => (isTransaction(db) ? db.savepoint((attempt) => write(attempt, shortId)) : write(db, shortId)));

type SqlExecutor = typeof sql;

const selectMissing = (db: SqlExecutor, table: ShortIdTable): Promise<{ id: string }[]> =>
  db.unsafe(`SELECT id FROM venue.${tableInfo[table].table} WHERE short_id IS NULL ORDER BY id LIMIT $1 FOR UPDATE`, [
    BACKFILL_BATCH_SIZE,
  ]) as Promise<{ id: string }[]>;

const updateMissing = async (db: SqlExecutor, table: ShortIdTable, rows: { id: string; shortId: string }[]): Promise<void> => {
  if (rows.length === 0) return;
  await db.unsafe(
    `UPDATE venue.${tableInfo[table].table} target SET short_id = source.short_id
     FROM unnest($1::uuid[], $2::text[]) AS source(id, short_id)
     WHERE target.id = source.id AND target.short_id IS NULL`,
    [toPgUuidArray(rows.map((row) => row.id)), toPgTextArray(rows.map((row) => row.shortId))],
  );
};

const backfillBatch = (table: ShortIdTable): Promise<number> =>
  withShortIdRetry([table], () =>
    sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.venue.short-id-backfill'))`;
      const rows = await selectMissing(tx, table);
      await updateMissing(
        tx,
        table,
        rows.map((row) => ({ id: row.id, shortId: newShortId() })),
      );
      return rows.length;
    }),
  );

export const backfillShortIds = async (table: ShortIdTable): Promise<number> => {
  let filled = 0;
  for (;;) {
    const count = await backfillBatch(table);
    filled += count;
    if (count < BACKFILL_BATCH_SIZE) return filled;
  }
};

export const shortIdsFinalized = async (): Promise<boolean> => {
  const [row] = await sql<{ ready: boolean }[]>`
    SELECT COUNT(*) FILTER (WHERE is_nullable = 'NO') = 6
      AND COUNT(*) FILTER (WHERE is_nullable = 'NO' AND data_type = 'text') = 6
      AND to_regclass('venue.idx_venue_venues_short_id') IS NOT NULL
      AND to_regclass('venue.idx_venue_opening_rules_short_id') IS NOT NULL
      AND to_regclass('venue.idx_venue_date_overrides_short_id') IS NOT NULL
      AND to_regclass('venue.idx_venue_shift_templates_short_id') IS NOT NULL
      AND to_regclass('venue.idx_venue_shift_assignments_short_id') IS NOT NULL
      AND to_regclass('venue.idx_venue_public_sections_short_id') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venue_venues_short_id_format')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venue_opening_rules_short_id_format')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venue_date_overrides_short_id_format')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venue_shift_templates_short_id_format')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venue_shift_assignments_short_id_format')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venue_public_sections_short_id_format') AS ready
    FROM information_schema.columns
    WHERE table_schema = 'venue'
      AND table_name IN ('venues', 'opening_rules', 'date_overrides', 'shift_templates', 'shift_assignments', 'public_sections')
      AND column_name = 'short_id'
  `;
  return row?.ready ?? false;
};

export const finalizeShortIds = async (): Promise<void> => {
  const tables = Object.keys(tableInfo) as ShortIdTable[];
  await withShortIdRetry(tables, () =>
    sql.begin(async (tx) => {
      await tx`
        LOCK TABLE venue.venues, venue.opening_rules, venue.date_overrides, venue.shift_templates,
          venue.shift_assignments, venue.public_sections IN ACCESS EXCLUSIVE MODE
      `;
      for (const table of tables) {
        for (;;) {
          const rows = await selectMissing(tx, table);
          if (rows.length === 0) break;
          await updateMissing(
            tx,
            table,
            rows.map((row) => ({ id: row.id, shortId: newShortId() })),
          );
        }
      }
      for (const { table } of Object.values(tableInfo)) {
        await tx.unsafe(`ALTER TABLE venue.${table} ALTER COLUMN short_id SET NOT NULL`);
        await tx.unsafe(`ALTER TABLE venue.${table} DROP CONSTRAINT IF EXISTS venue_${table}_short_id_format`);
        await tx.unsafe(`ALTER TABLE venue.${table} ADD CONSTRAINT venue_${table}_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$')`);
      }
    }),
  );
};
