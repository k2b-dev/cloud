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
  // Body downloads in progress, so the recovery of claims a stopped worker left behind reads only
  // them instead of every message. Building it reads the table once, on the first start after the update.
  await tx`
    CREATE INDEX IF NOT EXISTS message_contents_hydration_claim_idx ON mail.message_contents USING btree (hydration_claimed_at)
    WHERE hydration_status = 'hydrating'
  `.simple();
  // Folders the provider fills from the others (Gmail's Important and Starred). Discovery sets it.
  await tx`ALTER TABLE mail.folders ADD COLUMN IF NOT EXISTS provider_collection boolean DEFAULT false NOT NULL`.simple();
  // A folder's display replaces its sidebar switch: shown folders keep their mail everywhere, hidden
  // ones stay hidden. The backfill runs once, when the column appears. show_in_sidebar stays, and Mail
  // keeps it current, so an older Mail image still starts on this database and reads hidden folders.
  await tx`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'mail' AND table_name = 'folders' AND column_name = 'display'
      ) THEN
        ALTER TABLE mail.folders ADD COLUMN display text DEFAULT 'everywhere' NOT NULL
          CONSTRAINT folders_display_check CHECK (display IN ('everywhere', 'folder_only', 'hidden'));
        UPDATE mail.folders SET display = 'hidden' WHERE NOT show_in_sidebar;
      END IF;
    END
    $$
  `.simple();
  await addCommandQueuePosition(tx);
  await writeLiveUpdatesToPlatformOutbox(tx);
};

/**
 * Mail's one writer of live updates, called by the trigger on `mail.activity_events` and by
 * changes that record no activity. It writes to Core's platform outbox and joins the updates of
 * one conversation, or of the whole mailbox, in one transaction. It keeps the signature of the
 * function that wrote to Mail's former table, so the replicas of an older image that still run
 * during a rollout write their updates here too; the uuid it returns is always NULL.
 * The baseline does not create it, so a fresh installation and an upgraded one get this body.
 */
const writeLiveUpdatesToPlatformOutbox = async (tx: SqlClient): Promise<void> => {
  await tx`
    CREATE OR REPLACE FUNCTION mail.enqueue_live_invalidation(target_mailbox_id uuid, target_conversation_id uuid DEFAULT NULL)
    RETURNS uuid
    LANGUAGE plpgsql
    AS $$
    DECLARE
      conversation_short_id text;
    BEGIN
      IF target_conversation_id IS NOT NULL THEN
        SELECT short_id INTO conversation_short_id
        FROM mail.conversations
        WHERE id = target_conversation_id AND mailbox_id = target_mailbox_id;
      END IF;
      PERFORM events.enqueue(
        gen_random_uuid(),
        'mail',
        'live',
        target_mailbox_id::text,
        jsonb_build_object(
          'v', 1,
          'k', target_mailbox_id::text,
          'd', jsonb_build_object('conversationId', conversation_short_id)
        ),
        target_mailbox_id::text || ':' || COALESCE(conversation_short_id, '')
      );
      RETURN NULL;
    END;
    $$
  `.simple();
  await tx`DROP TABLE IF EXISTS mail.live_invalidation_outbox`.simple();
};

/**
 * The order in which the mailbox lock accepted each command. Every command insert runs after its
 * transaction locked the mailbox row and keeps that lock until it commits, so a sequence value taken
 * by the insert follows the lock order per mailbox, while `created_at` is the transaction's start time.
 * The sequence must not cache values per session, or a later session could take a lower value.
 *
 * Commands that exist before the update keep 0 from the column's catalog default, so neither the
 * history nor the queue is rewritten. They keep their previous order among themselves through the
 * `(queue_position, created_at, id)` key and stay ahead of every command accepted afterwards, which
 * the mailbox lock also accepted later. Only the first start after the update changes the table.
 */
const addCommandQueuePosition = async (tx: SqlClient): Promise<void> => {
  const [existing] = await tx<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'mail.commands'::regclass AND attname = 'queue_position' AND NOT attisdropped
    ) AS present
  `;
  if (existing?.present) return;
  await tx`CREATE SEQUENCE IF NOT EXISTS mail.commands_queue_position_seq AS bigint CACHE 1`.simple();
  await tx`ALTER TABLE mail.commands ADD COLUMN queue_position bigint NOT NULL DEFAULT 0`.simple();
  await tx`ALTER SEQUENCE mail.commands_queue_position_seq OWNED BY mail.commands.queue_position`.simple();
  await tx`ALTER TABLE mail.commands ALTER COLUMN queue_position SET DEFAULT nextval('mail.commands_queue_position_seq')`.simple();
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
