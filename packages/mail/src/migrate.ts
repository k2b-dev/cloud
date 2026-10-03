/**
 * Mail owns everything in the `mail` schema. `src/schema.sql` is its baseline:
 * a fresh installation runs that file once inside one transaction and records
 * version 1 (`baseline`) in `mail.schema_migrations`. Objects added after the
 * baseline live in `applyAdditions` below.
 *
 * The historical 1..126 migration chain was collapsed into that baseline before
 * Mail was first deployed; a developer machine that still holds the old chain
 * is reset by dropping the schema.
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

/**
 * Objects added after the baseline. Every statement is idempotent and runs on
 * each start, so a database installed from the baseline gains them, and an
 * older Mail image, which records no version for them, still starts on it.
 */
const applyAdditions = async (tx: SqlClient): Promise<void> => {
  // Pinned and hidden mailboxes in the overview, kept per principal so they apply on every device.
  // A person's rows go with the person, a service account's with the account.
  await tx`
    CREATE TABLE IF NOT EXISTS mail.personal_mailbox_preferences (
      mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
      service_account_id uuid REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
      pinned_at timestamp with time zone,
      hidden_at timestamp with time zone,
      CONSTRAINT personal_mailbox_preferences_principal_check CHECK (num_nonnulls(user_id, service_account_id) = 1),
      CONSTRAINT personal_mailbox_preferences_key UNIQUE NULLS NOT DISTINCT (user_id, service_account_id, mailbox_id)
    )
  `.simple();
  await tx`
    CREATE INDEX IF NOT EXISTS personal_mailbox_preferences_service_account_idx
    ON mail.personal_mailbox_preferences USING btree (service_account_id, mailbox_id)
    WHERE service_account_id IS NOT NULL
  `.simple();
  await tx`
    CREATE INDEX IF NOT EXISTS personal_mailbox_preferences_mailbox_idx ON mail.personal_mailbox_preferences USING btree (mailbox_id)
  `.simple();
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
        await applyAdditions(tx);
        await migrateWorkflowAi(tx);
      });
      return;
    } catch (error) {
      if (migrationErrorCode(error) !== "55P03" || attempt === 2) throw error;
      await Bun.sleep(250 * 2 ** attempt);
    }
  }
};
