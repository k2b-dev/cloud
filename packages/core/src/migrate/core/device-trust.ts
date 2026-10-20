import { type SQL, sql } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.device_trust.migrations', 0))`;
    await tx`CREATE TABLE IF NOT EXISTS auth.device_trust_state (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      started_at timestamptz NOT NULL DEFAULT now(),
      geoip_since timestamptz
    )`.simple();
    await tx`INSERT INTO auth.device_trust_state (id) VALUES (true) ON CONFLICT DO NOTHING`;
    await tx`CREATE TABLE IF NOT EXISTS auth.known_browsers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      browser_hash bytea NOT NULL CHECK (octet_length(browser_hash) = 32),
      browser text NOT NULL,
      os text NOT NULL,
      country char(2),
      city text CHECK (octet_length(city) <= 96),
      first_seen_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL,
      notified_at timestamptz,
      UNIQUE (user_id, browser_hash)
    )`.simple();
    const columns = new Set(
      (
        await tx<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'auth' AND table_name = 'known_browsers' AND column_name IN ('notice', 'notice_attempted_at')`
      ).map((row) => row.column_name),
    );
    if (!columns.has("notice")) {
      await tx`LOCK TABLE auth.known_browsers IN ACCESS EXCLUSIVE MODE`;
      await tx`UPDATE auth.known_browsers SET notified_at = first_seen_at WHERE notified_at IS NULL`;
      await tx`ALTER TABLE auth.known_browsers ADD COLUMN notice jsonb CHECK (notice IS NULL OR octet_length(notice::text) <= 1024)`.simple();
    }
    // A failed notice's last attempt; the catch-up batch takes the least recently tried first.
    if (!columns.has("notice_attempted_at")) await tx`ALTER TABLE auth.known_browsers ADD COLUMN notice_attempted_at timestamptz`.simple();
    await tx`CREATE INDEX IF NOT EXISTS known_browsers_last_seen ON auth.known_browsers (last_seen_at)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS known_browsers_unnotified ON auth.known_browsers (user_id) WHERE notified_at IS NULL`.simple();
    await tx`CREATE TABLE IF NOT EXISTS auth.sign_in_countries (
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      country char(2) NOT NULL,
      last_seen_at timestamptz NOT NULL,
      PRIMARY KEY (user_id, country)
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS sign_in_countries_last_seen ON auth.sign_in_countries (last_seen_at)`.simple();
  });
};
