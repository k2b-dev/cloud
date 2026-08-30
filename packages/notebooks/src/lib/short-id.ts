/**
 * Short-id generator + collision-aware uniqueness check, used for the
 * public identifiers for notebooks / notes / attachments.
 *
 * UUID stays as the canonical PK / FK target inside the DB. The
 * `short_id` column is the public resource identifier — it appears in URLs
 * (`/app/notebooks/{nbShortId}/notes/{noteShortId}`) and in markdown
 * body schemes (`[label](note://k2s8s6)`, `![](attach://sjss6s)`). The
 * mapping is shortId → uuid at every page-handler boundary; service
 * layer below the boundary continues to use UUIDs end-to-end.
 *
 * Format: 6 characters from `crypto.common.readableId` (≈ 27.7 billion
 * combinations). At our scale (millions of rows max) the
 * birthday-paradox collision probability is negligible, but we still
 * use a `UNIQUE` index + `EXISTS`-check loop to be absolutely safe.
 *
 * Mirrors the slug helper in `packages/grids/src/service/slug.ts`,
 * which uses 5-char per-scope slugs. We use 6 here because notebooks,
 * notes and attachments live in a single global scope (one short-id
 * column per table, no compound uniqueness).
 */
import { crypto } from "@k2b/stdlib";
import { sql } from "bun";

/** Length of the generated readable ID. */
const SHORT_ID_LEN = 6;

/** Cap on retries before giving up — pure paranoia, in practice the
 *  loop never exits past attempt 0 because the keyspace is huge. */
const MAX_ATTEMPTS = 10;

/** Anchored public short-id format. */
export const SHORT_ID_REGEX = /^[0-9a-zA-Z]{6}$/;

/**
 * Tables that carry a public `short_id` column. Each entry pairs the
 * caller-facing tag with the SQL-side identity used by the existence
 * check + the backfill update. Adding a new short-id-bearing table is
 * a one-line change.
 *
 * Per-table queries are inlined (rather than templated through a
 * dynamic identifier) because Bun's `sql` tag doesn't safely
 * interpolate identifiers — and we want to keep the call sites
 * parameterized for the candidate value.
 */
export type ShortIdTable = "notebook" | "note" | "attachment" | "comment";

/**
 * Generate a short-id that doesn't collide with an existing row in the
 * named table. The `EXISTS` query is cheap because `short_id` has a
 * UNIQUE index. Throws after `MAX_ATTEMPTS` collisions (which, given
 * the 55^6 ≈ 27.7 B keyspace, would indicate a systemic problem).
 */
export const generateUniqueShortId = async (table: ShortIdTable): Promise<string> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = crypto.common.readableId(SHORT_ID_LEN);
    const taken = await isShortIdTaken(table, candidate);
    if (!taken) return candidate;
  }
  throw new Error(`Failed to generate a unique short_id for ${table} after ${MAX_ATTEMPTS} attempts`);
};

const isShortIdTaken = async (table: ShortIdTable, candidate: string): Promise<boolean> => {
  switch (table) {
    case "notebook": {
      const [r] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM notebooks.notebooks WHERE short_id = ${candidate}) AS "exists"
      `;
      return r?.exists ?? false;
    }
    case "note": {
      const [r] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM notebooks.notes WHERE short_id = ${candidate}) AS "exists"
      `;
      return r?.exists ?? false;
    }
    case "attachment": {
      const [r] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM notebooks.attachments WHERE short_id = ${candidate}) AS "exists"
      `;
      return r?.exists ?? false;
    }
    case "comment": {
      const [r] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM notebooks.note_comments WHERE short_id = ${candidate}) AS "exists"
      `;
      return r?.exists ?? false;
    }
  }
};

/**
 * Backfill rows that were created before the `short_id` column existed
 * (or before this code path was deployed). Idempotent: if no rows have
 * NULL short_id, the COUNT-checked SELECT exits immediately.
 *
 * Read all NULL-short-id ids in one query, then for each row generate
 * a unique short-id and UPDATE individually. Per-row trips sound slow
 * but at our scale (low thousands of rows backfilled exactly once on
 * first deploy) it's well below 1 s and avoids the complexity of
 * generating-then-deduping a batch.
 */
export const backfillShortIds = async (table: ShortIdTable): Promise<number> => {
  const rows = await selectNullShortIdRows(table);
  if (rows.length === 0) return 0;

  let filled = 0;
  for (const { id } of rows) {
    const shortId = await generateUniqueShortId(table);
    await updateShortId(table, id, shortId);
    filled++;
  }
  return filled;
};

const selectNullShortIdRows = async (table: ShortIdTable): Promise<{ id: string }[]> => {
  switch (table) {
    case "notebook":
      return sql<{ id: string }[]>`SELECT id FROM notebooks.notebooks WHERE short_id IS NULL`;
    case "note":
      return sql<{ id: string }[]>`SELECT id FROM notebooks.notes WHERE short_id IS NULL`;
    case "attachment":
      return sql<{ id: string }[]>`SELECT id FROM notebooks.attachments WHERE short_id IS NULL`;
    case "comment":
      return sql<{ id: string }[]>`SELECT id FROM notebooks.note_comments WHERE short_id IS NULL`;
  }
};

const updateShortId = async (table: ShortIdTable, id: string, shortId: string): Promise<void> => {
  switch (table) {
    case "notebook":
      await sql`UPDATE notebooks.notebooks SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "note":
      await sql`UPDATE notebooks.notes SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "attachment":
      await sql`UPDATE notebooks.attachments SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
    case "comment":
      await sql`UPDATE notebooks.note_comments SET short_id = ${shortId} WHERE id = ${id}::uuid AND short_id IS NULL`;
      return;
  }
};
