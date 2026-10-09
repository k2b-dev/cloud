import { lazySync } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { ensureSchema } from "@k2b/cloud/services/postgres";
import { decryptValue } from "@k2b/cloud/services/settings/crypto";
import { type SQL, sql } from "bun";

const log = logger("core:outgoing-mail");

/**
 * The send log can hold millions of rows. Even when the index exists, CREATE INDEX waits for the lock
 * that a running concurrent build holds on the table, and new mail would queue behind it, so the
 * catalog is checked first.
 */
const ensureMessagesIndex = async (tx: SQL, name: string, definition: string): Promise<void> => {
  const [index] = await tx<{ present: boolean }[]>`SELECT to_regclass(${`outgoing_mail.${name}`}) IS NOT NULL AS present`;
  if (!index?.present) await tx.unsafe(`CREATE INDEX IF NOT EXISTS ${name} ON outgoing_mail.messages ${definition}`).simple();
};

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.outgoing_mail.migrations', 0))`;
    await ensureSchema(tx, "outgoing_mail");
    await tx`CREATE TABLE IF NOT EXISTS outgoing_mail.profiles (
      id UUID PRIMARY KEY, key TEXT NOT NULL UNIQUE CHECK(key ~ '^[a-z0-9][a-z0-9-]{0,62}$'), name TEXT NOT NULL,
      from_address TEXT NOT NULL, from_name TEXT, smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL CHECK(smtp_port BETWEEN 1 AND 65535), smtp_secure BOOLEAN NOT NULL,
      smtp_user TEXT, smtp_password_encrypted TEXT,
      pace_per_minute INTEGER NOT NULL DEFAULT 60 CHECK(pace_per_minute BETWEEN 1 AND 6000),
      daily_recipient_limit INTEGER CHECK(daily_recipient_limit >= 1),
      max_attachment_bytes INTEGER NOT NULL DEFAULT 15728640 CHECK(max_attachment_bytes BETWEEN 1 AND 26214400),
      next_bulk_slot_at TIMESTAMPTZ NOT NULL DEFAULT now(), is_default BOOLEAN NOT NULL DEFAULT false,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS outgoing_mail_one_default ON outgoing_mail.profiles(is_default) WHERE is_default`.simple();
    await tx`CREATE TABLE IF NOT EXISTS outgoing_mail.app_access (
      app_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('default','selected')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS outgoing_mail.app_profiles (
      app_id TEXT NOT NULL, profile_id UUID NOT NULL REFERENCES outgoing_mail.profiles(id) ON DELETE CASCADE,
      PRIMARY KEY(app_id, profile_id)
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS outgoing_mail.messages (
      id UUID PRIMARY KEY, app_id TEXT NOT NULL,
      profile_id UUID REFERENCES outgoing_mail.profiles(id) ON DELETE SET NULL, profile_key TEXT NOT NULL,
      batch_id UUID, lane TEXT NOT NULL CHECK(lane IN ('immediate','bulk')), idempotency_key TEXT,
      ref_scope TEXT, ref_id TEXT, to_addresses TEXT[] NOT NULL, recipient_count INTEGER NOT NULL,
      subject TEXT NOT NULL, text_body TEXT, html_body TEXT, headers JSONB,
      from_name TEXT, reply_to TEXT, message_id_header TEXT NOT NULL UNIQUE,
      attachments JSONB NOT NULL DEFAULT '[]', attachment_refs JSONB,
      status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','failed','bounced','cancelled')),
      error_code TEXT, error_message TEXT, smtp_response TEXT, failures JSONB NOT NULL DEFAULT '[]',
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, deadline_at TIMESTAMPTZ NOT NULL,
      actor_type TEXT, actor_id TEXT, actor_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ, bounced_at TIMESTAMPTZ,
      content_purged_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(app_id, idempotency_key)
    )`.simple();
    await ensureMessagesIndex(tx, "outgoing_mail_messages_ref", "(app_id, ref_scope, ref_id)");
    await ensureMessagesIndex(tx, "outgoing_mail_messages_due", "(status, lane, profile_id, next_attempt_at)");
    await ensureMessagesIndex(tx, "outgoing_mail_messages_quota", "(app_id, profile_id, created_at)");
    await ensureMessagesIndex(tx, "outgoing_mail_messages_log", "(app_id, created_at DESC, id)");
    await ensureMessagesIndex(tx, "outgoing_mail_messages_created", "(created_at, id)");
    const [existing] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM outgoing_mail.profiles`;
    if (existing!.count) return;
    const rows = await tx<{ key: string; value: string }[]>`SELECT key, value FROM settings.entries WHERE key LIKE 'mail.noreply.%'`;
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const read = async (key: string) => {
      const value = stored.get(`mail.noreply.${key}`);
      if (value === undefined) return undefined;
      try {
        return await decryptValue(value);
      } catch {
        console.warn(`[setup] outgoing-mail: ignored undecryptable legacy setting mail.noreply.${key}`);
        return undefined;
      }
    };
    const host = await read("smtp_host");
    if (typeof host !== "string" || !host.trim()) return;
    // Like the former number setting, accept numeric strings; anything outside 1-65535 falls back to its default.
    const storedPort = Number((await read("smtp_port")) ?? 587);
    const port = Number.isInteger(storedPort) && storedPort >= 1 && storedPort <= 65535 ? storedPort : 587;
    const from = await read("from");
    const user = await read("user");
    const decryptedPassword = await read("password");
    if (decryptedPassword !== undefined && typeof decryptedPassword !== "string")
      console.warn("[setup] outgoing-mail: ignored invalid legacy setting mail.noreply.password");
    // Both stores use encryptValue/decryptValue: copy the authenticated ciphertext, never plaintext.
    const password = typeof decryptedPassword === "string" ? (stored.get("mail.noreply.password") ?? null) : null;
    await tx`INSERT INTO outgoing_mail.profiles(id, key, name, from_address, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password_encrypted, is_default)
      VALUES (${crypto.randomUUID()}::uuid, 'noreply', 'No-reply', ${typeof from === "string" ? from : ""}, ${host}, ${port}, ${port === 465}, ${typeof user === "string" && user ? user : null}, ${password}, true)`;
  });
  // Additive, repeatable step: also runs when the original profile import returns early.
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.outgoing_mail.migrations', 0))`;
    await ensureMessagesIndex(tx, "outgoing_mail_messages_batch", "(batch_id) WHERE batch_id IS NOT NULL");
    await ensureMessagesIndex(
      tx,
      "outgoing_mail_messages_bulk_due",
      "(profile_id, (COALESCE(next_attempt_at, created_at)), id) WHERE status = 'queued' AND lane = 'bulk'",
    );
    await ensureMessagesIndex(tx, "outgoing_mail_messages_bulk_deadline", "(deadline_at) WHERE status = 'queued' AND lane = 'bulk'");
  });
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.outgoing_mail.migrations', 0))`;
    await tx`ALTER TABLE outgoing_mail.profiles
      ADD COLUMN IF NOT EXISTS imap_host TEXT,
      ADD COLUMN IF NOT EXISTS imap_port INTEGER CHECK(imap_port BETWEEN 1 AND 65535),
      ADD COLUMN IF NOT EXISTS imap_secure BOOLEAN,
      ADD COLUMN IF NOT EXISTS imap_user TEXT,
      ADD COLUMN IF NOT EXISTS imap_password_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS imap_folder TEXT,
      ADD COLUMN IF NOT EXISTS imap_uid_validity BIGINT,
      ADD COLUMN IF NOT EXISTS imap_last_uid BIGINT,
      ADD COLUMN IF NOT EXISTS imap_checked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS imap_error TEXT`.simple();
  });
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.outgoing_mail.migrations', 0))`;
    await tx`CREATE EXTENSION IF NOT EXISTS pg_trgm`.simple();
    await tx`CREATE TABLE IF NOT EXISTS outgoing_mail.app_log_access (
      app_id TEXT NOT NULL, source_app_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT,
      PRIMARY KEY(app_id, source_app_id), CHECK(app_id <> source_app_id), CHECK(source_app_id <> 'core')
    )`.simple();
    await tx`CREATE OR REPLACE FUNCTION outgoing_mail.search_text(subject pg_catalog.text, addresses pg_catalog.text[])
      RETURNS pg_catalog.text LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $$ SELECT pg_catalog.lower(subject OPERATOR(pg_catalog.||) E'\\n' OPERATOR(pg_catalog.||)
        pg_catalog.array_to_string(addresses, E'\\n')) $$`.simple();
    await tx`CREATE OR REPLACE FUNCTION outgoing_mail.lower_addresses(addresses pg_catalog.text[])
      RETURNS pg_catalog.text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $$ SELECT ARRAY(SELECT pg_catalog.lower(address) FROM pg_catalog.unnest(addresses) AS address) $$`.simple();
  });
};

/** Send-log search indexes on recipients and subjects. */
const searchIndexes = {
  outgoing_mail_messages_search: "USING gin (outgoing_mail.search_text(subject, to_addresses) gin_trgm_ops)",
  outgoing_mail_messages_recipients: "USING gin (outgoing_mail.lower_addresses(to_addresses))",
} as const;
type SearchIndex = keyof typeof searchIndexes;
type BuildOutcome = "ready" | "busy" | "built" | "failed";

/**
 * One Core process builds at a time: two builds on the same table wait for each other, and Postgres
 * cancels one of them. The lease is renewed while the build runs.
 */
const SEARCH_INDEX_LEASE_MS = 60_000;
const searchIndexBuildMutex = lazySync((sync) =>
  sync.mutex({ id: "core:outgoing-mail:search-index-build", ttlMs: SEARCH_INDEX_LEASE_MS, retry: { maxAttempts: 1 } }),
);

/**
 * The index as the database sees it. `building` is any index build on the send log, in any process.
 * Postgres hides what another role builds, so any build of another role in this database counts.
 */
const readSearchIndex = async (db: SQL, name: SearchIndex) => {
  const index = `outgoing_mail.${name}`;
  const [state] = await db<{ present: boolean; valid: boolean; building: boolean }[]>`
    SELECT to_regclass(${index}) IS NOT NULL AS present,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = to_regclass(${index}) AND indisvalid AND indisready AND indislive) AS valid,
      EXISTS (SELECT 1 FROM pg_catalog.pg_stat_progress_create_index progress
        WHERE progress.datname = pg_catalog.current_database()
          AND (progress.relid = to_regclass('outgoing_mail.messages') OR progress.relid IS NULL)) AS building`;
  return state ?? { present: false, valid: false, building: false };
};

const dropSearchIndex = (db: SQL, name: SearchIndex) => db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS outgoing_mail.${name}`).simple();

const buildSearchIndex = async (db: SQL, name: SearchIndex): Promise<BuildOutcome> => {
  const before = await readSearchIndex(db, name);
  if (before.valid) return "ready";
  if (before.building) return "busy";
  // IF NOT EXISTS would keep an invalid index, such as one whose build was interrupted.
  if (before.present) await dropSearchIndex(db, name);
  log.info("Building a send log search index", { index: name });
  const startedAt = performance.now();
  try {
    await db.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON outgoing_mail.messages ${searchIndexes[name]}`).simple();
  } catch (error) {
    const after = await readSearchIndex(db, name);
    if (after.valid) return "ready";
    if (after.building) return "busy";
    log.warn("A send log search index was not built; searches run without it until the next start", {
      index: name,
      error: error instanceof Error ? error.message : String(error),
    });
    await dropSearchIndex(db, name);
    return "failed";
  }
  // IF NOT EXISTS skips the build when another build created the index meanwhile; it is valid only if that build succeeded.
  if (!(await readSearchIndex(db, name)).valid) return "busy";
  log.info("Built a send log search index", { index: name, durationMs: Math.round(performance.now() - startedAt) });
  return "built";
};

/**
 * Builds the send-log search indexes after Core's setup, without blocking new mail or Core's start;
 * searches run without them until they are valid. One process builds at a time through a NATS lease.
 * An index left invalid by an interrupted build is replaced, and one that another process still builds
 * is left to the next start. Every database step is one statement without session state, so a
 * transaction pooler may send each to another backend. Never throws.
 */
export const buildSearchIndexes = async (db: SQL = sql): Promise<BuildOutcome> => {
  try {
    const names = Object.keys(searchIndexes) as SearchIndex[];
    if ((await Promise.all(names.map((name) => readSearchIndex(db, name)))).every((state) => state.valid)) return "ready";
    const mutex = searchIndexBuildMutex();
    const lease = await mutex.acquire({ resource: "send-log-search" });
    if (!lease) return "busy";
    const renewal = setInterval(() => void mutex.extend(lease).catch(() => false), SEARCH_INDEX_LEASE_MS / 3);
    renewal.unref();
    try {
      let outcome: BuildOutcome = "ready";
      for (const name of names) {
        const built = await buildSearchIndex(db, name);
        if (built === "busy" || built === "failed") return built;
        if (built === "built") outcome = "built";
      }
      return outcome;
    } finally {
      clearInterval(renewal);
      await mutex.release(lease).catch(() => false);
    }
  } catch (error) {
    log.warn("Send log search indexes are unavailable; searches run without them", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
};
