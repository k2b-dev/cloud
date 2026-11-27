import type { SQL } from "bun";
import { getProcessSync, lazySync } from "../_internal/process-sync";
import { sql } from "../runtime/clients";
import type { logger } from "./logging";

/** An index built next to live writes. Queries must work without it; it only makes them faster. */
export type ConcurrentIndex = {
  /** Index name without schema; Postgres creates it in the table's schema. */
  name: string;
  /** Schema-qualified table, e.g. `ai.conversations`. */
  table: string;
  /** Everything after `ON <table>`: method, columns, order and an optional partial predicate. */
  definition: string;
  unique?: boolean;
};

/**
 * `ready`: every index was valid already. `built`: this call built at least one. `busy`: another build runs (in this
 * database, or under the lease of another replica); the next attempt continues. `failed`: logged; queries run without
 * the index until the next attempt.
 */
export type ConcurrentIndexOutcome = "ready" | "built" | "busy" | "failed";

export type ConcurrentIndexOptions = {
  log: ReturnType<typeof logger>;
  /** What the indexes are for, in the log lines ("sidebar chats", "send log search"). */
  purpose: string;
  db?: SQL;
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
// Long enough for a renewal every third of it; a crashed holder frees the table after it.
const LEASE_MS = 60_000;

/** One build per table across every replica of every app: two builds on one table wait for each other. */
const buildLease = lazySync((sync) => sync.mutex({ id: "cloud:concurrent-index-build", ttlMs: LEASE_MS, retry: { maxAttempts: 1 } }));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readIndex = async (db: SQL, index: ConcurrentIndex) => {
  const schema = index.table.split(".")[0]!;
  const qualified = `${schema}.${index.name}`;
  // `relid IS NULL`: Postgres hides the table of a build that another role runs, so any such build counts.
  const [state] = await db<{ present: boolean; valid: boolean; building: boolean }[]>`
    SELECT to_regclass(${qualified}) IS NOT NULL AS present,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = to_regclass(${qualified})
        AND indisvalid AND indisready AND indislive) AS valid,
      EXISTS (SELECT 1 FROM pg_catalog.pg_stat_progress_create_index progress
        WHERE progress.datname = pg_catalog.current_database()
          AND (progress.relid = to_regclass(${index.table}) OR progress.relid IS NULL)) AS building`;
  return state ?? { present: false, valid: false, building: false };
};

const dropIndex = (db: SQL, index: ConcurrentIndex) =>
  db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${index.table.split(".")[0]}.${index.name}`).simple();

const buildIndex = async (db: SQL, index: ConcurrentIndex, options: ConcurrentIndexOptions): Promise<ConcurrentIndexOutcome> => {
  const before = await readIndex(db, index);
  if (before.valid) return "ready";
  if (before.building) return "busy";
  // IF NOT EXISTS would keep an invalid index, such as one whose build was interrupted.
  if (before.present) await dropIndex(db, index);
  const startedAt = performance.now();
  try {
    await db
      .unsafe(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ON ${index.table} ${index.definition}`)
      .simple();
  } catch (error) {
    const after = await readIndex(db, index);
    if (after.valid) return "ready";
    if (after.building) return "busy";
    options.log.warn(`The ${options.purpose} index was not built; queries run without it until the next attempt`, {
      index: index.name,
      error: message(error),
    });
    if (after.present) await dropIndex(db, index);
    return "failed";
  }
  // IF NOT EXISTS skips the build when another one created the index meanwhile; it counts only once valid.
  if (!(await readIndex(db, index)).valid) return "busy";
  options.log.info(`Built the ${options.purpose} index`, { index: index.name, durationMs: Math.round(performance.now() - startedAt) });
  return "built";
};

/**
 * Builds the indexes with `CREATE INDEX CONCURRENTLY`, one table at a time across every replica (a NATS lease per
 * table), on a reserved connection outside any transaction, so ordinary pool queries never wait behind the build's
 * snapshot wait. A valid index is kept, an invalid leftover of an interrupted build is dropped and built again, and a
 * build that runs elsewhere is left alone. Never throws: a failure is logged and the next attempt continues.
 *
 * A build waits for every older snapshot, so a long transaction (a nightly dump) can hold it for hours. Startup must
 * never wait for it: start it with `buildConcurrentIndexesInBackground` after the migration. Await this only from work
 * that already runs in the background, such as a sweep that skips while its index is missing.
 *
 * Without a bound process sync (one process, as in tests and one-off scripts) it builds without the lease; the check for
 * a running build still leaves another build alone.
 */
export const ensureConcurrentIndexes = async (
  indexes: readonly ConcurrentIndex[],
  options: ConcurrentIndexOptions,
): Promise<ConcurrentIndexOutcome> => {
  try {
    for (const index of indexes) {
      if (!IDENTIFIER.test(index.name) || !index.table.split(".").every((part) => IDENTIFIER.test(part)) || !index.table.includes(".")) {
        throw new Error(`Invalid index name or table: ${index.name} ON ${index.table}`);
      }
    }
    const db = options.db ?? sql;
    const states = await Promise.all(indexes.map((index) => readIndex(db, index)));
    if (states.every((state) => state.valid)) return "ready";
    let outcome: ConcurrentIndexOutcome = "ready";
    for (const table of new Set(indexes.map((index) => index.table))) {
      const built = await buildTable(
        db,
        indexes.filter((index) => index.table === table),
        options,
      );
      if (built === "busy" || built === "failed") return built;
      if (built === "built") outcome = "built";
    }
    return outcome;
  } catch (error) {
    options.log.warn(`The ${options.purpose} indexes are unavailable; queries run without them until the next attempt`, {
      error: message(error),
    });
    return "failed";
  }
};

const bound = () => {
  try {
    getProcessSync();
    return true;
  } catch {
    return false;
  }
};

const buildTable = async (
  db: SQL,
  indexes: readonly ConcurrentIndex[],
  options: ConcurrentIndexOptions,
): Promise<ConcurrentIndexOutcome> => {
  const lease = bound() ? buildLease() : null;
  const held = lease ? await lease.acquire({ resource: indexes[0]!.table }) : null;
  if (lease && !held) return "busy";
  // runtime-timer: renews the build lease while one statement runs; cleared when it ends.
  const renewal = lease && held ? setInterval(() => void lease.extend(held).catch(() => false), LEASE_MS / 3) : null;
  renewal?.unref();
  try {
    // Bun may pipeline ordinary pool queries behind long DDL; a reserved connection keeps them out of its wait.
    const build = await db.reserve();
    try {
      let outcome: ConcurrentIndexOutcome = "ready";
      for (const index of indexes) {
        const built = await buildIndex(build, index, options);
        if (built === "busy" || built === "failed") return built;
        if (built === "built") outcome = "built";
      }
      return outcome;
    } finally {
      build.release();
    }
  } finally {
    if (renewal) clearInterval(renewal);
    if (lease && held) await lease.release(held).catch(() => false);
  }
};

const running = new Set<Promise<ConcurrentIndexOutcome>>();

/**
 * Starts `ensureConcurrentIndexes` without waiting for it: the caller (a migration, an app's setup) returns at once and
 * queries run without the indexes until they are valid. Startup never awaits the returned promise.
 */
export const buildConcurrentIndexesInBackground = (
  indexes: readonly ConcurrentIndex[],
  options: ConcurrentIndexOptions,
): Promise<ConcurrentIndexOutcome> => {
  const build = ensureConcurrentIndexes(indexes, options);
  running.add(build);
  void build.finally(() => running.delete(build));
  return build;
};

/**
 * Waits for the background builds this process started. Only for a process that migrates and then closes its database
 * connections (the integration template builder, one-off scripts); a running app never waits for its builds.
 */
export const settleBackgroundIndexBuilds = async (): Promise<void> => {
  while (running.size > 0) await Promise.allSettled([...running]);
};
