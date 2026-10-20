import { sql } from "bun";

export const migrate = async (db: typeof sql = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.geoip.migrations', 0))`;
    await tx`CREATE SCHEMA IF NOT EXISTS geoip`.simple();
    await tx`
      CREATE TABLE IF NOT EXISTS geoip.databases (
        kind text PRIMARY KEY CHECK (kind IN ('city', 'asn')),
        data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 201326592),
        sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        database_type text NOT NULL CHECK (octet_length(database_type) <= 128),
        build_epoch timestamptz NOT NULL,
        metadata jsonb NOT NULL CHECK (octet_length(metadata::text) <= 4096),
        uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
        uploaded_at timestamptz NOT NULL DEFAULT now()
      )`.simple();
    await tx`ALTER TABLE geoip.databases ALTER COLUMN data SET STORAGE EXTERNAL`.simple();
  });
};
