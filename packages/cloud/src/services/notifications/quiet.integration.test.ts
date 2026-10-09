import { expect } from "bun:test";
import { sql } from "bun";
import { z } from "zod";
import { databaseSuite, testFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { defineApp, notification } from "../..";
import { notifications } from ".";
import { browserNotifications } from "./browser";
import { processNotificationDelivery, recoverNotificationDeliveries } from "./dispatcher";
import { userNotifications } from "./user";

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

type DeliveryState = {
  id: string;
  channel: string;
  required: boolean;
  status: string;
  error_code: string | null;
  attempt_count: number;
  payload_encrypted: string | null;
};

const deliveriesOf = (eventId: string) => sql<DeliveryState[]>`
  SELECT id, channel, required, status, error_code, attempt_count, payload_encrypted
  FROM notifications.deliveries WHERE event_id = ${eventId}::uuid ORDER BY required DESC, route_priority NULLS FIRST, created_at
`;

suite("notification quiet time delivery", () => {
  testFor("database", "nats")("holds back browser notifications without rerouting or replaying them", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`notification-quiet-${suffix}`}, 'local', 'user', 'Quiet Test', ${`quiet-${suffix}@example.test`}, 'Quiet', 'Test')
      RETURNING id
    `;
    const userId = user!.id;
    const subscription = {
      endpoint: `https://push.example.test/subscriptions/${suffix}`,
      expirationTime: null,
      keys: { p256dh: "p".repeat(65), auth: "a".repeat(24) },
    };
    const app = defineApp({
      id: "notification-quiet-test",
      name: "Quiet Test",
      icon: "ti ti-bell",
      description: "Quiet time delivery fixture.",
      baseUrl: "http://notification-quiet-test:3000",
      routes: ["/notification-quiet-test"],
      notifications: {
        update: notification({
          recipient: "user",
          label: "Update",
          description: "A browser notification with an email fallback.",
          delivery: { recommended: ["browser", "email"] },
          data: z.object({}),
          render: () => ({ title: "Ready" }),
        }),
      },
    });
    const send = (key: string) =>
      notifications.send(app.notifications.update, { recipient: { userId }, data: {}, locale: "en", idempotencyKey: `${suffix}:${key}` });

    try {
      await browserNotifications.registerEndpoint({ userId, subscription, label: "Quiet device" });
      const paused = await userNotifications.quiet.update({
        userId,
        update: { doNotDisturbUntil: new Date(Date.now() + 60 * 60_000).toISOString() },
        fallbackTimeZone: "Europe/Berlin",
      });
      expect(paused.ok && paused.data.state).toMatchObject({ active: true, reason: "doNotDisturb" });
      expect(paused.ok && paused.data.quietHours).toEqual({ timeZone: "Europe/Berlin", periods: [] });

      const held = await send("paused");
      const [browser, email] = await deliveriesOf(held.id);
      expect(browser).toMatchObject({ channel: "browser", status: "pending" });
      expect(email).toMatchObject({ channel: "email", status: "deferred" });

      // A protocol-required browser delivery is not held back: it gets past quiet time to the endpoint check.
      await sql`
        INSERT INTO notifications.deliveries (event_id, channel, destination_key, destination_label, payload_encrypted, required, status, next_attempt_at)
        VALUES (${held.id}::uuid, 'browser', 'required-copy', 'Required', ${browser!.payload_encrypted}, true, 'pending', now())
      `;
      await browserNotifications.disableEndpoint({ userId, subscription });
      const [required] = (await deliveriesOf(held.id)).filter((delivery) => delivery.required);
      expect((await processNotificationDelivery(required!.id)).status).toBe("failed");
      expect((await deliveriesOf(held.id)).find((delivery) => delivery.required)?.error_code).toBe("endpoint_gone");

      // The recommended push is dropped before any attempt, and its email fallback ends with it.
      expect((await processNotificationDelivery(browser!.id)).status).toBe("suppressed");
      const afterHold = (await deliveriesOf(held.id)).filter((delivery) => !delivery.required);
      expect(afterHold).toEqual([
        expect.objectContaining({
          channel: "browser",
          status: "suppressed",
          error_code: "do_not_disturb",
          attempt_count: 0,
          payload_encrypted: null,
        }),
        expect.objectContaining({ channel: "email", status: "suppressed", error_code: "do_not_disturb", payload_encrypted: null }),
      ]);
      const history = await userNotifications.history.list({ userId, page: 1, perPage: 20, locale: "en" });
      expect(history.items.find((item) => item.id === browser!.id)).toMatchObject({
        status: "suppressed",
        errorCode: "do_not_disturb",
        errorMessage: "Held back because do not disturb was on.",
      });

      // Ending do not disturb replays nothing: recovery only picks up pending work.
      const resumed = await userNotifications.quiet.update({ userId, update: { doNotDisturbUntil: null } });
      expect(resumed.ok && resumed.data).toMatchObject({ doNotDisturbUntil: null, state: { active: false } });
      const recovered = await recoverNotificationDeliveries();
      expect(recovered).not.toContain(browser!.id);
      expect((await deliveriesOf(held.id)).every((delivery) => delivery.status !== "pending")).toBe(true);

      // Quiet hours hold back with their own code; a whole-day period in UTC covers now.
      await browserNotifications.registerEndpoint({ userId, subscription, label: "Quiet device" });
      await userNotifications.quiet.update({
        userId,
        update: { quietHours: { timeZone: "UTC", periods: [{ days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "00:00" }] } },
      });
      const quiet = await send("quiet-hours");
      const [quietBrowser] = await deliveriesOf(quiet.id);
      expect((await processNotificationDelivery(quietBrowser!.id)).status).toBe("suppressed");
      expect((await deliveriesOf(quiet.id))[0]).toMatchObject({ status: "suppressed", error_code: "quiet_hours" });

      // Without quiet time the delivery reaches the channel again; the disabled endpoint makes that visible offline.
      await userNotifications.quiet.update({ userId, update: { quietHours: { timeZone: "UTC", periods: [] } } });
      const later = await send("later");
      const [laterBrowser] = await deliveriesOf(later.id);
      await browserNotifications.disableEndpoint({ userId, subscription });
      expect((await processNotificationDelivery(laterBrowser!.id)).status).toBe("failed");
      expect((await deliveriesOf(later.id))[0]).toMatchObject({ status: "failed", error_code: "endpoint_gone" });
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      await sql`DELETE FROM notifications.definitions WHERE app_id = 'notification-quiet-test'`;
    }
  });
});
