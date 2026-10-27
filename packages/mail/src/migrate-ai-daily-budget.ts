import type { sql } from "bun";

/** Independent of summary storage and the workflow runtime; safe on every startup. */
export const migrateAiDailyBudget = async (db: typeof sql): Promise<void> => {
  await db`ALTER TABLE mail.mailboxes ADD COLUMN IF NOT EXISTS ai_calls_per_day integer
    CHECK (ai_calls_per_day IS NULL OR ai_calls_per_day >= 0)`.simple();
  await db`
    CREATE TABLE IF NOT EXISTS mail.ai_daily_mailbox_usage (
      mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      day date NOT NULL,
      reserved_calls bigint NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
      consumed_calls bigint NOT NULL DEFAULT 0 CHECK (consumed_calls >= 0),
      PRIMARY KEY (mailbox_id, day)
    )
  `.simple();
  await db`
    CREATE TABLE IF NOT EXISTS mail.ai_daily_source_usage (
      mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      source_id text NOT NULL CHECK (length(trim(source_id)) > 0),
      day date NOT NULL,
      reserved_calls bigint NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
      consumed_calls bigint NOT NULL DEFAULT 0 CHECK (consumed_calls >= 0),
      PRIMARY KEY (mailbox_id, source_id, day)
    )
  `.simple();
  await db`
    CREATE TABLE IF NOT EXISTS mail.ai_daily_reservations (
      mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      source_id text NOT NULL CHECK (length(trim(source_id)) > 0),
      reservation_key text NOT NULL CHECK (length(trim(reservation_key)) > 0),
      source_name text NOT NULL,
      day date NOT NULL,
      time_zone text NOT NULL,
      resets_at timestamptz NOT NULL,
      planned_calls integer NOT NULL CHECK (planned_calls >= 0),
      consumed_calls integer NOT NULL DEFAULT 0 CHECK (consumed_calls >= 0 AND consumed_calls <= planned_calls),
      state text NOT NULL CHECK (state IN ('reserved', 'released', 'consumed')),
      PRIMARY KEY (mailbox_id, source_id, reservation_key)
    )
  `.simple();
};
