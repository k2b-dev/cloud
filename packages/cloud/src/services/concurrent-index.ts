import type { SQL } from "bun";
import { getProcessSync, lazySync } from "../_internal/process-sync";
import { sql } from "../runtime/clients";
import type { logger } from "./logging";
import { backgroundWork } from "./runtime-quiesce";

/**
 * An index built next to live writes. Queries must work without it; it only makes them faster. A UNIQUE index that a
 * transaction relies on is never one of these: the migration creates it before its first use, in its transaction
 * (`createIndexIfMissing` with `unique`).
 * `unique` is only for an index no transaction relies on before it is valid, such as a backstop of a rule that locks
 * already keep, or a feature that waits until the index is valid.
 */
export type ConcurrentIndex = {
  /** Index name without schema; Postgres creates it in the table's schema. */
  name: string;
  /** Schema-qualified table, e.g. `ai.conversations`. */
  table: string;
  /**
   * Everything after `ON <table>`: method, columns, order and an optional partial predicate. A constant of the code,
   * never request input; it reaches SQL as written, so a `;` is refused.
   */
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

const qualifiedTable = (table: string) => {
  const parts = table.split(".");
  return parts.length === 2 && parts.every((part) => IDENTIFIER.test(part));
};
const validIndex = (index: ConcurrentIndex) =>
  IDENTIFIER.test(index.name) && qualifiedTable(index.table) && !index.definition.includes(";");

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

/**
 * Unique indexes whose build found duplicate rows. Each later attempt would read the whole table and fail the same way,
 * so this process gives up on them; the next start tries once more.
 */
const duplicated = new Set<string>();
const sqlState = (error: unknown) => {
  const candidate = error as { errno?: unknown; code?: unknown } | null;
  return typeof candidate?.errno === "string" ? candidate.errno : typeof candidate?.code === "string" ? candidate.code : null;
};

const buildIndex = async (db: SQL, index: ConcurrentIndex, options: ConcurrentIndexOptions): Promise<ConcurrentIndexOutcome> => {
  const key = `${index.table}.${index.name}`;
  if (duplicated.has(key)) return "failed";
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
    if (index.unique && sqlState(error) === "23505") {
      duplicated.add(key);
      options.log.error(`The ${options.purpose} index cannot be built: rows that it would keep apart exist twice`, {
        index: index.name,
        error: message(error),
      });
    } else {
      options.log.warn(`The ${options.purpose} index was not built; queries run without it until the next attempt`, {
        index: index.name,
        error: message(error),
      });
    }
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
 * A build holds `SHARE UPDATE EXCLUSIVE` on its table for as long as it runs, so a migration of the same table never
 * takes a strong lock unconditionally: it adds a column or an index only when the catalog lacks it
 * (`addMissingColumns`, `createIndexIfMissing`), or the next start of another replica waits behind the build and every
 * write of the table waits behind that start.
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
      if (!validIndex(index)) throw new Error(`Invalid index name, table or definition: ${index.name} ON ${index.table}`);
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

/**
 * Runs `work` on a reserved connection under the lease of `table`, renewed every third of its lifetime while one long
 * statement runs; `busy` while another holder has it. Without a bound process sync it runs without the lease.
 */
const underTableLease = async (
  db: SQL,
  table: string,
  work: (connection: SQL) => Promise<ConcurrentIndexOutcome>,
): Promise<ConcurrentIndexOutcome> => {
  const lease = bound() ? buildLease() : null;
  const held = lease ? await lease.acquire({ resource: table }) : null;
  if (lease && !held) return "busy";
  // runtime-timer: renews the build lease while one statement runs; cleared when it ends.
  const renewal = lease && held ? setInterval(() => void lease.extend(held).catch(() => false), LEASE_MS / 3) : null;
  renewal?.unref();
  try {
    // Bun may pipeline ordinary pool queries behind long DDL; a reserved connection keeps them out of its wait.
    const connection = await db.reserve();
    try {
      return await work(connection);
    } finally {
      connection.release();
    }
  } finally {
    if (renewal) clearInterval(renewal);
    if (lease && held) await lease.release(held).catch(() => false);
  }
};

const buildTable = async (
  db: SQL,
  indexes: readonly ConcurrentIndex[],
  options: ConcurrentIndexOptions,
): Promise<ConcurrentIndexOutcome> => {
  return underTableLease(db, indexes[0]!.table, async (build) => {
    let outcome: ConcurrentIndexOutcome = "ready";
    for (const index of indexes) {
      const built = await buildIndex(build, index, options);
      if (built === "busy" || built === "failed") return built;
      if (built === "built") outcome = "built";
    }
    return outcome;
  });
};

const running = new Set<Promise<ConcurrentIndexOutcome>>();

/**
 * After `busy` (another build runs here or under another replica's lease), a background build tries again five times
 * over about ten minutes. Then it stops until the next start; a `failed` build is logged and not retried.
 */
const BUSY_RETRY_MS = [30_000, 60_000, 120_000, 180_000, 240_000] as const;
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    // A pause between bounded attempts, not a loop of its own; it never keeps the process alive.
    setTimeout(resolve, ms).unref();
  });

/** Resolves at once, or once maintenance stage „Ruhe“ ends: a background build starts nothing while the Cloud is quiet. */
export const untilResumed = (): Promise<void> =>
  backgroundWork.paused()
    ? new Promise((resolve) => {
        const stop = backgroundWork.onChange((paused) => {
          if (paused) return;
          stop();
          resolve();
        });
      })
    : Promise.resolve();

/**
 * Starts `ensureConcurrentIndexes` without waiting for it: the caller (a migration, an app's setup) returns at once and
 * queries run without the indexes until they are valid. A busy build is retried (`BUSY_RETRY_MS`), and no attempt starts
 * while the Cloud is in maintenance stage „Ruhe“. Startup never awaits the returned promise.
 */
export const buildConcurrentIndexesInBackground = (
  indexes: readonly ConcurrentIndex[],
  options: ConcurrentIndexOptions,
): Promise<ConcurrentIndexOutcome> => {
  const build = (async () => {
    await untilResumed();
    let outcome = await ensureConcurrentIndexes(indexes, options);
    for (const wait of BUSY_RETRY_MS) {
      if (outcome !== "busy") return outcome;
      await pause(wait);
      await untilResumed();
      outcome = await ensureConcurrentIndexes(indexes, options);
    }
    if (outcome === "busy") options.log.info(`The ${options.purpose} indexes are still being built elsewhere; the next start continues`);
    return outcome;
  })();
  running.add(build);
  void build.finally(() => running.delete(build));
  return build;
};

/**
 * Waits for the background builds this process started, at most `deadlineMs`. Only for a process that migrates and
 * then closes its database connections (the integration template builder, a test's teardown, one-off scripts); a
 * running app never waits for its builds. True when none is left.
 */
export const settleBackgroundIndexBuilds = async (deadlineMs = 60_000): Promise<boolean> => {
  const end = Date.now() + deadlineMs;
  while (running.size > 0) {
    const left = end - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...running]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
      }),
    ]);
    clearTimeout(timer);
  }
  return true;
};

/**
 * Adds the columns the table lacks, in one statement, and takes no lock at all when every column exists. `columns` maps
 * each name to its type and constraints, constants of the code. Use it for a table that a background build may hold
 * (`ensureConcurrentIndexes`); `ADD COLUMN IF NOT EXISTS` alone takes `ACCESS EXCLUSIVE` before it checks.
 */
export const addMissingColumns = async (db: SQL, table: string, columns: Readonly<Record<string, string>>): Promise<void> => {
  if (!qualifiedTable(table) || Object.entries(columns).some(([name, type]) => !IDENTIFIER.test(name) || type.includes(";")))
    throw new Error(`Invalid columns for ${table}`);
  const present = new Set(
    (
      await db<{ name: string }[]>`SELECT attname AS name FROM pg_catalog.pg_attribute
        WHERE attrelid = to_regclass(${table}) AND attnum > 0 AND NOT attisdropped`
    ).map((row) => row.name),
  );
  const missing = Object.entries(columns).filter(([name]) => !present.has(name));
  if (missing.length === 0) return;
  await db.unsafe(`ALTER TABLE ${table} ${missing.map(([name, type]) => `ADD COLUMN IF NOT EXISTS ${name} ${type}`).join(", ")}`).simple();
};

/**
 * Creates an ordinary index in the migration's transaction only when the catalog lacks it. `CREATE INDEX IF NOT EXISTS`
 * alone waits for the lock of a running concurrent build on the table even when the index exists.
 */
export const createIndexIfMissing = async (db: SQL, index: ConcurrentIndex): Promise<void> => {
  if (!validIndex(index)) throw new Error(`Invalid index: ${index.name} ON ${index.table}`);
  const [state] = await db<
    { present: boolean }[]
  >`SELECT to_regclass(${`${index.table.split(".")[0]}.${index.name}`}) IS NOT NULL AS present`;
  if (state?.present) return;
  await db
    .unsafe(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${index.name} ON ${index.table} ${index.definition}`)
    .simple();
};

/**
 * Drops an index with `DROP INDEX CONCURRENTLY` under the same lease per table as the builds, on a reserved connection.
 * It waits for every transaction that may use the index, so call it only from background work. Never throws.
 */
export const dropConcurrentIndex = async (
  index: Pick<ConcurrentIndex, "name" | "table">,
  options: ConcurrentIndexOptions,
): Promise<ConcurrentIndexOutcome> => {
  try {
    if (!IDENTIFIER.test(index.name) || !qualifiedTable(index.table)) throw new Error(`Invalid index: ${index.name} ON ${index.table}`);
    return await underTableLease(options.db ?? sql, index.table, async (db) => {
      await dropIndex(db, { ...index, definition: "" });
      return "ready";
    });
  } catch (error) {
    options.log.warn(`The ${options.purpose} index was not dropped; the next attempt retries`, {
      index: index.name,
      error: message(error),
    });
    return "failed";
  }
};
