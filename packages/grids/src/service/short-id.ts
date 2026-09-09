import { crypto } from "@k2b/stdlib";
import { isUniqueViolation } from "@k2b/cloud/services";
import type { SQL } from "bun";

/**
 * Canonical Grids public resource ID. Used to validate persisted short_ids
 * at the Zod-contract layer; mirrors the DB CHECK constraint applied
 * by the migration so the two layers can never disagree.
 */
export const SHORT_ID_LENGTH = 6;
export const SHORT_ID_REGEX = /^[A-Za-z0-9]{6}$/;

const MAX_ATTEMPTS = 10;

export const newShortId = (): string => crypto.common.readableId(SHORT_ID_LENGTH);

/**
 * Insert-with-random-short_id helper. Each grids resource (base / table /
 * field / form / view / Grids App) carries a readable `short_id` alongside
 * its private UUID. The short ID is the resource's only public identity.
 *
 * Unlike a check-then-insert pattern, this helper trusts the DB global
 * unique index as the only authoritative collision check — two
 * concurrent creates can race the JS-side check otherwise. We retry the
 * insert when the SPECIFIC short_id index name comes back as a 23505
 * unique violation; any other unique constraint (a real PK collision,
 * an FK, etc.) bubbles up as a real error.
 *
 * Collision math: 62^6 = 56.8B; even 1000 resources of one kind gives
 * a negligible birthday-paradox collision rate per try, so 10 attempts is
 * massive overkill — the loop exists strictly for paranoia.
 *
 * Why pass the index name explicitly: bun.sql / postgres surface the
 * constraint that fired. If we retried on every 23505 we would mask a
 * different unique-constraint bug (e.g. a duplicate name with a unique
 * index) as a short_id failure. Naming the short_id index keeps that
 * signal sharp.
 *
 * @param insert  Function that runs the INSERT for a candidate
 *                short_id and returns the inserted row. MUST throw on
 *                any failure (do not return null/undefined for "row
 *                missing").
 * @param uniqueIndexName  The name of the global unique index that
 *                guards short_id uniqueness for this resource (e.g.
 *                `idx_grids_bases_short_id`).
 */
export const insertWithShortId = async <T>(insert: (shortId: string) => Promise<T>, uniqueIndexName: string): Promise<T> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const shortId = newShortId();
    try {
      return await insert(shortId);
    } catch (e: unknown) {
      if (isUniqueViolation(e, uniqueIndexName)) continue;
      throw e;
    }
  }
  throw new Error(`short_id generation: ${MAX_ATTEMPTS} collisions in a row on ${uniqueIndexName} — scope is saturated or RNG is broken`);
};

type SavepointedSql = SQL & { savepoint: <T>(write: (db: SQL) => Promise<T>) => Promise<T> };

const isTransaction = (db: SQL): db is SavepointedSql => typeof (db as Partial<SavepointedSql>).savepoint === "function";

/** Keep a short-ID collision from aborting the caller's surrounding transaction. */
export const insertWithShortIdForDb = <T>(db: SQL, uniqueIndexName: string, insert: (db: SQL, shortId: string) => Promise<T>): Promise<T> =>
  insertWithShortId(
    (shortId) => (isTransaction(db) ? db.savepoint((attempt) => insert(attempt, shortId)) : insert(db, shortId)),
    uniqueIndexName,
  );
