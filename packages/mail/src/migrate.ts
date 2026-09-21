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

const applyBaseline = async (tx: SqlClient): Promise<void> => {
  await tx`CREATE SCHEMA IF NOT EXISTS mail`;
  await tx`
    CREATE TABLE IF NOT EXISTS mail.schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  const applied = await tx<{ version: number; name: string }[]>`
    SELECT version, name FROM mail.schema_migrations ORDER BY version
  `;
  assertBaselineOnly(applied);
  if (applied.length > 0) return;
  await tx.unsafe(baselineSchema).simple();
  await tx`
    INSERT INTO mail.schema_migrations (version, name)
    VALUES (${BASELINE_VERSION}, ${BASELINE_NAME})
  `;
};

const migrationErrorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

/**
 * The whole migration runs in one transaction under a transaction-scoped
 * advisory lock, so the guard also holds behind a transaction pooler. A run
 * that waits longer than `lock_timeout` for the guard or for DDL locks fails
 * with `55P03` and is retried with backoff.
 */
export const migrate = async (): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '10s'`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`;
        await applyBaseline(tx);
        await migrateWorkflowAi(tx);
      });
      return;
    } catch (error) {
      if (migrationErrorCode(error) !== "55P03" || attempt === 2) throw error;
      await Bun.sleep(250 * 2 ** attempt);
    }
  }
};
