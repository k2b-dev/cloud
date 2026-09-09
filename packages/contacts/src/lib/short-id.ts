import { crypto } from "@k2b/stdlib";
import { isUniqueViolation, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";

export const SHORT_ID_REGEX = /^[0-9A-Za-z]{6}$/;
export const SHORT_ID_LENGTH = 6;

export type ShortIdTable = "book" | "contact" | "tag" | "note";

const MAX_ATTEMPTS = 10;
const BACKFILL_BATCH_SIZE = 500;

const constraintByTable: Record<ShortIdTable, string> = {
  book: "idx_contacts_books_short_id",
  contact: "idx_contacts_contacts_short_id",
  tag: "idx_contacts_tags_short_id",
  note: "idx_contacts_notes_short_id",
};

export const newShortId = (): string => crypto.common.readableId(SHORT_ID_LENGTH);

const isShortIdCollision = (error: unknown, tables: readonly ShortIdTable[]): boolean =>
  tables.some((table) => isUniqueViolation(error, constraintByTable[table]));

export const withShortIdRetry = async <T>(tables: readonly ShortIdTable[], write: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!isShortIdCollision(error, tables)) throw error;
    }
  }
  throw new Error(`Failed to allocate a short ID for ${tables.join(", ")}`);
};

export const withShortId = <T>(table: ShortIdTable, write: (shortId: string) => Promise<T>): Promise<T> =>
  withShortIdRetry([table], () => write(newShortId()));

type SqlExecutor = typeof sql;

const selectMissing = async (db: SqlExecutor, table: ShortIdTable): Promise<{ id: string }[]> => {
  switch (table) {
    case "book":
      return db`SELECT id FROM contacts.books WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE} FOR UPDATE`;
    case "contact":
      return db`SELECT id FROM contacts.contacts WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE} FOR UPDATE`;
    case "tag":
      return db`SELECT id FROM contacts.tags WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE} FOR UPDATE`;
    case "note":
      return db`SELECT id FROM contacts.contact_notes WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE} FOR UPDATE`;
  }
};

const updateMissing = async (db: SqlExecutor, table: ShortIdTable, rows: { id: string; shortId: string }[]): Promise<void> => {
  if (rows.length === 0) return;
  const ids = toPgUuidArray(rows.map((row) => row.id));
  const shortIds = toPgTextArray(rows.map((row) => row.shortId));
  switch (table) {
    case "book":
      await db`
        UPDATE contacts.books target SET short_id = source.short_id
        FROM unnest(${ids}::uuid[], ${shortIds}::text[]) AS source(id, short_id)
        WHERE target.id = source.id AND target.short_id IS NULL
      `;
      return;
    case "contact":
      await db`
        UPDATE contacts.contacts target SET short_id = source.short_id
        FROM unnest(${ids}::uuid[], ${shortIds}::text[]) AS source(id, short_id)
        WHERE target.id = source.id AND target.short_id IS NULL
      `;
      return;
    case "tag":
      await db`
        UPDATE contacts.tags target SET short_id = source.short_id
        FROM unnest(${ids}::uuid[], ${shortIds}::text[]) AS source(id, short_id)
        WHERE target.id = source.id AND target.short_id IS NULL
      `;
      return;
    case "note":
      await db`
        UPDATE contacts.contact_notes target SET short_id = source.short_id
        FROM unnest(${ids}::uuid[], ${shortIds}::text[]) AS source(id, short_id)
        WHERE target.id = source.id AND target.short_id IS NULL
      `;
  }
};

const backfillBatch = async (table: ShortIdTable): Promise<number> =>
  withShortIdRetry([table], () =>
    sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.contacts.short-id-backfill'))`;
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
    const batchSize = await backfillBatch(table);
    filled += batchSize;
    if (batchSize < BACKFILL_BATCH_SIZE) return filled;
  }
};

export const shortIdsFinalized = async (): Promise<boolean> => {
  const [row] = await sql<{ ready: boolean }[]>`
    SELECT
      COUNT(*) FILTER (WHERE is_nullable = 'NO') = 4
      AND to_regclass('contacts.idx_contacts_books_short_id') IS NOT NULL
      AND to_regclass('contacts.idx_contacts_contacts_short_id') IS NOT NULL
      AND to_regclass('contacts.idx_contacts_tags_short_id') IS NOT NULL
      AND to_regclass('contacts.idx_contacts_notes_short_id') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_books_short_id_format')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_contacts_short_id_format')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_tags_short_id_format')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_notes_short_id_format') AS ready
    FROM information_schema.columns
    WHERE table_schema = 'contacts'
      AND table_name IN ('books', 'contacts', 'tags', 'contact_notes')
      AND column_name = 'short_id'
  `;
  return row?.ready ?? false;
};

/** Closes the rolling-deploy race between the last batch and NOT NULL. */
export const finalizeShortIds = async (): Promise<void> => {
  await withShortIdRetry(["book", "contact", "tag", "note"], () =>
    sql.begin(async (tx) => {
      await tx`
      LOCK TABLE contacts.books, contacts.contacts, contacts.tags, contacts.contact_notes
      IN ACCESS EXCLUSIVE MODE
    `;
      for (const table of ["book", "contact", "tag", "note"] as const) {
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
      await tx`
      ALTER TABLE contacts.books ALTER COLUMN short_id SET NOT NULL;
      ALTER TABLE contacts.books DROP CONSTRAINT IF EXISTS contacts_books_short_id_format;
      ALTER TABLE contacts.books ADD CONSTRAINT contacts_books_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$');
      ALTER TABLE contacts.contacts ALTER COLUMN short_id SET NOT NULL;
      ALTER TABLE contacts.contacts DROP CONSTRAINT IF EXISTS contacts_contacts_short_id_format;
      ALTER TABLE contacts.contacts ADD CONSTRAINT contacts_contacts_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$');
      ALTER TABLE contacts.tags ALTER COLUMN short_id SET NOT NULL;
      ALTER TABLE contacts.tags DROP CONSTRAINT IF EXISTS contacts_tags_short_id_format;
      ALTER TABLE contacts.tags ADD CONSTRAINT contacts_tags_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$');
      ALTER TABLE contacts.contact_notes ALTER COLUMN short_id SET NOT NULL;
      ALTER TABLE contacts.contact_notes DROP CONSTRAINT IF EXISTS contacts_notes_short_id_format;
      ALTER TABLE contacts.contact_notes ADD CONSTRAINT contacts_notes_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$')
    `.simple();
    }),
  );
};
