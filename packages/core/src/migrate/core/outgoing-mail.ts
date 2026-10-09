import { ensureSchema } from "@k2b/cloud/services/postgres";
import { decryptValue } from "@k2b/cloud/services/settings/crypto";
import { type SQL, sql } from "bun";

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
    await tx`CREATE INDEX IF NOT EXISTS outgoing_mail_messages_ref ON outgoing_mail.messages(app_id, ref_scope, ref_id)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS outgoing_mail_messages_due ON outgoing_mail.messages(status, lane, profile_id, next_attempt_at)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS outgoing_mail_messages_quota ON outgoing_mail.messages(app_id, profile_id, created_at)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS outgoing_mail_messages_log ON outgoing_mail.messages(app_id, created_at DESC, id)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS outgoing_mail_messages_created ON outgoing_mail.messages(created_at, id)`.simple();
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
    await tx`CREATE INDEX IF NOT EXISTS outgoing_mail_messages_batch ON outgoing_mail.messages(batch_id) WHERE batch_id IS NOT NULL`.simple();
    await tx`CREATE INDEX IF NOT EXISTS outgoing_mail_messages_bulk_due ON outgoing_mail.messages(profile_id, (COALESCE(next_attempt_at, created_at)), id) WHERE status = 'queued' AND lane = 'bulk'`.simple();
    await tx`CREATE INDEX IF NOT EXISTS outgoing_mail_messages_bulk_deadline ON outgoing_mail.messages(deadline_at) WHERE status = 'queued' AND lane = 'bulk'`.simple();
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
  await buildSearchIndexes(db);
};

/** Send-log search indexes; built without blocking new mail, since the log can hold millions of rows. */
const searchIndexes = {
  outgoing_mail_messages_search: "USING gin (outgoing_mail.search_text(subject, to_addresses) gin_trgm_ops)",
  outgoing_mail_messages_recipients: "USING gin (outgoing_mail.lower_addresses(to_addresses))",
};
const buildSearchIndexes = async (db: SQL): Promise<void> => {
  // CONCURRENTLY cannot run in a transaction; a session lock keeps parallel Core replicas from racing.
  const connection = await db.reserve();
  try {
    // Poll instead of waiting inside a statement: a waiting statement holds a snapshot that the
    // other replica's concurrent build would wait for in turn.
    for (;;) {
      const [lock] = await connection<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtextextended('core.outgoing_mail.search_indexes', 0)) AS locked`;
      if (lock?.locked) break;
      await Bun.sleep(1000);
    }
    for (const [name, definition] of Object.entries(searchIndexes)) {
      const [index] = await connection<{ valid: boolean }[]>`SELECT i.indisvalid AS valid FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'outgoing_mail' AND c.relname = ${name}`;
      if (index?.valid) continue;
      // An interrupted concurrent build leaves an invalid index behind; rebuild it.
      if (index) await connection.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS outgoing_mail.${name}`).simple();
      await connection.unsafe(`CREATE INDEX CONCURRENTLY ${name} ON outgoing_mail.messages ${definition}`).simple();
    }
  } finally {
    await connection`SELECT pg_advisory_unlock(hashtextextended('core.outgoing_mail.search_indexes', 0))`.catch(() => {});
    connection.release();
  }
};
