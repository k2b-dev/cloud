/**
 * Mail owns everything in the `mail` schema. `src/schema.sql` is the single
 * source of truth for it: a fresh installation runs that file once inside one
 * transaction and records version 1 (`baseline`) in `mail.schema_migrations`.
 *
 * The historical 1..126 migration chain was collapsed into that baseline. Mail
 * has never been deployed, so no database needs an upgrade path; a developer
 * machine that still holds the old chain is reset by dropping the schema.
 */
import { migrateWorkflowAi } from "@k2b/cloud/workflows/ai";
import { sql } from "bun";
import baselineSchema from "./schema.sql" with { type: "text" };

type SqlClient = typeof sql;

const BASELINE_VERSION = 1;
const BASELINE_NAME = "baseline";

const MIGRATION_LOCK_KEY = "cloud.mail.migrations";

const ensureMigrationFoundation = async (db: SqlClient): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`CREATE SCHEMA IF NOT EXISTS mail`;
    await tx`
      CREATE TABLE IF NOT EXISTS mail.schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
  });
};

/** Refuse databases created by the removed migration chain instead of half-upgrading them. */
const assertBaselineOnly = (applied: readonly { version: number; name: string }[]): void => {
  const foreign = applied.filter((row) => row.version !== BASELINE_VERSION || row.name !== BASELINE_NAME);
  if (foreign.length === 0) return;
  const versions = foreign.map((row) => `${row.version} (${row.name})`).join(", ");
  throw new Error(
    `Mail's schema history was collapsed into a single baseline, but this database still holds migration ${versions}. ` +
      "Mail has never been deployed and there is no upgrade path: drop the schema and let Mail recreate it with " +
      "`DROP SCHEMA mail CASCADE;`.",
  );
};

const applyBaseline = async (db: SqlClient): Promise<void> => {
  await ensureMigrationFoundation(db);
  const applied = await db<{ version: number; name: string }[]>`
    SELECT version, name FROM mail.schema_migrations ORDER BY version
  `;
  assertBaselineOnly(applied);
  if (applied.length > 0) return;

  await db.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    const [existing] = await tx<{ version: number }[]>`
      SELECT version FROM mail.schema_migrations WHERE version = ${BASELINE_VERSION}
    `;
    if (existing) return;
    await tx.unsafe(baselineSchema).simple();
    await tx`
      INSERT INTO mail.schema_migrations (version, name)
      VALUES (${BASELINE_VERSION}, ${BASELINE_NAME})
    `;
  });
};

const migrationErrorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

const acquireMigrationLock = async (db: SqlClient): Promise<void> => {
  const deadline = Date.now() + 10_000;
  do {
    const [result] = await db<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${MIGRATION_LOCK_KEY}, 0)) AS locked
    `;
    if (result?.locked) return;
    await Bun.sleep(250);
  } while (Date.now() < deadline);

  const timeout = Object.assign(new Error("Timed out waiting for the Mail migration lock"), { code: "55P03" });
  throw timeout;
};

export const migrate = async (): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const connection = await sql.reserve();
    let locked = false;
    try {
      await acquireMigrationLock(connection);
      locked = true;
      await applyBaseline(connection);
      await migrateWorkflowAi(connection);
      return;
    } catch (error) {
      if (migrationErrorCode(error) !== "55P03" || attempt === 2) throw error;
      await Bun.sleep(250 * 2 ** attempt);
    } finally {
      if (locked) {
        await connection`SELECT pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`.catch(() => undefined);
      }
      connection.release();
    }
  }
};
