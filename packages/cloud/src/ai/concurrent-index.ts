import type { SQL } from "bun";
import type { logger } from "../services/logging";

/** An index of the `ai` schema that is built next to live writes, and what its log lines say. */
export type AiConcurrentIndex = {
  /** Index name in the `ai` schema. */
  name: string;
  /** Table in the `ai` schema. */
  table: string;
  /** Everything after `ON ai.<table>`: columns, order and an optional partial predicate. */
  definition: string;
  log: ReturnType<typeof logger>;
  /** Logged when the build fails; the next migration tries again. */
  failed: string;
  /** Logged when no connection or catalog read is possible. */
  unavailable: string;
};

const readIndex = async (db: SQL, index: AiConcurrentIndex) => {
  const name = `ai.${index.name}`;
  const table = `ai.${index.table}`;
  const [state] = await db<{ present: boolean; valid: boolean; building: boolean }[]>`
    SELECT to_regclass(${name}) IS NOT NULL AS present,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = to_regclass(${name})
        AND indisvalid AND indisready AND indislive) AS valid,
      EXISTS (SELECT 1 FROM pg_catalog.pg_stat_progress_create_index progress
        WHERE progress.datname = pg_catalog.current_database()
          AND (progress.relid = to_regclass(${table}) OR progress.relid IS NULL)) AS building`;
  return state ?? { present: false, valid: false, building: false };
};

const dropIndex = (db: SQL, index: AiConcurrentIndex) => db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ai.${index.name}`).simple();

/**
 * Builds an index without blocking writes: outside transactions, on a reserved connection so snapshot waits cannot trap
 * ordinary pool queries. An interrupted (invalid) build is dropped and replaced, an active build is left alone, and a
 * valid index is kept. A failure is logged and retried at the next migration, never thrown. True once it is valid.
 */
export async function ensureAiConcurrentIndex(db: SQL, index: AiConcurrentIndex): Promise<boolean> {
  try {
    const build = await db.reserve();
    try {
      const before = await readIndex(build, index);
      if (before.valid) return true;
      if (before.building) return false;
      // IF NOT EXISTS would keep an invalid index, such as one whose build was interrupted.
      if (before.present) await dropIndex(build, index);
      try {
        await build.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ON ai.${index.table} ${index.definition}`).simple();
      } catch (error) {
        const after = await readIndex(build, index);
        index.log.warn(index.failed, { error: error instanceof Error ? error.message : String(error) });
        if (after.present && !after.valid && !after.building) await dropIndex(build, index);
        return after.valid;
      }
      // IF NOT EXISTS skips the build when another one created the index meanwhile; it counts only once valid.
      return (await readIndex(build, index)).valid;
    } finally {
      build.release();
    }
  } catch (error) {
    index.log.warn(index.unavailable, { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
