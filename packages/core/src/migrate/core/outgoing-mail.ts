import { decryptValue } from "@k2b/cloud/services/settings/crypto";
import { type SQL, sql } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.outgoing_mail.migrations', 0))`;
    await tx`CREATE SCHEMA IF NOT EXISTS outgoing_mail`.simple();
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
    const [existing] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM outgoing_mail.profiles`;
    if (existing!.count) return;
    const rows = await tx<{ key: string; value: string }[]>`SELECT key, value FROM settings.entries WHERE key LIKE 'mail.noreply.%'`;
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const read = async (key: string, fallback: unknown) => {
      const value = stored.get(`mail.noreply.${key}`);
      return value === undefined ? fallback : await decryptValue(value);
    };
    const host = await read("smtp_host", "");
    if (typeof host !== "string" || !host.trim()) return;
    const port = Number(await read("smtp_port", 587));
    const from = String(await read("from", ""));
    const user = String(await read("user", ""));
    // Both stores use encryptValue/decryptValue: copy the authenticated ciphertext, never plaintext.
    const password = stored.get("mail.noreply.password") ?? null;
    await tx`INSERT INTO outgoing_mail.profiles(id, key, name, from_address, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password_encrypted, is_default)
      VALUES (${crypto.randomUUID()}::uuid, 'noreply', 'No-reply', ${from}, ${host}, ${port}, ${port === 465}, ${user || null}, ${password}, true)`;
  });
};
