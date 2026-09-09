import { logger } from "@k2b/cloud/services";
import { type SQL, sql } from "bun";
import { isMultiSelectField } from "./field-storage";

const log = logger("grids:field-indexes");

/**
 * Per-field expression index management. Indexes are opt-in (`field.indexed`)
 * and built with `CONCURRENTLY` so they don't lock writers on large tables.
 *
 * Index names: `idx_grids_data_<fieldId-no-dashes>` keeps us under Postgres'
 * 63-char identifier limit (32 hex chars + prefix = ~52). Performance indexes
 * are partial by table + live records only. Do NOT add `data ? fieldId` here:
 * the hot query compilers do not emit that predicate, so Postgres cannot prove
 * the partial index applies and falls back to seq scans on 100k+ rows.
 */

export const fieldPerformanceIndexName = (fieldId: string): string => `idx_grids_data_${fieldId.replace(/-/g, "")}`;
export const fieldReverseSortIndexName = (fieldId: string): string => `idx_grids_data_rev_${fieldId.replace(/-/g, "")}`;
export const fieldPlannerStatisticsName = (fieldId: string): string => `st_grids_data_${fieldId.replace(/-/g, "")}`;
const trgmIndexName = (fieldId: string): string => `idx_grids_trgm_${fieldId.replace(/-/g, "")}`;
export const fieldUniqueIndexName = (fieldId: string): string => `uq_grids_data_${fieldId.replace(/-/g, "")}`;
const dynamicFieldIndexPattern = /^(?:idx_grids_data_rev_|idx_grids_data_|idx_grids_trgm_|uq_grids_data_)([a-f0-9]{32})$/;
const dynamicFieldStatisticsPattern = /^st_grids_data_([a-f0-9]{32})$/;

/** Strict UUID-with-or-without-dashes validator. Used as the safety
 *  gate before embedding fieldId in DDL identifiers. */
const isSafeFieldId = (fieldId: string): boolean => /^[a-f0-9-]+$/i.test(fieldId);

const indexExpressionForType = (fieldId: string, type: string, config?: Record<string, unknown>): string | null => {
  switch (type) {
    case "number":
    case "percent":
    case "duration":
      // All numeric field types share the numeric expression index.
      return `grids.canonical_numeric(data->>'${fieldId}')`;
    case "date":
      return (config as { includeTime?: boolean } | undefined)?.includeTime
        ? `grids.canonical_timestamptz(data->>'${fieldId}')`
        : `grids.canonical_date(data->>'${fieldId}')`;
    case "boolean":
      return `grids.canonical_boolean(data->>'${fieldId}')`;
    case "text":
    case "longtext":
    case "id":
      return `data->>'${fieldId}'`;
    case "select":
      return isMultiSelectField({ type, config: config ?? {} }) ? null : `data->'${fieldId}'->>0`;
    default:
      return null;
  }
};

const fieldIndexWhere = (_fieldId: string, tableId: string): string => `WHERE table_id = '${tableId}'::uuid AND deleted_at IS NULL`;

const withIndexMaintenanceConnection = async <T>(db: SQL, run: (connection: SQL) => Promise<T>): Promise<T> => {
  const connection = await db.reserve();
  let originalTimeout = "0";
  let reusable = true;
  try {
    const [settings] = await connection<Array<{ statementTimeout: string }>>`
      SELECT current_setting('statement_timeout') AS "statementTimeout"
    `;
    originalTimeout = settings?.statementTimeout ?? originalTimeout;
    await connection`SELECT set_config('statement_timeout', '5min', FALSE)`;
    return await run(connection);
  } finally {
    try {
      await connection`SELECT set_config('statement_timeout', ${originalTimeout}, FALSE)`;
    } catch {
      reusable = false;
      await connection.close({ timeout: 0 }).catch(() => undefined);
    }
    if (reusable) connection.release();
  }
};

const createForwardSortIndex = async (fieldId: string, tableId: string, expression: string, db: SQL = sql): Promise<boolean> => {
  const idx = fieldPerformanceIndexName(fieldId);
  try {
    await db.unsafe(
      `CREATE INDEX CONCURRENTLY ${idx}
       ON grids.records ((${expression}), id)
       ${fieldIndexWhere(fieldId, tableId)}`,
    );
    log.info("Created expression index", { fieldId, tableId, idx });
    return true;
  } catch (error) {
    log.error("Failed to create expression index", { fieldId, tableId, error: String(error) });
    await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${idx}`).catch(() => undefined);
    return false;
  }
};

const createReverseSortIndex = async (fieldId: string, tableId: string, expression: string, db: SQL = sql): Promise<boolean> => {
  const idx = fieldReverseSortIndexName(fieldId);
  try {
    await db.unsafe(
      `CREATE INDEX CONCURRENTLY ${idx}
       ON grids.records ((${expression}) DESC NULLS LAST, id DESC)
       ${fieldIndexWhere(fieldId, tableId)}`,
    );
    log.info("Created reverse-null-order expression index", { fieldId, tableId, idx });
    return true;
  } catch (error) {
    log.error("Failed to create reverse-null-order expression index", { fieldId, tableId, error: String(error) });
    await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${idx}`).catch(() => undefined);
    return false;
  }
};

const createFieldPlannerStatistics = async (fieldId: string, expression: string, db: SQL): Promise<boolean> => {
  const name = fieldPlannerStatisticsName(fieldId);
  try {
    await db.unsafe(`DROP STATISTICS IF EXISTS grids.${name}`);
    await db.unsafe(
      `CREATE STATISTICS grids.${name} (mcv, dependencies)
       ON table_id, ((${expression}))
       FROM grids.records`,
    );
    return true;
  } catch (error) {
    log.error("Failed to create field planner statistics", { fieldId, name, error: String(error) });
    await db.unsafe(`DROP STATISTICS IF EXISTS grids.${name}`).catch(() => undefined);
    return false;
  }
};

const analyzeFieldPlannerStatistics = async (db: SQL): Promise<void> => {
  try {
    await db`ANALYZE grids.records`;
  } catch (error) {
    log.error("Failed to analyze field planner statistics", { error: String(error) });
  }
};

/**
 * Ensures the expression index exists for an indexed field. Runs CONCURRENTLY
 * so it can't be inside a transaction;
 * caller must invoke this OUTSIDE any in-flight tx (which is the case in
 * field.update / field.create where the tx is already committed).
 */
const ensureFieldIndexOnConnection = async (
  db: SQL,
  fieldId: string,
  type: string,
  tableId: string,
  config?: Record<string, unknown>,
): Promise<void> => {
  // Field IDs are UUIDs (constrained set [a-f0-9-]) so embedding them in
  // SQL identifiers is safe — no other path produces a `fieldId` value.
  if (!isSafeFieldId(fieldId) || !isSafeFieldId(tableId)) {
    log.warn("Refusing to create index for invalid id", { fieldId, tableId });
    return;
  }

  const expression = indexExpressionForType(fieldId, type, config);
  if (!expression) {
    const idx = fieldPerformanceIndexName(fieldId);
    await db.unsafe(`DROP STATISTICS IF EXISTS grids.${fieldPlannerStatisticsName(fieldId)}`).catch(() => undefined);
    for (const stale of [idx, fieldReverseSortIndexName(fieldId), trgmIndexName(fieldId)]) {
      await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${stale}`).catch((error) => {
        log.warn("Pre-create DROP INDEX failed (continuing)", { fieldId, idx: stale, error: String(error) });
      });
    }
    // Multi-select uses JSONB containment; unsupported types have no index.
    if (type === "select" || type === "principal") {
      try {
        await db.unsafe(
          `CREATE INDEX CONCURRENTLY ${idx}
           ON grids.records USING gin ((data->'${fieldId}') jsonb_path_ops)
           ${fieldIndexWhere(fieldId, tableId)}`,
        );
        log.info("Created JSONB containment GIN index", { fieldId, tableId, idx });
      } catch (e) {
        log.error("Failed to create JSONB containment GIN index", { fieldId, tableId, error: String(e) });
      }
    }
    return;
  }

  const idx = fieldPerformanceIndexName(fieldId);
  const reverseSortIdx = fieldReverseSortIndexName(fieldId);
  // Recreate by name so old alpha indexes with narrower predicates are
  // replaced the next time ensureFieldIndex runs.
  for (const name of [idx, reverseSortIdx, trgmIndexName(fieldId)]) {
    try {
      await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${name}`);
    } catch (e) {
      log.warn("Pre-create DROP INDEX failed (continuing)", { fieldId, idx: name, error: String(e) });
    }
  }
  await createForwardSortIndex(fieldId, tableId, expression, db);
  await createReverseSortIndex(fieldId, tableId, expression, db);
  const statisticsCreated = await createFieldPlannerStatistics(fieldId, expression, db);

  // Trigram index for text fields — accelerates `contains`/`startsWith`.
  if (type === "text" || type === "longtext") {
    const tidx = trgmIndexName(fieldId);
    try {
      // pg_trgm is a postgres extension; ensure it's available.
      await db.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await db.unsafe(
        `CREATE INDEX CONCURRENTLY ${tidx}
         ON grids.records USING gin ((data->>'${fieldId}') gin_trgm_ops)
         ${fieldIndexWhere(fieldId, tableId)}`,
      );
      log.info("Created text trigram index", { fieldId, tableId, tidx });
    } catch (e) {
      log.error("Failed to create trigram index", { fieldId, tableId, error: String(e) });
    }
  }
  if (statisticsCreated) await analyzeFieldPlannerStatistics(db);
};

export const ensureFieldIndex = async (fieldId: string, type: string, tableId: string, config?: Record<string, unknown>): Promise<void> =>
  withIndexMaintenanceConnection(sql, (connection) => ensureFieldIndexOnConnection(connection, fieldId, type, tableId, config));

/**
 * Drops both the expression and trigram indexes for a field. Idempotent.
 * Called when the user toggles `indexed: false` or deletes the field.
 */
const dropFieldIndexOnConnection = async (db: SQL, fieldId: string): Promise<void> => {
  if (!isSafeFieldId(fieldId)) return;

  for (const idx of [fieldPerformanceIndexName(fieldId), fieldReverseSortIndexName(fieldId), trgmIndexName(fieldId)]) {
    try {
      await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${idx}`);
    } catch (e) {
      log.error("Failed to drop index", { fieldId, idx, error: String(e) });
    }
  }
  try {
    await db.unsafe(`DROP STATISTICS IF EXISTS grids.${fieldPlannerStatisticsName(fieldId)}`);
  } catch (error) {
    log.error("Failed to drop field planner statistics", { fieldId, error: String(error) });
  }
};

export const dropFieldIndex = async (fieldId: string): Promise<void> =>
  withIndexMaintenanceConnection(sql, (connection) => dropFieldIndexOnConnection(connection, fieldId));

/**
 * Backfills composite sort indexes introduced after the original field
 * indexes. Existing valid indexes stay untouched.
 */
type IndexMaintenanceProgress = {
  changed: number;
  hasMore: boolean;
};

const ensureMissingFieldSortIndexesOnConnection = async (
  db: SQL,
  maxFields = Number.POSITIVE_INFINITY,
): Promise<IndexMaintenanceProgress> => {
  const rows = await db<Array<{ id: string; table_id: string; type: string; config: Record<string, unknown> | null }>>`
    SELECT f.id::text, f.table_id::text, f.type, f.config
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE f.indexed = TRUE
      AND f.deleted_at IS NULL
  `;
  const validIndexes = await db<Array<{ name: string; key_columns: number }>>`
    SELECT c.relname::text AS name, i.indnkeyatts::int AS key_columns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'grids'
      AND i.indisvalid = TRUE
      AND c.relname ~ '^idx_grids_data_(rev_)?[a-f0-9]{32}$'
  `;
  const existingIndexes = new Map(validIndexes.map((index) => [index.name, index.key_columns]));
  const existingStatistics = new Set(
    (
      await db<Array<{ name: string }>>`
        SELECT e.stxname::text AS name
        FROM pg_statistic_ext e
        JOIN pg_namespace n ON n.oid = e.stxnamespace
        WHERE n.nspname = 'grids'
          AND e.stxname ~ '^st_grids_data_[a-f0-9]{32}$'
      `
    ).map((item) => item.name),
  );
  const candidates = rows.filter((row) => {
    const expression = indexExpressionForType(row.id, row.type, row.config ?? undefined);
    if (!expression) return false;
    return (
      existingIndexes.get(fieldPerformanceIndexName(row.id)) !== 2 ||
      existingIndexes.get(fieldReverseSortIndexName(row.id)) !== 2 ||
      !existingStatistics.has(fieldPlannerStatisticsName(row.id))
    );
  });
  const selected = candidates.slice(0, maxFields);
  let changed = 0;
  let statisticsCreated = false;
  for (const row of selected) {
    const expression = indexExpressionForType(row.id, row.type, row.config ?? undefined);
    if (!expression) continue;
    const forwardName = fieldPerformanceIndexName(row.id);
    if (existingIndexes.get(forwardName) !== 2) {
      await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${forwardName}`).catch(() => undefined);
      if (await createForwardSortIndex(row.id, row.table_id, expression, db)) changed += 1;
    }
    const reverseName = fieldReverseSortIndexName(row.id);
    if (existingIndexes.get(reverseName) !== 2) {
      await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${reverseName}`).catch(() => undefined);
      if (await createReverseSortIndex(row.id, row.table_id, expression, db)) changed += 1;
    }
    if (!existingStatistics.has(fieldPlannerStatisticsName(row.id))) {
      const created = await createFieldPlannerStatistics(row.id, expression, db);
      statisticsCreated = created || statisticsCreated;
      if (created) changed += 1;
    }
  }
  if (statisticsCreated) await analyzeFieldPlannerStatistics(db);
  return { changed, hasMore: candidates.length > selected.length };
};

export const ensureMissingFieldSortIndexes = async (db?: SQL): Promise<number> => {
  const progress = db
    ? await ensureMissingFieldSortIndexesOnConnection(db)
    : await withIndexMaintenanceConnection(sql, ensureMissingFieldSortIndexesOnConnection);
  return progress.changed;
};

/**
 * Removes dynamic record indexes whose field was hard-deleted through a
 * cascading base cleanup. PostgreSQL keeps them because they belong to the
 * shared records table, not the deleted field row.
 */
const dropOrphanedFieldIndexesOnConnection = async (db: SQL, maxObjects = Number.POSITIVE_INFINITY): Promise<IndexMaintenanceProgress> => {
  const indexes = await db<Array<{ name: string }>>`
    SELECT indexname::text AS name
    FROM pg_indexes
    WHERE schemaname = 'grids'
      AND indexname ~ '^(idx_grids_data_rev_|idx_grids_data_|idx_grids_trgm_|uq_grids_data_)[a-f0-9]{32}$'
  `;
  const fields = await db<Array<{ key: string }>>`
    SELECT replace(id::text, '-', '') AS key
    FROM grids.fields
  `;
  const statistics = await db<Array<{ name: string }>>`
    SELECT e.stxname::text AS name
    FROM pg_statistic_ext e
    JOIN pg_namespace n ON n.oid = e.stxnamespace
    WHERE n.nspname = 'grids'
      AND e.stxname ~ '^st_grids_data_[a-f0-9]{32}$'
  `;
  const fieldKeys = new Set(fields.map((field) => field.key));
  const orphanedIndexes = indexes
    .filter((index) => {
      const match = dynamicFieldIndexPattern.exec(index.name);
      return match ? !fieldKeys.has(match[1]!) : false;
    })
    .map((item) => ({ kind: "index" as const, name: item.name }));
  const orphanedStatistics = statistics.flatMap((statistic) => {
    const match = dynamicFieldStatisticsPattern.exec(statistic.name);
    return match && !fieldKeys.has(match[1]!) ? [{ kind: "statistics" as const, name: statistic.name }] : [];
  });
  const orphaned = [...orphanedIndexes, ...orphanedStatistics];
  const selected = orphaned.slice(0, maxObjects);
  let dropped = 0;
  for (const object of selected) {
    try {
      if (object.kind === "index") {
        // The regex above is the identifier safety gate. CONCURRENTLY keeps
        // other Grids replicas readable while a stale index is removed.
        await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${object.name}`);
      } else {
        await db.unsafe(`DROP STATISTICS IF EXISTS grids.${object.name}`);
      }
      dropped += 1;
    } catch (error) {
      log.warn("Failed to drop orphaned field index object", { kind: object.kind, name: object.name, error: String(error) });
    }
  }
  if (dropped > 0) log.info("Dropped orphaned field indexes", { dropped });
  return { changed: dropped, hasMore: orphaned.length > selected.length };
};

export const dropOrphanedFieldIndexes = async (db?: SQL): Promise<number> => {
  const progress = db
    ? await dropOrphanedFieldIndexesOnConnection(db)
    : await withIndexMaintenanceConnection(sql, dropOrphanedFieldIndexesOnConnection);
  return progress.changed;
};

const FIELD_INDEX_MAINTENANCE_LOCK = "grids:field-index-maintenance:v2";

type FieldIndexMaintenanceBatchResult = {
  claimed: boolean;
  changed: number;
  hasMore: boolean;
};

export const runFieldIndexMaintenanceBatch = async (
  options: { maxFields?: number; maxOrphans?: number } = {},
): Promise<FieldIndexMaintenanceBatchResult> =>
  withIndexMaintenanceConnection(sql, async (connection) => {
    const [lock] = await connection<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(hashtextextended(${FIELD_INDEX_MAINTENANCE_LOCK}, 0)) AS acquired
    `;
    if (!lock?.acquired) return { claimed: false, changed: 0, hasMore: true };
    try {
      const orphaned = await dropOrphanedFieldIndexesOnConnection(connection, Math.max(1, options.maxOrphans ?? 16));
      const missing = await ensureMissingFieldSortIndexesOnConnection(connection, Math.max(1, options.maxFields ?? 4));
      return {
        claimed: true,
        changed: orphaned.changed + missing.changed,
        hasMore: orphaned.hasMore || missing.hasMore,
      };
    } finally {
      try {
        const [unlock] = await connection<Array<{ released: boolean }>>`
          SELECT pg_advisory_unlock(hashtextextended(${FIELD_INDEX_MAINTENANCE_LOCK}, 0)) AS released
        `;
        if (!unlock?.released) throw new Error("field index maintenance lock was not held");
      } catch (error) {
        // A leaked session lock would make one pooled connection permanently
        // own maintenance. Closing is the only safe recovery.
        await connection.close({ timeout: 0 }).catch(() => undefined);
        throw error;
      }
    }
  });

// Unique field constraints use partial expression indexes over live records.
// Select and relation fields are excluded because array uniqueness has no
// single useful record-level meaning.

const UNIQUE_SUPPORTED_TYPES = new Set(["text", "longtext", "number", "percent", "date", "boolean", "id"]);

export const isUniqueable = (type: string): boolean => UNIQUE_SUPPORTED_TYPES.has(type);

/**
 * Creates a partial unique index on `(table_id, (data->>'<fieldId>'))`
 * for live records. CONCURRENTLY because creation can take seconds on
 * large tables and shouldn't block writes.
 *
 * Will FAIL (Postgres-side, surfaced via the catch + log) if existing
 * data violates uniqueness — caller is expected to pre-check via
 * `findUniqueConflicts` and surface a 409 to the user before toggling.
 */
const ensureFieldUniqueIndexOnConnection = async (db: SQL, fieldId: string, type: string, tableId: string): Promise<void> => {
  if (!isSafeFieldId(fieldId) || !isSafeFieldId(tableId)) {
    log.warn("Refusing to create unique index for invalid id", { fieldId, tableId });
    return;
  }
  if (!isUniqueable(type)) {
    log.warn("unique_constraint skipped: type not supported", { fieldId, type });
    return;
  }
  const idx = fieldUniqueIndexName(fieldId);
  // Drop any pre-existing index by this name first. CONCURRENTLY+IF
  // NOT EXISTS would otherwise see an INVALID index left from a
  // previous failed build and skip re-creation, leaving the field
  // toggle's enforcement permanently broken until manual cleanup.
  try {
    await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${idx}`);
  } catch (e) {
    log.warn("Pre-create DROP INDEX failed (continuing)", { fieldId, idx, error: String(e) });
  }
  try {
    await db.unsafe(
      `CREATE UNIQUE INDEX CONCURRENTLY ${idx}
       ON grids.records ((data->>'${fieldId}'))
       WHERE table_id = '${tableId}'::uuid AND deleted_at IS NULL AND data ? '${fieldId}'`,
    );
    log.info("Created unique index", { fieldId, idx });
  } catch (e) {
    log.error("Failed to create unique index", { fieldId, idx, error: String(e) });
    // Best-effort cleanup of the (now INVALID) partially-built index.
    try {
      await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${idx}`);
    } catch {}
    throw e;
  }
};

export const ensureFieldUniqueIndex = async (fieldId: string, type: string, tableId: string): Promise<void> =>
  withIndexMaintenanceConnection(sql, (connection) => ensureFieldUniqueIndexOnConnection(connection, fieldId, type, tableId));

const dropFieldUniqueIndexOnConnection = async (db: SQL, fieldId: string, options: { throwOnError?: boolean } = {}): Promise<void> => {
  if (!isSafeFieldId(fieldId)) return;
  try {
    await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS grids.${fieldUniqueIndexName(fieldId)}`);
  } catch (e) {
    log.error("Failed to drop unique index", { fieldId, error: String(e) });
    if (options.throwOnError) throw e;
  }
};

export const dropFieldUniqueIndex = async (fieldId: string, options: { throwOnError?: boolean } = {}): Promise<void> =>
  withIndexMaintenanceConnection(sql, (connection) => dropFieldUniqueIndexOnConnection(connection, fieldId, options));

/**
 * Pre-flight: returns the list of values that would violate uniqueness
 * if the constraint were turned on right now. Lets the API return a
 * clean 409 with a list of offenders instead of letting Postgres throw
 * a generic duplicate-key error during index build.
 */
export const findUniqueConflicts = async (fieldId: string, tableId: string): Promise<string[]> => {
  if (!isSafeFieldId(fieldId) || !isSafeFieldId(tableId)) return [];
  const rows = await sql.unsafe(
    `SELECT data->>'${fieldId}' AS v
     FROM grids.records
     WHERE table_id = '${tableId}'::uuid AND deleted_at IS NULL AND data ? '${fieldId}'
     GROUP BY data->>'${fieldId}'
     HAVING COUNT(*) > 1`,
  );
  return (rows as Array<{ v: string }>).map((r) => r.v);
};
