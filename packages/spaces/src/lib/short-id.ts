import { crypto } from "@k2b/stdlib";
import { isUniqueViolation } from "@k2b/cloud/services";
import { sql } from "bun";

export const SHORT_ID_REGEX = /^[0-9A-Za-z]{6}$/;
export const SHORT_ID_LENGTH = 6;

export type ShortIdTable = "space" | "column" | "item" | "attachment" | "checklist" | "comment" | "tag" | "wormhole";

const MAX_ATTEMPTS = 10;
const BACKFILL_BATCH_SIZE = 500;

const constraintByTable: Record<ShortIdTable, string> = {
  space: "idx_spaces_short_id",
  column: "idx_columns_short_id",
  item: "idx_items_short_id",
  attachment: "idx_item_attachments_short_id",
  checklist: "idx_item_checklist_entries_short_id",
  comment: "idx_comments_short_id",
  tag: "idx_tags_short_id",
  wormhole: "idx_wormholes_short_id",
};

const isShortIdCollision = (error: unknown, tables: readonly ShortIdTable[]): boolean => {
  return tables.some((table) => isUniqueViolation(error, constraintByTable[table]));
};

export const newShortId = (): string => crypto.common.readableId(SHORT_ID_LENGTH);

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

const isTaken = async (db: SqlExecutor, table: ShortIdTable, shortId: string): Promise<boolean> => {
  let rows: { exists: boolean }[];
  switch (table) {
    case "space":
      rows = await db`SELECT EXISTS (SELECT 1 FROM spaces.spaces WHERE short_id = ${shortId}) AS exists`;
      break;
    case "column":
      rows = await db`SELECT EXISTS (SELECT 1 FROM spaces.columns WHERE short_id = ${shortId}) AS exists`;
      break;
    case "item":
      rows = await db`SELECT EXISTS (SELECT 1 FROM spaces.items WHERE short_id = ${shortId}) AS exists`;
      break;
    case "attachment":
      rows = await db`SELECT EXISTS (SELECT 1 FROM spaces.item_attachments WHERE short_id = ${shortId}) AS exists`;
      break;
    case "checklist":
      rows = await db`SELECT EXISTS (SELECT 1 FROM spaces.item_checklist_entries WHERE short_id = ${shortId}) AS exists`;
      break;
    case "comment":
      rows = await db`SELECT EXISTS (SELECT 1 FROM spaces.comments WHERE short_id = ${shortId}) AS exists`;
      break;
    case "tag":
      rows = await db`SELECT EXISTS (SELECT 1 FROM spaces.tags WHERE short_id = ${shortId}) AS exists`;
      break;
    case "wormhole":
      rows = await db`SELECT EXISTS (SELECT 1 FROM spaces.wormholes WHERE short_id = ${shortId}) AS exists`;
      break;
  }
  return rows[0]?.exists ?? false;
};

const generateAvailableShortId = async (db: SqlExecutor, table: ShortIdTable): Promise<string> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const shortId = newShortId();
    if (!(await isTaken(db, table, shortId))) return shortId;
  }
  throw new Error(`Failed to allocate a short ID for ${table}`);
};

const selectMissing = async (db: SqlExecutor, table: ShortIdTable): Promise<{ id: string }[]> => {
  switch (table) {
    case "space":
      return db`SELECT id FROM spaces.spaces WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`;
    case "column":
      return db`SELECT id FROM spaces.columns WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`;
    case "item":
      return db`SELECT id FROM spaces.items WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`;
    case "attachment":
      return db`SELECT id FROM spaces.item_attachments WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`;
    case "checklist":
      return db`SELECT id FROM spaces.item_checklist_entries WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`;
    case "comment":
      return db`SELECT id FROM spaces.comments WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`;
    case "tag":
      return db`SELECT id FROM spaces.tags WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`;
    case "wormhole":
      return db`SELECT id FROM spaces.wormholes WHERE short_id IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`;
  }
};

const updateMissing = async (db: SqlExecutor, table: ShortIdTable, id: string, shortId: string): Promise<void> => {
  switch (table) {
    case "space":
      await db`UPDATE spaces.spaces SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "column":
      await db`UPDATE spaces.columns SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "item":
      await db`UPDATE spaces.items SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "attachment":
      await db`UPDATE spaces.item_attachments SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "checklist":
      await db`UPDATE spaces.item_checklist_entries SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "comment":
      await db`UPDATE spaces.comments SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "tag":
      await db`UPDATE spaces.tags SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "wormhole":
      await db`UPDATE spaces.wormholes SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
  }
};

export const backfillShortIds = async (table: ShortIdTable, db: SqlExecutor = sql): Promise<number> => {
  let filled = 0;
  for (;;) {
    const rows = await selectMissing(db, table);
    if (rows.length === 0) return filled;
    for (const row of rows) {
      const shortId = await generateAvailableShortId(db, table);
      await updateMissing(db, table, row.id, shortId);
      filled++;
    }
  }
};
