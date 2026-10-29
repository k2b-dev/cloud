import { sql } from "bun";

export async function migrateShareAccess(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('filesv2.share-access-migration', 0))`;
    // No share FK: revocation or removal must not erase retained access counts.
    await tx`CREATE TABLE IF NOT EXISTS filesv2.share_access (
      share_id uuid NOT NULL,
      hour timestamptz NOT NULL CHECK (hour=date_trunc('hour',hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
      network text NOT NULL CHECK (CASE WHEN network IN ('unknown','*') THEN true ELSE
        network=(network::cidr)::text AND
        ((family(network::cidr)=4 AND masklen(network::cidr)=24) OR (family(network::cidr)=6 AND masklen(network::cidr)=48)) END),
      client text NOT NULL CHECK (client IN ('firefox','chrome','safari','edge','samsung','opera','other','unknown')),
      pages bigint NOT NULL DEFAULT 0 CHECK (pages>=0),
      downloads bigint NOT NULL DEFAULT 0 CHECK (downloads>=0),
      password_failed bigint NOT NULL DEFAULT 0 CHECK (password_failed>=0),
      PRIMARY KEY(share_id,hour,network,client)
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS filesv2_share_access_hour ON filesv2.share_access(hour)`.simple();
    await tx`CREATE TABLE IF NOT EXISTS filesv2.share_access_daily (
      share_id uuid NOT NULL,
      day date NOT NULL,
      pages bigint NOT NULL DEFAULT 0 CHECK (pages>=0),
      downloads bigint NOT NULL DEFAULT 0 CHECK (downloads>=0),
      password_failed bigint NOT NULL DEFAULT 0 CHECK (password_failed>=0),
      PRIMARY KEY(share_id,day)
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS filesv2_share_access_daily_day ON filesv2.share_access_daily(day)`.simple();
  });
}
