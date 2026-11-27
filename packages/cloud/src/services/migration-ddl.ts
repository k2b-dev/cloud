import type { SQL, TransactionSQL } from "bun";
import { logger } from "./logging";
import { toPgTextArray } from "./postgres";

/**
 * Startup DDL that leaves live writers alone. Postgres takes the table lock of `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
 * (ACCESS EXCLUSIVE), `CREATE INDEX IF NOT EXISTS` (SHARE) and `DROP TRIGGER IF EXISTS` before it checks whether the
 * object exists. Such a statement waits behind a dump, an index build or a long transaction, and every reader or writer
 * of the table queues behind the waiting statement. These helpers read the catalog first: when nothing changes, as on
 * every start after the first, they take no table lock. A change runs in a short transaction that waits at most
 * {@link MIGRATION_LOCK_WAIT_MS} for its lock and retries with backoff.
 */

const log = logger("cloud:migrations");

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/**
 * How long one attempt waits for its table lock, which is also the longest a writer queues behind it. It exceeds
 * Postgres's default `deadlock_timeout` (1 s), after which Postgres cancels an autovacuum that blocks the lock.
 */
export const MIGRATION_LOCK_WAIT_MS = 2_000;
// 8 attempts and 7 pauses of 0.25 s to 8 s: about 40 s in all, well inside the 180 s that the Compose health checks
// give a start. The start then fails with the lock holders in its error, and the next start tries again.
const ATTEMPTS = 8;
const pause = (attempt: number) => Math.min(250 * 2 ** (attempt - 1), 8_000);
const RETRIED = new Set(["55P03", "40P01"]);

/** Column name to its definition after the name, such as `{ archived_at: "TIMESTAMPTZ" }`. Code constants only. */
export type MigrationColumns = Record<string, string>;

/** An index created without CONCURRENTLY. Code constants only. */
export type MigrationIndex = {
  /** Index name without schema; Postgres creates it in the table's schema. */
  name: string;
  /** Everything after `ON <table>`: method, columns, order and an optional partial predicate. */
  definition: string;
  unique?: boolean;
};

const assertTable = (table: string) => {
  if (!TABLE.test(table)) throw new Error(`Migration table must be a schema-qualified plain identifier: ${table}`);
};

const assertIdentifier = (name: string) => {
  if (!IDENTIFIER.test(name)) throw new Error(`Migration identifier must be a plain lowercase Postgres identifier: ${name}`);
};

/** Bun reports the SQLSTATE as `errno`, other drivers as `code`. */
const sqlState = (error: unknown): string | null => {
  const candidate = error as { code?: unknown; errno?: unknown } | null;
  if (typeof candidate?.errno === "string") return candidate.errno;
  return typeof candidate?.code === "string" ? candidate.code : null;
};

/**
 * A lock timeout, a deadlock, or a concurrent `CREATE INDEX IF NOT EXISTS` of the same name in another session:
 * both pass the existence check, and the later one fails on the catalog's unique name instead of waiting.
 */
const retryable = (error: unknown) => {
  const state = sqlState(error);
  if (state === "23505") {
    const candidate = error as { constraint?: unknown; constraint_name?: unknown };
    return (candidate.constraint ?? candidate.constraint_name) === "pg_class_relname_nsp_index";
  }
  return RETRIED.has(state ?? "");
};

/** A Bun transaction or savepoint client; the pool and reserved connections have no `savepoint`. */
const inTransaction = (db: SQL): db is TransactionSQL => "savepoint" in db;

/** Who holds a lock on the tables, for the log line: `pg_dump (pid 812, AccessShareLock on ai.conversations, 95 s)`. */
const lockHolders = async (db: SQL, tables: readonly string[]): Promise<string[]> => {
  try {
    const rows = await db<{ pid: number; mode: string; relation: string; client: string; seconds: number | null }[]>`
      SELECT l.pid, l.mode, l.relation::regclass::text AS relation,
        COALESCE(NULLIF(a.application_name, ''), a.backend_type, 'unknown') AS client,
        floor(extract(epoch FROM now() - a.xact_start))::int AS seconds
      FROM pg_catalog.pg_locks l
      LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_backend_pid()
        AND l.relation IN (SELECT to_regclass(name) FROM unnest(${toPgTextArray([...tables])}::text[]) AS name)
      ORDER BY a.xact_start NULLS LAST
      LIMIT 5`;
    return rows.map(
      (row) => `${row.client} (pid ${row.pid}, ${row.mode} on ${row.relation}${row.seconds === null ? "" : `, ${row.seconds} s`})`,
    );
  } catch {
    return [];
  }
};

/**
 * Runs DDL that needs a lock on `table` (or on each of several tables) so it never queues their readers and writers for
 * long. On the pool it runs in its own transaction with `lock_timeout` {@link MIGRATION_LOCK_WAIT_MS}, retries a lock
 * timeout or deadlock with backoff and logs each wait with the lock holders; after about 40 s it throws. A migration
 * that keeps several steps in one transaction passes the pool and runs them all in `run`. Inside a caller's
 * transaction it runs there once: that transaction must bound its own wait with `SET LOCAL lock_timeout` and retry as
 * a whole. Gate the statements on the catalog, so that a start without changes takes no lock; `run` may run several
 * times.
 */
export const withTableLock = async (
  db: SQL,
  table: string | readonly string[],
  run: (tx: TransactionSQL) => Promise<unknown>,
): Promise<void> => {
  const tables = typeof table === "string" ? [table] : table;
  for (const name of tables) assertTable(name);
  if (inTransaction(db)) {
    await run(db);
    return;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_WAIT_MS}ms'`).simple();
        await run(tx);
      });
      return;
    } catch (error) {
      if (!retryable(error)) throw error;
      const holders = await lockHolders(db, tables);
      if (attempt >= ATTEMPTS) {
        throw new Error(
          `Migration could not lock ${tables.join(", ")} in ${ATTEMPTS} attempts; held by ${holders.join(", ") || "a session that ended meanwhile"}`,
          { cause: error },
        );
      }
      log.warn("Migration waits for a table lock and tries again", { table: tables.join(", "), attempt, holders: holders.join(", ") });
      await Bun.sleep(pause(attempt));
    }
  }
};

const missingColumns = async (db: SQL, table: string, names: string[]) =>
  (
    await db<{ name: string }[]>`
      SELECT name FROM unnest(${toPgTextArray(names)}::text[]) WITH ORDINALITY AS wanted(name, position)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = to_regclass(${table}) AND attname = wanted.name AND attnum > 0 AND NOT attisdropped
      )
      ORDER BY position`
  ).map((row) => row.name);

/**
 * Adds the columns that `table` lacks, in one statement, and returns their names. Without a missing column it takes no
 * table lock. Replaces `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in startup migrations.
 */
export const addColumns = async (db: SQL, table: string, columns: MigrationColumns): Promise<string[]> => {
  assertTable(table);
  const names = Object.keys(columns);
  for (const name of names) assertIdentifier(name);
  if (names.length === 0 || (await missingColumns(db, table, names)).length === 0) return [];
  let added: string[] = [];
  await withTableLock(db, table, async (tx) => {
    // Another replica may have added some meanwhile.
    added = await missingColumns(tx, table, names);
    if (added.length === 0) return;
    await tx.unsafe(`ALTER TABLE ${table} ${added.map((name) => `ADD COLUMN IF NOT EXISTS ${name} ${columns[name]}`).join(", ")}`).simple();
  });
  return added;
};

const triggerDefinition = async (db: SQL, table: string, name: string) => {
  const [trigger] = await db<{ definition: string }[]>`
    SELECT pg_get_triggerdef(oid) AS definition FROM pg_catalog.pg_trigger
    WHERE tgrelid = to_regclass(${table}) AND tgname = ${name} AND NOT tgisinternal`;
  return trigger?.definition ?? null;
};

/**
 * Creates trigger `name` with `definition`, or replaces it when Postgres reports another definition, and returns whether
 * it did. Without a change it takes no table lock. Replaces `DROP TRIGGER IF EXISTS` plus `CREATE TRIGGER`. Write
 * `definition` the way `pg_get_triggerdef()` prints it; any other spelling replaces the trigger on every start, which
 * the helper logs.
 */
export const replaceTrigger = async (db: SQL, table: string, name: string, definition: string): Promise<boolean> => {
  assertTable(table);
  assertIdentifier(name);
  if ((await triggerDefinition(db, table, name)) === definition) return false;
  let replaced = false;
  await withTableLock(db, table, async (tx) => {
    replaced = false;
    if ((await triggerDefinition(tx, table, name)) === definition) return;
    await tx.unsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`).simple();
    await tx.unsafe(definition).simple();
    replaced = true;
    const stored = await triggerDefinition(tx, table, name);
    if (stored !== definition) {
      log.warn("Trigger definition differs from pg_get_triggerdef(); every start replaces it", { table, trigger: name, stored });
    }
  });
  return replaced;
};

const missingIndexes = async (db: SQL, table: string, indexes: readonly MigrationIndex[]) => {
  const schema = table.split(".")[0]!;
  const present = new Set(
    (
      await db<{ name: string }[]>`
        SELECT name FROM unnest(${toPgTextArray(indexes.map((index) => index.name))}::text[]) AS wanted(name)
        WHERE to_regclass(${schema} || '.' || wanted.name) IS NOT NULL`
    ).map((row) => row.name),
  );
  return indexes.filter((index) => !present.has(index.name));
};

/**
 * Creates the indexes that `table` lacks and returns their names. Without a missing index it takes no table lock.
 * Replaces `CREATE INDEX IF NOT EXISTS` in startup migrations. The build blocks the table's writers while it runs, so
 * use it for a new or small table; an index on a large live table is built concurrently in the background instead.
 */
export const createIndexes = async (db: SQL, table: string, indexes: readonly MigrationIndex[]): Promise<string[]> => {
  assertTable(table);
  for (const index of indexes) assertIdentifier(index.name);
  if (indexes.length === 0 || (await missingIndexes(db, table, indexes)).length === 0) return [];
  let created: string[] = [];
  await withTableLock(db, table, async (tx) => {
    const missing = await missingIndexes(tx, table, indexes);
    created = missing.map((index) => index.name);
    for (const index of missing) {
      await tx.unsafe(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${index.name} ON ${table} ${index.definition}`).simple();
    }
  });
  return created;
};
