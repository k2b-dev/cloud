import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "../../../../core/src/migrate/core/notifications";
import { encryptSecret } from "../secrets";

const suite = databaseSuite();

suite("principal notification migration compatibility", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("principal_notifications_migration");
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY)`.simple();
    await sql`CREATE TABLE auth.service_accounts(id UUID PRIMARY KEY)`.simple();
    await migrate();
    // Reproduce the preceding deployment's restrictive catalog and event schema.
    await sql`ALTER TABLE notifications.events DROP CONSTRAINT notification_events_recipient_check`.simple();
    await sql`ALTER TABLE notifications.events DROP COLUMN recipient_service_account_id, DROP COLUMN resource_type, DROP COLUMN resource_id`.simple();
    await sql`ALTER TABLE notifications.events ADD CONSTRAINT notification_events_recipient_check CHECK (
      (recipient_user_id IS NOT NULL AND recipient_email IS NULL) OR (recipient_user_id IS NULL AND recipient_email IS NOT NULL)
    )`.simple();
    await sql`ALTER TABLE notifications.definitions DROP CONSTRAINT notification_definitions_recipient_kind_check,
      ADD CONSTRAINT notification_definitions_recipient_kind_check CHECK (recipient_kind IN ('user', 'email'))`.simple();
    await sql`ALTER TABLE notifications.deliveries DROP CONSTRAINT notification_deliveries_payload_state_check,
      ADD CONSTRAINT notification_deliveries_payload_state_check CHECK (
        (status IN ('delivered', 'suppressed', 'failed') AND payload_encrypted IS NULL)
        OR (status IN ('deferred', 'pending', 'sending') AND payload_encrypted IS NOT NULL)
      )`.simple();
    await sql`CREATE OR REPLACE FUNCTION notifications.redact_terminal_delivery_payload() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status IN ('delivered', 'suppressed', 'failed') THEN NEW.payload_encrypted = NULL; END IF;
        RETURN NEW;
      END
    $$`.simple();
  });
  afterAll(async () => {
    await sql.close();
    await database?.drop();
  });

  test("upgrades the old schema, preserves legacy records, retains encrypted inbox payloads and repeats safely", async () => {
    const userId = "427d0490-9f5a-4a1d-aeda-9353dbf3a2ad";
    const accountId = "62197110-9d11-4688-aa5c-a61435caa895";
    const userEvent = "94369f83-6f50-4c73-9a6c-3ebfb4c507d4";
    const agentEvent = "fe9228f1-7ec9-400b-8a84-5acbf1edb849";
    await sql`INSERT INTO auth.users VALUES (${userId}::uuid)`;
    await sql`INSERT INTO auth.service_accounts VALUES (${accountId}::uuid)`;
    await sql`INSERT INTO notifications.definitions(id, app_id, kind, label, description, recipient_kind)
      VALUES ('test.old', 'test', 'old', 'Old', 'Existing human notification', 'user')`;
    await sql`INSERT INTO notifications.events(id, definition_id, recipient_user_id, recipient_key, idempotency_key, title)
      VALUES (${userEvent}::uuid, 'test.old', ${userId}::uuid, 'old-user', 'old-key', 'Old notice')`;
    await sql`INSERT INTO notifications.deliveries(event_id, channel, destination_key, destination_label, status)
      VALUES (${userEvent}::uuid, 'email', 'old-destination', 'Email', 'delivered')`;
    await migrate();
    await sql`INSERT INTO notifications.definitions(id, app_id, kind, label, description, recipient_kind)
      VALUES ('test.principal', 'test', 'principal', 'Principal', 'Independent principal notification', 'principal')`;
    await sql`INSERT INTO notifications.events(id, definition_id, recipient_service_account_id, recipient_key, idempotency_key, title)
      VALUES (${agentEvent}::uuid, 'test.principal', ${accountId}::uuid, 'agent', 'key', 'Agent notice')`;
    const encrypted = await encryptSecret({ title: "Agent notice", body: "Encrypted private body", targetHref: null });
    await sql`INSERT INTO notifications.deliveries(event_id, channel, destination_key, destination_label, status, payload_encrypted)
      VALUES (${agentEvent}::uuid, 'inbox', 'inbox', 'Inbox', 'pending', ${encrypted})`;
    await sql`UPDATE notifications.deliveries SET status = 'delivered', delivered_at = now() WHERE event_id = ${agentEvent}::uuid`;
    const constraints = () => sql<
      { conname: string; oid: string; convalidated: boolean }[]
    >`SELECT conname, oid::text AS oid, convalidated FROM pg_constraint
      WHERE connamespace = 'notifications'::regnamespace AND conname IN (
        'notification_definitions_recipient_kind_check', 'notification_events_recipient_check', 'notification_deliveries_payload_state_check'
      ) ORDER BY conname`;
    const beforeRepeat = await constraints();
    expect(beforeRepeat).toHaveLength(3);
    await migrate();
    await migrate();
    expect(await constraints()).toEqual(beforeRepeat);
    expect(beforeRepeat.every((row) => row.convalidated)).toBe(true);
    expect(
      (await sql`SELECT payload_encrypted FROM notifications.deliveries WHERE event_id = ${agentEvent}::uuid`)[0]?.payload_encrypted,
    ).toBe(encrypted);
    expect((await sql`SELECT status, payload_encrypted FROM notifications.deliveries WHERE event_id = ${userEvent}::uuid`)[0]).toEqual({
      status: "delivered",
      payload_encrypted: null,
    });
    // Bun SQL queries are lazy; start them before handing them to the rejection matcher.
    await expect(
      sql`UPDATE notifications.events SET recipient_user_id = ${userId}::uuid WHERE id = ${agentEvent}::uuid`.execute(),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE notifications.events SET recipient_service_account_id = NULL WHERE id = ${agentEvent}::uuid`.execute(),
    ).rejects.toThrow();
    await sql`INSERT INTO notifications.deliveries(event_id, channel, destination_key, destination_label, status, payload_encrypted)
      VALUES (${userEvent}::uuid, 'email', 'new-human-email', 'Email', 'pending', ${encrypted})`;
    await sql`UPDATE notifications.deliveries SET status = 'delivered' WHERE destination_key = 'new-human-email'`;
    expect(
      (await sql`SELECT payload_encrypted FROM notifications.deliveries WHERE destination_key = 'new-human-email'`)[0]?.payload_encrypted,
    ).toBeNull();
    await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
    expect(await sql`SELECT id FROM notifications.events WHERE id = ${agentEvent}::uuid`).toHaveLength(0);
    expect(await sql`SELECT id FROM notifications.deliveries WHERE event_id = ${agentEvent}::uuid`).toHaveLength(0);
  });
});
