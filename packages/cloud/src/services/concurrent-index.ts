import type { SQL } from "bun";
import { getProcessSync, lazySync } from "../_internal/process-sync";
import { sql } from "../runtime/clients";
import type { logger } from "./logging";
import { backgroundWork } from "./runtime-quiesce";

/**
 * An index built next to live writes. Queries must work without it; it only makes them faster. A UNIQUE index that a
 * transaction relies on is never one of these: the migration creates it before its first use, in its transaction
 * (`createIndexIfMissing` with `unique`).
 */
export type ConcurrentIndex = {
  /** Index name without schema; Postgres creates it in the table's schema. */
  name: string;
  /** Schema-qualified table, e.g. `ai.conversations`. */
  table: string;
  /**
   * Everything after `ON <table>`: method, columns, order and, without `where`, an optional partial predicate. A
   * constant of the code, never request input; it reaches SQL as written, so `;` and comments are refused.
   */
  definition: string;
  /**
   * The predicate of a partial index, without `WHERE`, under the same rule as `definition`; `definition` then has no
   * `WHERE` of its own. Required for a partial index on a TimescaleDB hypertable, whose build options stand between the
   * columns and the predicate.
   */
  where?: string;
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
/** One clause as written: no second statement and no comment that could hide the rest of it. */
const oneClause = (text: string) => !/;|--|\/\*/.test(text);
const INLINE_WHERE = /\bwhere\b/i;
const validIndex = (index: ConcurrentIndex) =>
  IDENTIFIER.test(index.name) &&
  qualifiedTable(index.table) &&
  oneClause(index.definition) &&
  (index.where === undefined || (oneClause(index.where) && !INLINE_WHERE.test(index.definition)));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * How long a build on a TimescaleDB hypertable waits for a lock before it gives up as `busy`. A waiting build queues
 * every new write to the table behind it, so it waits no longer than the log retention's background statements.
 */
const HYPERTABLE_LOCK_TIMEOUT = "1s";
/** Postgres' `lock_not_available`: the build met `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";
/** Postgres' `deadlock_detected`: another session, such as autovacuum on a chunk, held a lock the statement needed. */
const DEADLOCK_DETECTED = "40P01";
/** The SQLSTATE of a Postgres error, as Bun reports it in `errno`. */
const sqlState = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "errno" in error ? String(error.errno) : undefined;

const readIndex = async (db: SQL, index: ConcurrentIndex) => {
  const schema = index.table.split(".")[0]!;
  const qualified = `${schema}.${index.name}`;
  // `relid IS NULL`: Postgres hides the table of a build that another role runs, so any such build counts. TimescaleDB
  // reports no progress while it indexes a hypertable chunk by chunk; that build holds a share lock on the chunk it
  // indexes, so another session's granted share lock on a chunk of the table counts as a build too.
  const [state] = await db<{ present: boolean; valid: boolean; building: boolean; timescale: boolean }[]>`
    SELECT to_regclass(${qualified}) IS NOT NULL AS present,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = to_regclass(${qualified})
        AND indisvalid AND indisready AND indislive) AS valid,
      EXISTS (SELECT 1 FROM pg_catalog.pg_stat_progress_create_index progress
        WHERE progress.datname = pg_catalog.current_database()
          AND (progress.relid = to_regclass(${index.table}) OR progress.relid IS NULL))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_locks lock
        JOIN pg_catalog.pg_inherits child ON child.inhrelid = lock.relation
        WHERE child.inhparent = to_regclass(${index.table}) AND lock.locktype = 'relation' AND lock.mode = 'ShareLock'
          AND lock.granted AND lock.pid <> pg_catalog.pg_backend_pid()) AS building,
      EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'timescaledb') AS timescale`;
  return state ?? { present: false, valid: false, building: false, timescale: false };
};

/** Whether the optional TimescaleDB made the table a hypertable, which takes no `CREATE INDEX CONCURRENTLY`. */
const isHypertable = async (db: SQL, table: string) => {
  const [schema, name] = table.split(".");
  const [row] = await db<{ yes: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
      WHERE hypertable_schema = ${schema!} AND hypertable_name = ${name!}) AS yes`;
  return row?.yes === true;
};

/**
 * The build statement. A hypertable is indexed chunk by chunk, each chunk in its own transaction, as TimescaleDB offers
 * instead of CONCURRENTLY; its options stand between the columns and the predicate, so its predicate must be `where`.
 */
const createStatement = (index: ConcurrentIndex, hypertable: boolean) => {
  const predicate = index.where ? ` WHERE ${index.where}` : "";
  return hypertable
    ? `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table} ${index.definition} WITH (timescaledb.transaction_per_chunk)${predicate}`
    : `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ON ${index.table} ${index.definition}${predicate}`;
};

/**
 * Runs one statement on the reserved connection. On a hypertable, where a build and a drop lock each chunk against
 * reads or writes and queue every later query while they wait, it waits at most `HYPERTABLE_LOCK_TIMEOUT` for each lock
 * and resets the setting before the connection goes back to the pool, so no later query inherits it.
 */
const underLockTimeout = async (db: SQL, statement: string, hypertable: boolean) => {
  if (!hypertable) return db.unsafe(statement).simple();
  await db.unsafe(`SET lock_timeout = '${HYPERTABLE_LOCK_TIMEOUT}'`).simple();
  try {
    return await db.unsafe(statement).simple();
  } finally {
    await db.unsafe("RESET lock_timeout").simple();
  }
};

/**
 * Drops a leftover, an invalid or half-built index. On a hypertable `DROP INDEX CONCURRENTLY` takes `ACCESS EXCLUSIVE`
 * on each chunk, so it waits no longer than a build. `busy` when it met a lock or a deadlock: the next attempt drops it.
 */
const dropLeftover = async (
  db: SQL,
  index: ConcurrentIndex,
  hypertable: boolean,
  options: ConcurrentIndexOptions,
): Promise<"dropped" | "busy"> => {
  try {
    await underLockTimeout(db, `DROP INDEX CONCURRENTLY IF EXISTS ${index.table.split(".")[0]}.${index.name}`, hypertable);
    return "dropped";
  } catch (error) {
    const state = sqlState(error);
    if (state !== DEADLOCK_DETECTED && state !== LOCK_NOT_AVAILABLE) throw error;
    options.log.info(`The ${options.purpose} index's leftover waits for a lock; the next attempt drops it`, { index: index.name });
    return "busy";
  }
};

const buildIndex = async (db: SQL, index: ConcurrentIndex, options: ConcurrentIndexOptions): Promise<ConcurrentIndexOutcome> => {
  const before = await readIndex(db, index);
  if (before.valid) return "ready";
  if (before.building) return "busy";
  const hypertable = before.timescale && (await isHypertable(db, index.table));
  if (hypertable && !index.where && INLINE_WHERE.test(index.definition)) {
    options.log.warn(`The ${options.purpose} index needs its predicate in \`where\` on a hypertable; it was not built`, {
      index: index.name,
    });
    return "failed";
  }
  // IF NOT EXISTS would keep an invalid index, such as one whose build was interrupted.
  if (before.present && (await dropLeftover(db, index, hypertable, options)) === "busy") return "busy";
  const startedAt = performance.now();
  try {
    await underLockTimeout(db, createStatement(index, hypertable), hypertable);
  } catch (error) {
    const after = await readIndex(db, index);
    if (after.valid) return "ready";
    if (after.building) return "busy";
    // a write the build would have queued behind: give way, and leave no half-built index for the planner to skip
    const gaveWay = hypertable && sqlState(error) === LOCK_NOT_AVAILABLE;
    if (gaveWay) {
      options.log.info(`The ${options.purpose} index waits for a moment without writes; the next attempt continues`, { index: index.name });
    } else {
      options.log.warn(`The ${options.purpose} index was not built; queries run without it until the next attempt`, {
        index: index.name,
        error: message(error),
      });
    }
    if (after.present && (await dropLeftover(db, index, hypertable, options)) === "busy") return "busy";
    return gaveWay ? "busy" : "failed";
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
 *
 * Where the optional TimescaleDB made the table a hypertable, which refuses CONCURRENTLY, it indexes the table chunk by
 * chunk instead (`timescaledb.transaction_per_chunk`). That build locks the chunk it indexes against writes while it
 * runs and queues every write while it waits for a lock, so it waits for a lock at most `HYPERTABLE_LOCK_TIMEOUT` and
 * then gives up as `busy`. A partial index on a hypertable takes its predicate in `where`.
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
const untilResumed = (): Promise<void> =>
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
export const createIndexIfMissing = async (db: SQL, index: ConcurrentIndex & { unique?: boolean }): Promise<void> => {
  if (!validIndex(index)) throw new Error(`Invalid index: ${index.name} ON ${index.table}`);
  const [state] = await db<
    { present: boolean }[]
  >`SELECT to_regclass(${`${index.table.split(".")[0]}.${index.name}`}) IS NOT NULL AS present`;
  if (state?.present) return;
  await db
    .unsafe(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${index.name} ON ${index.table} ${index.definition}`)
    .simple();
};
