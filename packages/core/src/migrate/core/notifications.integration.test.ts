import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "./notifications";

const canRun = async (): Promise<boolean> => {
  if (!process.env.APP_SECRET) return false;
  try {
    const [row] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    return Boolean(row?.users);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canRun()) ? describe : describe.skip;

suite("notification migration", () => {
  test("scrubs legacy terminal payloads and requires payloads for retryable states", async () => {
    await migrate();

    const suffix = crypto.randomUUID();
    const definitionId = `migration-test.${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`notification-migration-${suffix}`}, 'local', 'user', 'Notification Migration', ${`migration-${suffix}@example.test`}, 'Notification', 'Migration')
      RETURNING id
    `;

    try {
      await sql`ALTER TABLE notifications.events DROP CONSTRAINT IF EXISTS notification_events_target_href_safe_check`.simple();
      await sql`DROP TRIGGER IF EXISTS notification_deliveries_redact_terminal_payload ON notifications.deliveries`.simple();
      await sql`ALTER TABLE notifications.deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_payload_state_check`.simple();
      await sql`
        INSERT INTO notifications.definitions (id, app_id, kind, label, description, recipient_kind)
        VALUES (${definitionId}, 'migration-test', ${suffix}, 'Migration test', 'Migration test definition.', 'user')
      `;
      const [event] = await sql<{ id: string }[]>`
        INSERT INTO notifications.events (definition_id, recipient_user_id, recipient_key, idempotency_key, title, target_href)
        VALUES (${definitionId}, ${user!.id}::uuid, ${`user:${user!.id}`}, ${suffix}, 'Migration test', ${"/\\evil.example"})
        RETURNING id
      `;
      await sql`
        INSERT INTO notifications.deliveries (
          event_id, channel, destination_key, destination_label, payload_encrypted, status
        ) VALUES (${event!.id}::uuid, 'email', 'legacy', 'Legacy', 'encrypted-sensitive-payload', 'delivered')
      `;

      await migrate();

      const [delivery] = await sql<{ payload_encrypted: string | null; target_href: string | null }[]>`
        SELECT d.payload_encrypted, e.target_href
        FROM notifications.deliveries d
        JOIN notifications.events e ON e.id = d.event_id
        WHERE d.event_id = ${event!.id}::uuid
      `;
      expect(delivery?.payload_encrypted).toBeNull();
      expect(delivery?.target_href).toBeNull();
      const [guards] = await sql<
        {
          payload_constraint_validated: boolean;
          target_constraint_validated: boolean;
          trigger_exists: boolean;
        }[]
      >`
        SELECT COALESCE((
          SELECT convalidated FROM pg_constraint
          WHERE conname = 'notification_deliveries_payload_state_check'
            AND conrelid = 'notifications.deliveries'::regclass
        ), false) AS payload_constraint_validated,
        COALESCE((
          SELECT convalidated FROM pg_constraint
          WHERE conname = 'notification_events_target_href_safe_check'
            AND conrelid = 'notifications.events'::regclass
        ), false) AS target_constraint_validated,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'notification_deliveries_redact_terminal_payload'
            AND tgrelid = 'notifications.deliveries'::regclass
        ) AS trigger_exists
      `;
      expect(guards).toEqual({ payload_constraint_validated: true, target_constraint_validated: true, trigger_exists: true });
      const [indexes] = await sql<{ delivery_created: boolean; event_definition_created: boolean; definition_presentation: boolean }[]>`
        SELECT
          to_regclass('notifications.idx_notification_deliveries_created') IS NOT NULL AS delivery_created,
          to_regclass('notifications.idx_notification_events_definition_created') IS NOT NULL AS event_definition_created,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'notifications'
              AND table_name = 'definitions'
              AND column_name = 'presentation'
              AND data_type = 'jsonb'
          ) AS definition_presentation
      `;
      expect(indexes).toEqual({ delivery_created: true, event_definition_created: true, definition_presentation: true });
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
      await sql`DELETE FROM notifications.definitions WHERE id = ${definitionId}`;
      await migrate();
    }
  });
});
