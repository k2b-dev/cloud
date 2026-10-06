import { beforeAll, expect, test } from "bun:test";
import { registerNotificationDefinitions } from "@k2b/cloud/services/notifications/catalog";
import * as settings from "@k2b/cloud/services/settings";
import { sql } from "bun";
import { databaseSuite } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { app } from "./config";
import { createCoreNotificationSender } from "./notifications";

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

suite("Core notice for a newly paired phone", () => {
  beforeAll(async () => {
    await registerNotificationDefinitions(app.meta.id, app.notifications);
  });

  test("names the phone, its platform and the pairing time in the reader's language and links to the App page", async () => {
    const notice = app.notifications.appDevicePaired;
    const data = { name: "Ada's iPhone", platform: "ios" as const, pairedAt: "2026-10-06T12:03:00.000Z" };
    // Read, never change, the shared installation settings: other suites rely on them in parallel.
    const timeZone = (await settings.get<string>("app.timezone")).trim() || "UTC";
    const configured = (await settings.get<string>("app.url")).trim();
    const base = configured ? (/^https?:\/\//.test(configured) ? configured : `https://${configured}`).replace(/\/+$/, "") : "";

    const en = await notice.render(data, { locale: "en" });
    expect(en).toMatchObject({ title: "New phone paired", targetHref: "/me/app" });
    expect(en.body).toContain("“Ada's iPhone” (iOS)");
    expect(en.body).toContain(`(${timeZone})`);
    expect(en.body).toContain("under App in your profile menu");

    const email = await notice.email!(data, { locale: "en" });
    expect(email.subject).toBe("New phone paired");
    expect(email.content).toContain(`${base}/me/app`);
    expect(email.rawHtml).toBeUndefined();

    const de = await notice.email!({ ...data, platform: "android" }, { locale: "de" });
    expect(de.subject).toBe("Neues Telefon gekoppelt");
    expect(de.content).toContain("„Ada's iPhone“ (Android)");
    expect(de.content).toMatch(/ wurde am \d{1,2}\. Okt\. 2026, \d{2}:\d{2} \(/);
    expect(de.content).toContain(`(${timeZone})`);
  });

  test("is sent once per phone, in the locale of the pairing", async () => {
    const definition = app.notifications.appDevicePaired;
    const suffix = crypto.randomUUID();
    // No email address and no browser endpoint: the event is recorded without reaching a provider.
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, given_name, sn)
      VALUES (${`phone-notice-${suffix}`}, 'local', 'user', 'Phone Notice', 'Phone', 'Notice')
      RETURNING id
    `;
    const userId = user!.id;
    const sender = createCoreNotificationSender(app.notifications);
    const deviceId = crypto.randomUUID();
    const notice = { deviceId, userId, name: "Android", platform: "android" as const, pairedAt: new Date().toISOString(), locale: "de" };
    try {
      await sender.sendAppDevicePaired(notice);
      await sender.sendAppDevicePaired(notice);
      const events = await sql<{ title: string; target_href: string | null; idempotency_key: string }[]>`
        SELECT title, target_href, idempotency_key FROM notifications.events
        WHERE definition_id = ${definition.id} AND recipient_user_id = ${userId}::uuid
      `;
      expect(events).toEqual([
        { title: "Neues Telefon gekoppelt", target_href: "/me/app", idempotency_key: `pwa-device-paired:${deviceId}` },
      ]);
      const deliveries = await sql<{ channel: string; error_code: string | null }[]>`
        SELECT d.channel, d.error_code FROM notifications.deliveries d
        JOIN notifications.events e ON e.id = d.event_id
        WHERE e.definition_id = ${definition.id} AND e.recipient_user_id = ${userId}::uuid
        ORDER BY d.route_priority
      `;
      expect(deliveries).toEqual([
        { channel: "email", error_code: "no_endpoint" },
        { channel: "browser", error_code: "no_endpoint" },
      ]);
    } finally {
      await sql`DELETE FROM notifications.events WHERE recipient_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
