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
import { lazySync } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { migrateWorkflowAi } from "@k2b/cloud/workflows/ai";
import { sql } from "bun";
import baselineSchema from "./schema.sql" with { type: "text" };

type SqlClient = typeof sql;

const BASELINE_VERSION = 1;
const BASELINE_NAME = "baseline";

const MIGRATION_LOCK_KEY = "cloud.mail.migrations";
const log = logger("mail:migrate");

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
  await tx`
    CREATE TABLE IF NOT EXISTS mail.conversation_keeps (
      conversation_id uuid PRIMARY KEY REFERENCES mail.conversations(id) ON DELETE CASCADE,
      mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      kept_by_kind text NOT NULL CHECK (kept_by_kind IN ('user','service_account','workflow','system')),
      kept_by_id uuid,
      kept_at timestamptz NOT NULL DEFAULT now()
    )
  `.simple();
  await tx`CREATE INDEX IF NOT EXISTS conversation_keeps_mailbox_idx
    ON mail.conversation_keeps (mailbox_id, kept_at DESC, conversation_id)`.simple();
  await tx`
    CREATE OR REPLACE FUNCTION mail.carry_conversation_keep() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
        INSERT INTO mail.conversation_keeps (conversation_id, mailbox_id, kept_by_kind, kept_by_id, kept_at)
        SELECT NEW.conversation_id, mailbox_id, kept_by_kind, kept_by_id, kept_at
        FROM mail.conversation_keeps WHERE conversation_id = OLD.conversation_id
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$
  `.simple();
  await tx`CREATE OR REPLACE TRIGGER carry_conversation_keep
    AFTER UPDATE OF conversation_id ON mail.conversation_messages
    FOR EACH ROW EXECUTE FUNCTION mail.carry_conversation_keep()`.simple();
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
  // Even when the index exists, CREATE INDEX waits for the table lock that a running BM25 build holds.
  const [claimIndex] = await tx<{ present: boolean }[]>`
    SELECT to_regclass('mail.message_contents_hydration_claim_idx') IS NOT NULL AS present
  `;
  if (!claimIndex?.present) {
    await tx`
      CREATE INDEX IF NOT EXISTS message_contents_hydration_claim_idx ON mail.message_contents USING btree (hydration_claimed_at)
      WHERE hydration_status = 'hydrating'
    `.simple();
  }
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
  // A message only some recipients accepted keeps needing attention for the others while its Sent
  // copy is retried: the flag marks that retry next to the partial outcome, and the index lets the
  // scheduler find those few rows among all settled sends.
  await tx`ALTER TABLE mail.outbox_submissions ADD COLUMN IF NOT EXISTS sent_copy_pending boolean DEFAULT false NOT NULL`.simple();
  await tx`
    CREATE INDEX IF NOT EXISTS outbox_sent_copy_pending_idx ON mail.outbox_submissions USING btree (id)
    WHERE sent_copy_pending
  `.simple();
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

/** The SQLSTATE of a database error: Bun reports it as `errno`, other drivers as `code`. */
const migrationErrorCode = (error: unknown): string | null => {
  const candidate = error as { code?: unknown; errno?: unknown } | null;
  if (typeof candidate?.errno === "string") return candidate.errno;
  return typeof candidate?.code === "string" ? candidate.code : null;
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

/**
 * One Mail process builds at a time: a second build on the same table deadlocks with the first, and
 * Postgres cancels one of them. The lease is renewed while the build runs.
 */
const BM25_INDEX_LEASE_MS = 60_000;
const searchIndexBuildMutex = lazySync((sync) =>
  sync.mutex({ id: "mail:search-index-build", ttlMs: BM25_INDEX_LEASE_MS, retry: { maxAttempts: 1 } }),
);

/**
 * The index behind BM25 ranking. Its expression is the text that search ranks, subject twice and
 * then the body, so it must stay identical to the rank in `service/search.ts`.
 */
const BM25_INDEX_DDL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS message_contents_bm25_idx
  ON mail.message_contents USING bm25 ((COALESCE(subject, '') || ' ' || COALESCE(subject, '') || ' ' || COALESCE(plain_text, '')))
  WITH (text_config = 'simple')`;

/**
 * The index as the database sees it. Search uses it only when it is a valid BM25 index; `building`
 * tells a build that is still running, in any process, from one that was interrupted. Postgres
 * hides which index another role builds, so any index build of another role in this database
 * counts, such as an operator's own build of this index.
 */
const readBm25IndexState = async () => {
  const [state] = await sql<{ installed: boolean; present: boolean; valid: boolean; building: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS installed,
      to_regclass('mail.message_contents_bm25_idx') IS NOT NULL AS present,
      EXISTS (
        SELECT 1
        FROM pg_index index_state
        JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
        JOIN pg_am access_method ON access_method.oid = index_class.relam
        WHERE index_state.indexrelid = to_regclass('mail.message_contents_bm25_idx')
          AND access_method.amname = 'bm25'
          AND index_state.indisvalid
          AND index_state.indisready
          AND index_state.indislive
      ) AS valid,
      EXISTS (
        SELECT 1
        FROM pg_stat_progress_create_index progress
        WHERE progress.datname = current_database()
          AND (progress.index_relid = to_regclass('mail.message_contents_bm25_idx') OR progress.index_relid IS NULL)
      ) AS building
  `;
  return state ?? { installed: false, present: false, valid: false, building: false };
};

const dropBm25Index = async (): Promise<void> => {
  await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.message_contents_bm25_idx`.simple();
};

/**
 * Builds the optional BM25 index when the operator installed pg_textsearch. The build runs
 * concurrently, so mail keeps arriving, and under a NATS lease, so one process builds at a time.
 * Mail does not wait for it: search ranks natively until the index is valid. A build that fails is
 * removed, and the next start tries again; an index left invalid by an interrupted build is
 * replaced, and one that another process is still building is left alone.
 * Every database step is one statement without session state, so a transaction pooler may send
 * each to another backend. Never throws.
 */
export const buildOptionalSearchIndex = async (): Promise<"unavailable" | "ready" | "busy" | "built" | "failed"> => {
  try {
    const before = await readBm25IndexState();
    if (!before.installed) return "unavailable";
    if (before.valid) return "ready";
    const mutex = searchIndexBuildMutex();
    const lease = await mutex.acquire({ resource: "message-contents-bm25" });
    if (!lease) return "busy";
    const renewal = setInterval(() => void mutex.extend(lease).catch(() => false), BM25_INDEX_LEASE_MS / 3);
    renewal.unref();
    try {
      return await buildBm25Index();
    } finally {
      clearInterval(renewal);
      await mutex.release(lease).catch(() => false);
    }
  } catch (error) {
    log.warn("Optional BM25 index for Mail search is unavailable; search stays native", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
};

const buildBm25Index = async (): Promise<"ready" | "busy" | "built" | "failed"> => {
  // Another process may have finished the build since the first look, or still build it, for
  // example an operator in a maintenance window or a process whose lease ran out.
  const before = await readBm25IndexState();
  if (before.valid) return "ready";
  if (before.building) {
    log.info("An index build is already running in this database; the next start checks the optional BM25 index again");
    return "busy";
  }
  // IF NOT EXISTS would keep an invalid index, such as one whose build was interrupted.
  if (before.present) await dropBm25Index();
  log.info("Building the optional BM25 index for Mail search");
  const startedAt = performance.now();
  // The build runs until it is done. pg_textsearch reacts to a cancel request or statement_timeout
  // only once it has read every message, so a time limit would discard a finished build and repeat
  // it on the next start.
  try {
    await sql.unsafe(BM25_INDEX_DDL).simple();
  } catch (error) {
    const after = await readBm25IndexState();
    if (after.valid) return "ready";
    if (after.building) return "busy";
    log.warn("Optional BM25 index for Mail search was not built; search stays native", {
      error: error instanceof Error ? error.message : String(error),
    });
    await dropBm25Index();
    return "failed";
  }
  // IF NOT EXISTS skips the build when another build created the index in the meantime; it waits
  // for that build, and the index is valid only if that build succeeded.
  if (!(await readBm25IndexState()).valid) return "busy";
  log.info("Built the optional BM25 index for Mail search", { durationMs: Math.round(performance.now() - startedAt) });
  return "built";
};
