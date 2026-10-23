import { afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { registerNotificationDefinitions } from "@k2b/cloud/services/notifications/catalog";
import * as settings from "@k2b/cloud/services/settings";
import { sql } from "bun";
import { databaseSuite, testFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { userNotifications } from "@k2b/cloud/services/notifications/user";
import { notifyPendingOAuthNewAccess } from "./api/identity-oauth-device-approval";
import { app } from "./config";
import { createCoreNotificationSender, type OAuthNewAccessNotice } from "./notifications";

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
    let base = !configured || /^https?:\/\//.test(configured) ? configured : `https://${configured}`;
    while (base.endsWith("/")) base = base.slice(0, -1);

    const en = await notice.render(data, { locale: "en" });
    expect(en).toMatchObject({ title: "New device paired", targetHref: "/me/app" });
    expect(en.body).toContain("“Ada's iPhone” (iOS)");
    expect(en.body).toContain(`(${timeZone})`);
    expect(en.body).toContain("under App in your profile menu");

    const email = await notice.email!(data, { locale: "en" });
    expect(email.subject).toBe("New device paired");
    expect(email.content).toContain(`${base}/me/app`);
    expect(email.rawHtml).toBeUndefined();

    const de = await notice.email!({ ...data, platform: "android" }, { locale: "de" });
    expect(de.subject).toBe("Neues Gerät gekoppelt");
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
        { title: "Neues Gerät gekoppelt", target_href: "/me/app", idempotency_key: `pwa-device-paired:${deviceId}` },
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

  test("fails while no delivery could be prepared, so that maintenance tries the phone again", async () => {
    const definition = app.notifications.appDevicePaired;
    const suffix = crypto.randomUUID();
    // An email address but no browser endpoint: only the email delivery could have gone out.
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, given_name, sn, mail)
      VALUES (${`phone-notice-${suffix}`}, 'local', 'user', 'Phone Notice', 'Phone', 'Notice', ${`phone-notice-${suffix}@example.test`})
      RETURNING id
    `;
    const userId = user!.id;
    const sender = createCoreNotificationSender({
      ...app.notifications,
      appDevicePaired: {
        ...definition,
        email: async () => {
          throw new Error("Settings unavailable");
        },
      },
    });
    const notice = {
      deviceId: crypto.randomUUID(),
      userId,
      name: "Android",
      platform: "android" as const,
      pairedAt: new Date().toISOString(),
      locale: "en",
    };
    try {
      await expect(sender.sendAppDevicePaired(notice)).rejects.toThrow("could not be prepared");
      const deliveries = await sql<{ channel: string; status: string; error_code: string | null }[]>`
        SELECT d.channel, d.status, d.error_code FROM notifications.deliveries d
        JOIN notifications.events e ON e.id = d.event_id
        WHERE e.definition_id = ${definition.id} AND e.recipient_user_id = ${userId}::uuid
        ORDER BY d.route_priority
      `;
      expect(deliveries).toEqual([
        { channel: "email", status: "failed", error_code: "preparation_failed" },
        { channel: "browser", status: "suppressed", error_code: "no_endpoint" },
      ]);
    } finally {
      await sql`DELETE FROM notifications.events WHERE recipient_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});

suite("Core new-browser sign-in notification handoff", () => {
  const now = new Date("2026-10-16T07:14:00.000Z");
  beforeAll(async () => {
    await registerNotificationDefinitions(app.meta.id, app.notifications);
  });
  afterEach(() => setSystemTime());

  testFor("database", "nats")("default delivery, idempotency per first-seen period, and an explicitly disabled preference", async () => {
    setSystemTime(now);
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, mail)
      VALUES (${`browser-notice-${suffix}`}, 'local', 'user', ${`browser-notice-${suffix}@example.test`}) RETURNING id`;
    const userId = user!.id;
    const browserId = crypto.randomUUID();
    const notice = {
      browserId,
      userId,
      firstName: "Jana",
      browser: "chrome" as const,
      os: "macos" as const,
      country: "AT",
      city: "Wien",
      signedInAt: now.toISOString(),
      method: "password" as const,
      device: null,
      locale: "de",
    };
    const sender = createCoreNotificationSender(app.notifications);
    try {
      const first = await sender.sendNewBrowserSignIn(notice);
      expect(first).toMatchObject({ status: "queued" });
      await sender.sendNewBrowserSignIn(notice);
      const events =
        await sql`SELECT title, target_href, idempotency_key FROM notifications.events WHERE definition_id = 'core.newBrowserSignIn' AND recipient_user_id = ${userId}::uuid`;
      expect(events).toEqual([
        {
          title: "Neue Anmeldung aus einem neuen Browser",
          target_href: "/me/security",
          idempotency_key: `new-browser-sign-in:${browserId}:${now.toISOString()}`,
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/Wien|Österreich/);
      expect(
        await sql`SELECT d.id FROM notifications.deliveries d JOIN notifications.events e ON e.id = d.event_id WHERE e.recipient_user_id = ${userId}::uuid AND d.channel = 'email' AND d.status = 'pending'`,
      ).toHaveLength(1);
      expect((await userNotifications.preferences.set({ userId, definitionId: "core.newBrowserSignIn", channels: [] })).ok).toBe(true);
      // A later first-seen period has a new key even though it reuses the browser row id.
      const disabled = await sender.sendNewBrowserSignIn({ ...notice, signedInAt: "2027-01-17T07:14:00.000Z" });
      expect(disabled).toMatchObject({ status: "suppressed", deliveries: [{ errorCode: "disabled_by_user" }] });
      expect(
        await sql`SELECT id FROM notifications.events WHERE definition_id = 'core.newBrowserSignIn' AND recipient_user_id = ${userId}::uuid`,
      ).toHaveLength(2);
    } finally {
      await sql`DELETE FROM notifications.events WHERE recipient_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a preparation failure throws so maintenance can retry the same event", async () => {
    setSystemTime(now);
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, mail)
      VALUES (${`browser-failure-${suffix}`}, 'local', 'user', ${`browser-failure-${suffix}@example.test`}) RETURNING id`;
    const userId = user!.id;
    const sender = createCoreNotificationSender({
      ...app.notifications,
      newBrowserSignIn: {
        ...app.notifications.newBrowserSignIn,
        email: async () => {
          throw new Error("Settings unavailable");
        },
      },
    });
    try {
      await expect(
        sender.sendNewBrowserSignIn({
          browserId: crypto.randomUUID(),
          userId,
          firstName: null,
          browser: "other",
          os: "other",
          country: null,
          city: null,
          signedInAt: now.toISOString(),
          method: "password",
          device: null,
          locale: "en",
        }),
      ).rejects.toThrow("could not be prepared");
    } finally {
      await sql`DELETE FROM notifications.events WHERE recipient_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});

suite("Core new-access notification delivery", () => {
  beforeAll(async () => {
    await registerNotificationDefinitions(app.meta.id, app.notifications);
  });

  test("records one configured-locale event per family", async () => {
    const userId = crypto.randomUUID(),
      familyId = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES (${userId}::uuid,${userId},'local','user')`;
    const sender = createCoreNotificationSender(app.notifications);
    const notice = { familyId, userId, kind: "command_line" as const, clientName: "Cloud CLI", createdAt: "2026-10-06T12:03:00.000Z" };
    try {
      await sender.sendOAuthNewAccess(notice);
      await sender.sendOAuthNewAccess(notice);
      const expected = await app.notifications.oauthNewAccess.render(notice, { locale: await settings.get<string>("app.locale") });
      const events = await sql`SELECT idempotency_key,target_href,title FROM notifications.events
        WHERE definition_id=${app.notifications.oauthNewAccess.id} AND recipient_user_id=${userId}::uuid`;
      expect(events).toEqual([{ idempotency_key: `oauth-new-access:${familyId}`, target_href: "/me/security", title: expected.title }]);
    } finally {
      await sql`DELETE FROM notifications.events WHERE recipient_user_id=${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("a failed preparation leaves the family pending and maintenance sends it on the next run", async () => {
    const userId = crypto.randomUUID(),
      familyId = crypto.randomUUID(),
      clientId = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,mail) VALUES (${userId}::uuid,${userId},'local','user',${`${userId}@example.test`})`;
    await sql`INSERT INTO oauth.clients(name,client_id,redirect_uris,scopes,audiences) VALUES ('New access test',${clientId},'{}',ARRAY['openid','offline_access'],ARRAY['cloud'])`;
    await sql`INSERT INTO oauth.refresh_token_families(id,client_id,user_id,auth_epoch,scopes,audiences,status,expires_at)
      VALUES (${familyId}::uuid,${clientId},${userId}::uuid,0,ARRAY['openid','offline_access'],ARRAY['cloud'],'active',now()+interval '1 hour')`;
    const sender = createCoreNotificationSender({
      ...app.notifications,
      oauthNewAccess: {
        ...app.notifications.oauthNewAccess,
        email: async () => {
          throw new Error("Settings unavailable");
        },
      },
    });
    const data = { familyId, userId, kind: "app" as const, clientName: "New access test", createdAt: "2026-10-06T12:03:00.000Z" };
    try {
      await expect(sender.sendOAuthNewAccess(data)).rejects.toThrow("could not be prepared");
      const failing = async (notice: OAuthNewAccessNotice) => {
        if (notice.familyId !== familyId) throw new Error("Not this test's family");
        await sender.sendOAuthNewAccess(notice);
      };
      await notifyPendingOAuthNewAccess(failing);
      const [pending] = await sql`SELECT notified_at FROM oauth.refresh_token_families WHERE id=${familyId}::uuid`;
      expect(pending.notified_at).toBeNull();
      // With no destination configured, preparation completes without reaching an outgoing provider.
      await sql`UPDATE auth.users SET mail=NULL WHERE id=${userId}::uuid`;
      const retry = createCoreNotificationSender(app.notifications);
      await notifyPendingOAuthNewAccess(async (notice) => {
        if (notice.familyId !== familyId) throw new Error("Not this test's family");
        await retry.sendOAuthNewAccess(notice);
      });
      const [sent] = await sql`SELECT notified_at FROM oauth.refresh_token_families WHERE id=${familyId}::uuid`;
      expect(sent.notified_at).toBeInstanceOf(Date);
      const events =
        await sql`SELECT id FROM notifications.events WHERE recipient_user_id=${userId}::uuid AND definition_id=${app.notifications.oauthNewAccess.id}`;
      expect(events).toHaveLength(1);
    } finally {
      await sql`DELETE FROM notifications.events WHERE recipient_user_id=${userId}::uuid`;
      await sql`DELETE FROM oauth.clients WHERE client_id=${clientId}`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
});
