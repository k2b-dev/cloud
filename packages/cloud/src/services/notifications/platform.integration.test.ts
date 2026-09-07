import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { z } from "zod";
import { defineApp, notification } from "../..";
import { notifications } from ".";
import { registerNotificationDefinitions } from "./catalog";
import { registerNotificationChannel } from "./channels";
import { userNotifications } from "./user";

declare module "../../contracts/notification-types" {
  interface NotificationChannelRegistry {
    flaky: true;
    test: true;
  }
}

const canUseNotificationDatabase = async (): Promise<boolean> => {
  if (!process.env.APP_SECRET) return false;
  try {
    const rows = await sql<
      Array<{
        users: string | null;
        definitions: string | null;
        events: string | null;
        deliveries: string | null;
      }>
    >`
      SELECT
        to_regclass('auth.users')::text AS users,
        to_regclass('notifications.definitions')::text AS definitions,
        to_regclass('notifications.events')::text AS events,
        to_regclass('notifications.deliveries')::text AS deliveries
    `;
    return Boolean(rows[0]?.users && rows[0].definitions && rows[0].events && rows[0].deliveries);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseNotificationDatabase()) ? describe : describe.skip;

suite("typed notification delivery integration", () => {
  test("persists encrypted delivery state and deduplicates sends", async () => {
    const suffix = crypto.randomUUID();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (
        ${`notification-platform-${suffix}`}, 'local', 'user', 'Notification Platform Test',
        ${`notification-platform-${suffix}@example.test`}, 'Notification', 'Platform'
      )
      RETURNING id
    `;
    const userId = rows[0]!.id;
    const delivered: unknown[] = [];
    let flakyPreparation = true;
    const flakyEventIds: string[] = [];
    const unregister = registerNotificationChannel({
      id: "test",
      resolveDestinations: async () => [{ key: "test-destination", label: "Test device", context: { token: "endpoint-secret" } }],
      createPayload: ({ presentation, destination }) => ({ presentation, destination: destination.context }),
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });
    const unregisterFlaky = registerNotificationChannel({
      id: "flaky",
      resolveDestinations: async () => [{ key: "flaky-destination", label: "Flaky device", context: {} }],
      createPayload: ({ presentation, event }) => {
        flakyEventIds.push(event.id);
        if (flakyPreparation) throw new Error("Temporary preparation failure");
        return presentation;
      },
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });

    const app = defineApp({
      id: "notification-platform-test",
      name: "Notification Platform Test",
      icon: "ti ti-bell",
      description: "Notification platform integration fixture.",
      baseUrl: "http://notification-platform-test:3000",
      routes: ["/notification-platform-test"],
      notifications: {
        completed: notification({
          recipient: "user",
          label: "Completed",
          description: "A test operation completed.",
          delivery: { required: ["test"] },
          data: z.object({ resourceId: z.string() }),
          render: ({ resourceId }) => ({ title: "Completed", body: `Resource ${resourceId}`, targetHref: `/resources/${resourceId}` }),
        }),
        muted: notification({
          recipient: "user",
          label: "Muted",
          description: "A user-disabled test notification.",
          presentation: {
            baseLocale: "en",
            translations: { de: { label: "Stummgeschaltet", description: "Eine vom Benutzer deaktivierte Testbenachrichtigung." } },
          },
          delivery: { recommended: ["test"] },
          data: z.object({ resourceId: z.string() }),
          render: ({ resourceId }) => ({ title: "Muted", body: `Resource ${resourceId}` }),
        }),
        lazyEmail: notification({
          recipient: "user",
          label: "Lazy email",
          description: "Email rendering must not affect another selected channel.",
          delivery: { required: ["test"] },
          data: z.object({ resourceId: z.string() }),
          render: ({ resourceId }) => ({ title: "Lazy email", body: `Resource ${resourceId}` }),
          email: () => {
            throw new Error("Email renderer must stay lazy");
          },
        }),
        foreground: notification({
          recipient: "user",
          label: "Foreground",
          description: "Visible pages receive this without a Push endpoint.",
          delivery: { recommended: ["browser"] },
          data: z.object({ resourceId: z.string() }),
          render: ({ resourceId }) => ({ title: "Foreground ready", targetHref: `/resources/${resourceId}` }),
        }),
        brokenEmail: notification({
          recipient: "user",
          label: "Broken email",
          description: "Selected email preparation failures remain observable.",
          delivery: { required: ["email"] },
          data: z.object({}),
          render: () => ({ title: "Broken email" }),
          email: () => {
            throw new Error("Broken email template");
          },
        }),
        retriablePreparation: notification({
          recipient: "user",
          label: "Retriable preparation",
          description: "Stable events can recover from temporary preparation failures.",
          delivery: { required: ["flaky"] },
          data: z.object({}),
          render: () => ({ title: "Retriable preparation" }),
        }),
      },
    });
    let legacyMessageId: string | null = null;

    try {
      const idempotencyKey = `completion:${suffix}`;
      const first = await notifications.send(app.notifications.completed, {
        recipient: { userId },
        data: { resourceId: "resource-1" },
        idempotencyKey,
      });
      const duplicate = await notifications.send(app.notifications.completed, {
        recipient: { userId },
        data: { resourceId: "resource-1" },
        idempotencyKey,
      });

      expect(first.status).toBe("delivered");
      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(delivered).toHaveLength(1);

      const deliveryRows = await sql<{ payload_encrypted: string | null; status: string; attempt_count: number }[]>`
        SELECT payload_encrypted, status, attempt_count
        FROM notifications.deliveries
        WHERE event_id = ${first.id}::uuid
      `;
      expect(deliveryRows).toHaveLength(1);
      expect(deliveryRows[0]?.status).toBe("delivered");
      expect(deliveryRows[0]?.attempt_count).toBe(1);
      expect(deliveryRows[0]?.payload_encrypted).toBeNull();

      const lazyEmail = await notifications.send(app.notifications.lazyEmail, {
        recipient: { userId },
        data: { resourceId: "resource-3" },
        idempotencyKey: `lazy-email:${suffix}`,
      });
      expect(lazyEmail.status).toBe("delivered");

      const liveAbort = new AbortController();
      const cursor = (await notifications.live.latestCursor(userId)) ?? notifications.live.emptyCursor();
      const liveIterator = notifications.live.events({ userId, after: cursor, signal: liveAbort.signal })[Symbol.asyncIterator]();
      const nextLive = liveIterator.next();
      const foreground = await notifications.send(app.notifications.foreground, {
        recipient: { userId },
        data: { resourceId: "resource-live" },
        idempotencyKey: `foreground:${suffix}`,
      });
      const live = await Promise.race([
        nextLive,
        Bun.sleep(2_000).then(() => {
          throw new Error("Timed out waiting for foreground notification");
        }),
      ]);
      liveAbort.abort();
      expect(foreground.status).toBe("suppressed");
      expect(live.value?.data).toEqual({
        type: "cloud-notification",
        eventId: foreground.id,
        title: "Foreground ready",
        targetHref: "/resources/resource-live",
      });

      const brokenEmail = await notifications.send(app.notifications.brokenEmail, {
        recipient: { userId },
        data: {},
        idempotencyKey: `broken-email:${suffix}`,
      });
      expect(brokenEmail).toEqual(
        expect.objectContaining({
          status: "error",
          deliveries: [expect.objectContaining({ channel: "email", status: "failed", errorCode: "preparation_failed" })],
        }),
      );
      const [brokenPayload] = await sql<{ payload_encrypted: string | null }[]>`
        SELECT payload_encrypted FROM notifications.deliveries WHERE event_id = ${brokenEmail.id}::uuid
      `;
      expect(brokenPayload?.payload_encrypted).toBeNull();

      const preparationKey = `retriable-preparation:${suffix}`;
      const failedPreparation = await notifications.send(app.notifications.retriablePreparation, {
        recipient: { userId },
        data: {},
        idempotencyKey: preparationKey,
      });
      expect(failedPreparation.status).toBe("error");
      flakyPreparation = false;
      const recoveredPreparation = await notifications.send(app.notifications.retriablePreparation, {
        recipient: { userId },
        data: {},
        idempotencyKey: preparationKey,
      });
      expect(recoveredPreparation).toEqual(expect.objectContaining({ id: failedPreparation.id, created: false, status: "delivered" }));
      expect(flakyEventIds).toEqual([failedPreparation.id, failedPreparation.id]);

      await registerNotificationDefinitions(app.meta.id, app.notifications);
      await sql`
        INSERT INTO notifications.preferences (user_id, definition_id, channels)
        VALUES (${userId}::uuid, ${app.notifications.muted.id}, '{}'::text[])
      `;
      const muted = await notifications.send(app.notifications.muted, {
        recipient: { userId },
        data: { resourceId: "resource-2" },
        idempotencyKey: `muted:${suffix}`,
      });
      expect(muted.status).toBe("suppressed");
      expect(muted.deliveries).toEqual([expect.objectContaining({ channel: "none", status: "suppressed", errorCode: "disabled_by_user" })]);

      const preferences = await userNotifications.preferences.list(userId, "de-CH");
      expect(preferences.availableChannels).toContain("test");
      expect(preferences.definitions.find((definition) => definition.id === app.notifications.muted.id)).toEqual(
        expect.objectContaining({
          label: "Stummgeschaltet",
          description: "Eine vom Benutzer deaktivierte Testbenachrichtigung.",
          customized: true,
          selectedChannels: [],
          effectiveChannels: [],
        }),
      );

      const history = await userNotifications.history.list({ userId, page: 1, perPage: 20, locale: "de-CH" });
      const disabled = history.items.find((item) => item.eventId === muted.id);
      expect(disabled).toEqual(
        expect.objectContaining({
          channel: "none",
          label: "Stummgeschaltet",
          status: "suppressed",
          errorCode: "disabled_by_user",
          errorMessage: "Delivery is disabled in your notification preferences.",
        }),
      );
      expect(disabled && "body" in disabled).toBe(false);

      const reset = await userNotifications.preferences.reset({ userId, definitionId: app.notifications.muted.id, locale: "de-CH" });
      expect(reset).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({ label: "Stummgeschaltet", customized: false, selectedChannels: ["test"] }),
        }),
      );

      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      try {
        console.warn = (...args: unknown[]) => warnings.push(args);
        const legacy = await notifications.send({
          type: "email",
          recipient: "legacy-notification@example.test",
          subject: "Legacy notification",
          content: "Compatibility test",
          autoSend: false,
        });
        legacyMessageId = legacy.id;
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings).toContainEqual([
        "[notifications]",
        "Deprecated notification send API used",
        expect.objectContaining({ api: "notifications.send", deprecated: true }),
      ]);
    } finally {
      unregister();
      unregisterFlaky();
      if (legacyMessageId) await sql`DELETE FROM notifications.messages WHERE id = ${legacyMessageId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      await sql`DELETE FROM notifications.definitions WHERE app_id = 'notification-platform-test'`;
    }
  });
});
