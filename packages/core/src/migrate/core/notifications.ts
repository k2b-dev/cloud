import { sql } from "bun";

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS notifications`.simple();
  console.log("  ✓ notifications schema");

  await sql`
    CREATE TABLE IF NOT EXISTS notifications.messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT NOT NULL DEFAULT 'email',
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      sent_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
    )
  `.simple();
  console.log("  ✓ notifications.messages table");

  await sql`
    CREATE TABLE IF NOT EXISTS notifications.definitions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      presentation JSONB,
      recipient_kind TEXT NOT NULL,
      recommended_channels TEXT[] NOT NULL DEFAULT '{}',
      required_channels TEXT[] NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT true,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT notification_definitions_recipient_kind_check
        CHECK (recipient_kind IN ('user', 'email')),
      UNIQUE (app_id, kind)
    )
  `.simple();
  await sql`
    ALTER TABLE notifications.definitions
    ADD COLUMN IF NOT EXISTS presentation JSONB
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS notifications.preferences (
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      definition_id TEXT NOT NULL REFERENCES notifications.definitions(id) ON DELETE CASCADE,
      channels TEXT[] NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, definition_id)
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS notifications.endpoints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      endpoint_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      verified_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, channel, endpoint_hash)
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS notifications.events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      definition_id TEXT NOT NULL REFERENCES notifications.definitions(id),
      recipient_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      recipient_email TEXT,
      recipient_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      title TEXT NOT NULL,
      target_href TEXT,
      sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT notification_events_recipient_check CHECK (
        (recipient_user_id IS NOT NULL AND recipient_email IS NULL)
        OR (recipient_user_id IS NULL AND recipient_email IS NOT NULL)
      ),
      CONSTRAINT notification_events_target_href_check CHECK (
        target_href IS NULL OR (left(target_href, 1) = '/' AND left(target_href, 2) <> '//')
      ),
      UNIQUE (definition_id, recipient_key, idempotency_key)
    )
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notification_events_target_href_safe_check'
          AND conrelid = 'notifications.events'::regclass
      ) THEN
        ALTER TABLE notifications.events
        ADD CONSTRAINT notification_events_target_href_safe_check CHECK (
          target_href IS NULL OR (
            left(target_href, 1) = '/'
            AND left(target_href, 2) <> '//'
            AND strpos(target_href, chr(92)) = 0
            AND target_href !~ '[[:cntrl:]]'
          )
        ) NOT VALID;
      END IF;
    END
    $$
  `.simple();
  await sql`
    UPDATE notifications.events
    SET target_href = NULL
    WHERE target_href IS NOT NULL
      AND (
        left(target_href, 1) <> '/'
        OR left(target_href, 2) = '//'
        OR strpos(target_href, chr(92)) > 0
        OR target_href ~ '[[:cntrl:]]'
      )
  `.simple();
  await sql`
    ALTER TABLE notifications.events
    VALIDATE CONSTRAINT notification_events_target_href_safe_check
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS notifications.deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES notifications.events(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      endpoint_id UUID REFERENCES notifications.endpoints(id) ON DELETE SET NULL,
      destination_key TEXT NOT NULL,
      destination_label TEXT NOT NULL,
      payload_encrypted TEXT,
      required BOOLEAN NOT NULL DEFAULT false,
      route_priority INTEGER,
      status TEXT NOT NULL DEFAULT 'deferred',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT notification_deliveries_status_check CHECK (
        status IN ('deferred', 'pending', 'sending', 'delivered', 'suppressed', 'failed')
      ),
      CONSTRAINT notification_deliveries_attempt_count_check CHECK (attempt_count >= 0),
      UNIQUE (event_id, channel, destination_key)
    )
  `.simple();
  await sql`ALTER TABLE notifications.deliveries ALTER COLUMN payload_encrypted DROP NOT NULL`.simple();
  await sql`
    CREATE OR REPLACE FUNCTION notifications.redact_terminal_delivery_payload()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.status IN ('delivered', 'suppressed', 'failed') THEN
        NEW.payload_encrypted = NULL;
      END IF;
      RETURN NEW;
    END
    $$
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'notification_deliveries_redact_terminal_payload'
          AND tgrelid = 'notifications.deliveries'::regclass
      ) THEN
        CREATE TRIGGER notification_deliveries_redact_terminal_payload
        BEFORE INSERT OR UPDATE OF status, payload_encrypted ON notifications.deliveries
        FOR EACH ROW EXECUTE FUNCTION notifications.redact_terminal_delivery_payload();
      END IF;
    END
    $$
  `.simple();
  await sql`ALTER TABLE notifications.deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_payload_check`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notification_deliveries_payload_state_check'
          AND conrelid = 'notifications.deliveries'::regclass
      ) THEN
        ALTER TABLE notifications.deliveries
        ADD CONSTRAINT notification_deliveries_payload_state_check CHECK (
          (status IN ('delivered', 'suppressed', 'failed') AND payload_encrypted IS NULL)
          OR (status IN ('deferred', 'pending', 'sending') AND payload_encrypted IS NOT NULL)
        ) NOT VALID;
      END IF;
    END
    $$
  `.simple();
  await sql`
    UPDATE notifications.deliveries
    SET payload_encrypted = NULL, updated_at = now()
    WHERE status IN ('delivered', 'suppressed', 'failed') AND payload_encrypted IS NOT NULL
  `.simple();
  await sql`
    ALTER TABLE notifications.deliveries
    VALIDATE CONSTRAINT notification_deliveries_payload_state_check
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_definitions_app
    ON notifications.definitions(app_id, active, id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_events_recipient
    ON notifications.events(recipient_user_id, created_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_events_definition_created
    ON notifications.events(definition_id, created_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_dispatch
    ON notifications.deliveries(status, next_attempt_at, created_at)
    WHERE status IN ('pending', 'sending')
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event
    ON notifications.deliveries(event_id, required, route_priority, status)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
    ON notifications.deliveries(created_at DESC, id DESC)
  `.simple();
  await sql`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (PARTITION BY channel, endpoint_hash ORDER BY last_seen_at DESC, created_at DESC, id DESC) AS rank
      FROM notifications.endpoints
      WHERE disabled_at IS NULL
    )
    UPDATE notifications.endpoints e
    SET disabled_at = now(), updated_at = now()
    FROM ranked r
    WHERE e.id = r.id AND r.rank > 1
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_endpoints_active_destination
    ON notifications.endpoints(channel, endpoint_hash)
    WHERE disabled_at IS NULL
  `.simple();
  console.log("  ✓ end-user notification tables");

  await sql`
    CREATE TABLE IF NOT EXISTS notifications.batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subject TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      body_html TEXT NOT NULL,
      selection JSONB NOT NULL DEFAULT '{}'::jsonb,
      selection_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      finalized_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finalized_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      target_count INTEGER NOT NULL DEFAULT 0,
      deliverable_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      CONSTRAINT notification_batches_status_check CHECK (
        status IN ('draft', 'ready', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')
      )
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_batches_status_created
    ON notifications.batches(status, created_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_batches_created_by
    ON notifications.batches(created_by, created_at DESC)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS notifications.batch_recipients (
      batch_id UUID NOT NULL REFERENCES notifications.batches(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      recipient TEXT,
      uid TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      profile TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      notification_id UUID REFERENCES notifications.messages(id) ON DELETE SET NULL,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      sent_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (batch_id, user_id),
      CONSTRAINT notification_batch_recipients_status_check CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'error'))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_batch_recipients_status
    ON notifications.batch_recipients(batch_id, status)
  `.simple();
  console.log("  ✓ notifications batch tables");
};
