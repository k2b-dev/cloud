import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { notificationObservability } from "./observability";

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

suite("notification observability", () => {
  test("filters metadata-only deliveries and reports the durable definition registry", async () => {
    const suffix = crypto.randomUUID();
    const appId = `notification-observability-${suffix}`;
    const definitionId = `${appId}.completed`;
    const eventId = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (
        ${`notification-observability-${suffix}`}, 'local', 'user', 'Observability Recipient',
        ${`notification-observability-${suffix}@example.test`}, 'Observability', 'Recipient'
      )
      RETURNING id
    `;
    if (!user) throw new Error("Notification observability fixture user was not created");

    try {
      await sql`
        INSERT INTO notifications.definitions (
          id, app_id, kind, label, description, recipient_kind,
          recommended_channels, required_channels
        ) VALUES (
          ${definitionId}, ${appId}, 'completed', 'Completed work',
          'A notification observability integration fixture.', 'user',
          '{browser}'::text[], '{email}'::text[]
        )
      `;
      await sql`
        INSERT INTO notifications.events (
          id, definition_id, recipient_user_id, recipient_key, idempotency_key, title, target_href
        ) VALUES (
          ${eventId}::uuid, ${definitionId}, ${user.id}::uuid, ${`user:${user.id}`},
          ${`observability:${suffix}`}, 'Failed fixture delivery', '/app/fixture/result'
        )
      `;
      await sql`
        INSERT INTO notifications.deliveries (
          event_id, channel, destination_key, destination_label, required,
          route_priority, status, attempt_count, delivered_at, error_code, error_message
        ) VALUES
          (${eventId}::uuid, 'email', 'email-fixture', 'o***@example.test', true, NULL, 'delivered', 1, now(), NULL, NULL),
          (${eventId}::uuid, 'browser', 'browser-fixture', 'Test browser', false, 0, 'failed', 5, NULL, 'provider_error', 'Fixture failure')
      `;

      const deliveries = await notificationObservability.deliveries.list({
        filter: { appIds: [appId], channels: ["browser"], statuses: ["failed"], search: "fixture" },
      });
      expect(deliveries.total).toBe(1);
      expect(deliveries.items[0]).toEqual(
        expect.objectContaining({
          appId,
          definitionId,
          title: "Failed fixture delivery",
          recipientLabel: "Observability Recipient",
          channel: "browser",
          status: "failed",
          errorCode: "provider_error",
        }),
      );
      expect(deliveries.items[0] && "body" in deliveries.items[0]).toBe(false);

      const filter = { appIds: [appId], channels: ["browser"], statuses: ["failed"] as const };
      const summary = await notificationObservability.deliveries.summary({ days: 7, filter });
      expect(summary).toMatchObject({ total: 1, failed: 1, active: 0, delivered: 0 });
      const timeseries = await notificationObservability.deliveries.timeseries({ days: 7, filter });
      expect(timeseries.length).toBeGreaterThanOrEqual(28);
      expect(timeseries.length).toBeLessThanOrEqual(30);
      expect(timeseries.reduce((sum, point) => sum + point.total, 0)).toBe(1);
      expect(timeseries.reduce((sum, point) => sum + point.failed, 0)).toBe(1);

      const registry = await notificationObservability.registry.list({ filter: { appIds: [appId], active: true } });
      expect(registry.total).toBe(1);
      expect(registry.items[0]).toEqual(
        expect.objectContaining({
          id: definitionId,
          recommendedChannels: ["browser"],
          requiredChannels: ["email"],
          eventCount7d: 1,
          failedDeliveryCount7d: 1,
        }),
      );

      const facetValues = await notificationObservability.facets();
      expect(facetValues.appIds).toContain(appId);
      expect(facetValues.channels).toEqual(expect.arrayContaining(["browser", "email"]));
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
      await sql`DELETE FROM notifications.definitions WHERE id = ${definitionId}`;
    }
  });
});
