import type { SQL } from "bun";
import { ensureSchema } from "../services/postgres";
import { withAppPwaTransaction } from "./transaction";

export const appPwaSchemaName = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("App-PWA schema must be a plain lowercase Postgres identifier");
  return name;
};

/** Must finish successfully in application setup before listening. No best-effort migration or memory authority. */
export const setupAppPwa = async (db: SQL, schemaName: string): Promise<void> => {
  const schema = appPwaSchemaName(schemaName);
  await withAppPwaTransaction(db, undefined, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`cloud:app-pwa:${schema}`}, 0))`;
    await ensureSchema(tx, schema);
    await tx
      .unsafe(`CREATE TABLE IF NOT EXISTS ${schema}._cloud_pwa_browsers (
      app_id text NOT NULL, credential_hash text NOT NULL, expires_at timestamptz NOT NULL,
      device_id uuid, PRIMARY KEY (app_id, credential_hash))`)
      .simple();
    await tx
      .unsafe(`CREATE TABLE IF NOT EXISTS ${schema}._cloud_pwa_devices (
      app_id text NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL, input_digest text NOT NULL,
      owner_user_id uuid NOT NULL, initiator_sid uuid NOT NULL, auth_epoch bigint NOT NULL,
      name text NOT NULL, secret_hash text NOT NULL, browser_hash text,
      state text NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
      issued_at timestamptz NOT NULL, qr_expires_at timestamptz NOT NULL,
      activated_at timestamptz, expires_at timestamptz, active_visit_id uuid,
      PRIMARY KEY (app_id, id), UNIQUE (app_id, owner_user_id, initiator_sid, request_id))`)
      .simple();
    await tx
      .unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS _cloud_pwa_device_secret ON ${schema}._cloud_pwa_devices(app_id, secret_hash)`)
      .simple();
    await tx
      .unsafe(`CREATE INDEX IF NOT EXISTS _cloud_pwa_device_owner ON ${schema}._cloud_pwa_devices(app_id, owner_user_id, id)`)
      .simple();
    await tx
      .unsafe(`CREATE TABLE IF NOT EXISTS ${schema}._cloud_pwa_visits (
      app_id text NOT NULL, id uuid NOT NULL, device_id uuid NOT NULL,
      request_id uuid NOT NULL, input_digest text NOT NULL, secret_hash text NOT NULL,
      subject jsonb NOT NULL, browser_hash text,
      state text NOT NULL CHECK (state IN ('pending', 'active', 'ended', 'revoked')),
      issued_at timestamptz NOT NULL, qr_expires_at timestamptz NOT NULL,
      activated_at timestamptz, last_used_at timestamptz, expires_at timestamptz,
      PRIMARY KEY (app_id, id), UNIQUE (app_id, device_id, request_id),
      FOREIGN KEY (app_id, device_id) REFERENCES ${schema}._cloud_pwa_devices(app_id, id))`)
      .simple();
    await tx
      .unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS _cloud_pwa_visit_secret ON ${schema}._cloud_pwa_visits(app_id, secret_hash)`)
      .simple();
    await tx
      .unsafe(`CREATE TABLE IF NOT EXISTS ${schema}._cloud_pwa_attempts (
      app_id text NOT NULL, visit_id uuid NOT NULL, attempt_id uuid NOT NULL,
      route text NOT NULL, input_digest text NOT NULL, result jsonb NOT NULL,
      PRIMARY KEY (app_id, visit_id, attempt_id),
      FOREIGN KEY (app_id, visit_id) REFERENCES ${schema}._cloud_pwa_visits(app_id, id))`)
      .simple();
  });
};
