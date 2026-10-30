import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { suiteFor, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppEvents } from "../../../core/src/migrate/core/app-events";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateEvents } from "../../../core/src/migrate/core/events";
import { migrate as migrateNotifications } from "../../../core/src/migrate/core/notifications";
import { compileCapabilities } from "../_internal/capabilities";
import { createAppEventRoutes } from "../api/app-events";
import { appAccess } from "../contracts/app-access";
import { APP_DETAILS_LIST_LIMIT, APP_SUBSCRIPTION_NEW_WINDOW_MS, AppDetailsSchema } from "../contracts/app-details";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import { sql } from "../runtime/clients";
import type { AuthContext, RequestAuthority } from "../server/middleware/auth";
import { createAppDetailsService } from "./app-details";
import { buildProjectedUser } from "./session/user";

const now = new Date("2026-10-27T12:00:00.000Z");
const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const authority = (admin = true): RequestAuthority => {
  const user = buildProjectedUser({ id: id(1000), provider: "local", profile: "user", effective_admin: admin });
  return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, credentialKind: "session", scopes: [] };
};
const app: AppRegistryEntry = {
  id: "demo",
  name: "Demo",
  description: "Demo app",
  icon: "box",
  appearance: { accent: "#123456" },
  presentation: { baseLocale: "en", translations: { de: { name: "Beispiel", description: "Beispiel-App" } } },
  access: appAccess.grants({ until: appAccess.signedIn() }),
  platformPermissions: ["mail:send"],
  baseUrl: "http://demo.test",
  routes: ["/demo"],
};
const capabilities: CapabilityRegistryEntry = {
  appId: app.id,
  appName: app.name,
  appDescription: app.description,
  appIcon: app.icon,
  endpoint: app.baseUrl,
  manifest: compileCapabilities("demo", {
    protocolVersion: 2,
    types: { item: { title: "Item", description: "Item" } },
    events: {
      changed: { version: 1, title: "Changed", description: "Item changed", subject: "item", schema: z.strictObject({ id: z.uuid() }) },
    },
  }).manifest,
  presentation: { baseLocale: "en", translations: { de: { events: { changed: { title: "Geändert", description: "Eintrag geändert" } } } } },
};
let online = true;
const details = createAppDetailsService({
  getApp: async (appId) => (online && appId === app.id ? app : null),
  capabilities: async () => (online ? [capabilities] : []),
});
const authenticate =
  (requestAuthority: RequestAuthority): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("actor", requestAuthority.actor);
    c.set("accessSubject", requestAuthority.accessSubject);
    c.set("credentialKind", requestAuthority.credentialKind);
    c.set("credentialScopes", requestAuthority.scopes);
    if (requestAuthority.credentialKind === "oauth") c.set("oauthScopes", requestAuthority.scopes);
    await next();
  };
const routes = (requestAuthority = authority()) => createAppEventRoutes(authenticate(requestAuthority), undefined, details);
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("app_details");
  await migrateAuth();
  await migrateEvents();
  await migrateAppEvents();
  await migrateNotifications();
}, 30_000);
afterAll(async () => {
  if (database) {
    await sql.close();
    await database.drop();
  }
});
afterEach(() => setSystemTime());

suiteFor("database")("app administration detail", () => {
  beforeEach(async () => {
    online = true;
    setSystemTime(now);
    await sql`TRUNCATE events.app_events, events.app_declarations, events.app_manifests,
      events.app_subscriptions, events.app_deliveries, notifications.definitions, auth.app_access_state CASCADE`.simple();
    await sql`
      INSERT INTO events.app_declarations(app_id, type, version, subject, place, automation, title, description, data_schema, schema_hash)
      VALUES ('demo', 'demo.changed', 1, 'item', NULL, true, 'Changed', 'Item changed', '{}', 'fixture')
    `;
    await sql`
      INSERT INTO events.app_subscriptions(id, app_id, event_type, version, state, first_seen_at)
      VALUES ('demo-hears', 'demo', 'demo.changed', 1, 'active', now())
    `;
    await sql`
      INSERT INTO notifications.definitions(id, app_id, kind, label, description, presentation, recipient_kind,
        required_channels, recommended_channels, excluded_channels, excluded_reason)
      VALUES ('demo.notice', 'demo', 'notice', 'Notice', 'Notice description',
        '{"baseLocale":"en","translations":{"de":{"label":"Nachricht","description":"Beschreibung","excludedReason":"Keine SMS für diese Meldung."}}}',
        'user', '{browser}', '{email}', '{sms}', 'No SMS for this notification.')
    `;
  });

  test("online detail shares localized declarations, notification policy and real inherited grant counts", async () => {
    const result = AppDetailsSchema.parse(await details("demo", { authority: authority(), locale: "de-CH" }));
    expect(result.app).toEqual({ id: "demo", name: "Beispiel", description: "Beispiel-App", icon: "box", accent: "#123456", online: true });
    expect(result.access).toEqual({ kind: "grants", roles: [], grantCount: 1, platformPermissions: ["mail:send"] });
    expect(result.sends).toEqual([
      {
        type: "demo.changed",
        version: 1,
        title: "Geändert",
        description: "Eintrag geändert",
        subject: "demo.item",
        place: null,
        automation: true,
        subscriberCount: 1,
      },
    ]);
    expect(result.hears[0]).toMatchObject({
      subscriptionId: "demo-hears",
      publisherAppId: "demo",
      title: "Geändert",
      isNew: true,
      counts: { pending: 0, retrying: 0, done: 0, failed: 0, cancelled: 0 },
    });
    expect(result.notifications).toEqual([
      {
        id: "demo.notice",
        kind: "notice",
        label: "Nachricht",
        description: "Beschreibung",
        recipientKind: "user",
        requiredChannels: ["browser"],
        recommendedChannels: ["email"],
        excludedChannels: ["sms"],
        excludedReason: "Keine SMS für diese Meldung.",
      },
    ]);
    expect(result.totals).toEqual({ sends: 1, hears: 1, notifications: 1 });
    expect((await routes().request("/apps/demo")).status).toBe(200);
  });

  test("offline apps retain persisted sends, hears and notifications; unknown app returns null and 404", async () => {
    online = false;
    const result = await details("demo", { authority: authority() });
    expect(result?.app).toEqual({ id: "demo", name: "demo", description: null, icon: null, accent: null, online: false });
    expect(result?.access.kind).toBeNull();
    expect(result?.sends[0]?.title).toBe("Changed");
    expect(result?.hears[0]?.title).toBe("Changed");
    expect(result?.notifications).toHaveLength(1);
    expect(await details("unknown", { authority: authority() })).toBeNull();
    expect((await routes().request("/apps/unknown")).status).toBe(404);
    await sql`INSERT INTO events.app_manifests(app_id, hash) VALUES ('known-empty', 'fixture')`;
    expect((await details("known-empty", { authority: authority() }))?.app.online).toBe(false);
  });

  test("fixed and legacy access come from the live registry; inactive notifications and cancelled subscribers do not count", async () => {
    for (const access of [appAccess.roles(["admin"]), appAccess.signedIn(), appAccess.noGuests(), undefined]) {
      const read = createAppDetailsService({ getApp: async () => ({ ...app, access }), capabilities: async () => [] });
      const result = await read("demo", { authority: authority() });
      expect(result?.access).toMatchObject({
        kind: access?.kind ?? "legacy",
        roles: access?.kind === "roles" ? ["admin"] : [],
        grantCount: null,
      });
    }
    await sql`UPDATE notifications.definitions SET active = false`;
    await sql`UPDATE events.app_subscriptions SET state = 'cancelled', reason = 'subscription_removed'`;
    const result = await details("demo", { authority: authority() });
    expect(result?.notifications).toEqual([]);
    expect(result?.totals.notifications).toBe(0);
    expect(result?.sends[0]?.subscriberCount).toBe(0);
    expect(result?.hears[0]).toMatchObject({ state: "cancelled", reason: "subscription_removed" });
  });

  test("retired event declarations disappear from sends and its total while offline active declarations remain", async () => {
    await sql`
      INSERT INTO events.app_declarations(app_id, type, version, subject, automation, title, description, data_schema, schema_hash)
      VALUES ('demo', 'demo.dropped', 1, 'item', true, 'Dropped', 'Dropped event', '{}', 'fixture')
    `;
    await sql`UPDATE events.app_declarations SET retired_at = now() WHERE type = 'demo.dropped'`;
    for (const available of [true, false]) {
      online = available;
      const result = await details("demo", { authority: authority() });
      expect(result?.sends.map((event) => event.type)).toEqual(["demo.changed"]);
      expect(result?.totals.sends).toBe(1);
    }
    await sql`UPDATE events.app_declarations SET retired_at = now()`;
    const result = await details("demo", { authority: authority() });
    expect(result?.sends).toEqual([]);
    expect(result?.totals.sends).toBe(0);
  });

  test("new subscriptions use the database clock, include the exact seven-day boundary and allow future timestamps", async () => {
    // PostgreSQL now() stays fixed throughout the transaction, including the exact boundary.
    await sql.begin(async (db) => {
      const [clock] = await db<{ now: Date }[]>`SELECT now() AS now`;
      const read = createAppDetailsService({ db, getApp: async () => app, capabilities: async () => [capabilities] });
      for (const skew of [-24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]) {
        setSystemTime(new Date(clock!.now.getTime() + skew));
        for (const [offset, expected] of [
          [-APP_SUBSCRIPTION_NEW_WINDOW_MS, true],
          [-APP_SUBSCRIPTION_NEW_WINDOW_MS - 1, false],
          [0, true],
          [1, true],
        ] as const) {
          await db`UPDATE events.app_subscriptions SET first_seen_at = now() + ${offset} * interval '1 millisecond'`;
          expect((await read("demo", { authority: authority() }))?.hears[0]?.isNew).toBe(expected);
        }
      }
    });
  });

  test("counts cover every delivery state; only the five most recent failures expose bounded errors and redelivery IDs", async () => {
    for (let number = 1; number <= 11; number++) {
      const state = number <= 7 ? "failed" : (["pending", "retrying", "done", "cancelled"] as const)[number - 8];
      await sql`
        INSERT INTO events.app_events(id, type, version, source, subject_key, envelope, state)
        VALUES (${id(number)}, 'demo.changed', 1, 'demo', 'item', '{}', 'accepted')
      `;
      await sql`
        INSERT INTO events.app_deliveries(id, event_id, subscription_id, subject_key, state, code, last_error, attempts, last_attempt_at)
        VALUES (${id(number + 100)}, ${id(number)}, 'demo-hears', 'item', ${state}, 'fixture_error', ${"x".repeat(1000)}, 8,
          ${new Date(now.getTime() - number * 1000)})
      `;
    }
    const result = AppDetailsSchema.parse(await details("demo", { authority: authority() }));
    expect(result.hears[0]?.counts).toEqual({ failed: 7, pending: 1, retrying: 1, done: 1, cancelled: 1 });
    expect(result.hears[0]?.failedDeliveries.map((failure) => failure.id)).toEqual([101, 102, 103, 104, 105].map(id));
    expect(result.hears[0]?.failedDeliveries[0]).toMatchObject({
      eventId: id(1),
      attempts: 8,
      code: "fixture_error",
      lastError: "x".repeat(1000),
    });
    await sql`UPDATE events.app_deliveries SET last_error = ${"🙂".repeat(1000)} WHERE id = ${id(101)}`;
    const response = await routes().request("/apps/demo");
    expect(response.status).toBe(200);
    const unicode = AppDetailsSchema.parse(await response.json());
    expect(Array.from(unicode.hears[0]?.failedDeliveries[0]?.lastError ?? "")).toHaveLength(1000);
  });

  test("all three lists are bounded and totals disclose omitted entries", async () => {
    await sql`
      INSERT INTO events.app_declarations(app_id, type, version, subject, automation, title, description, data_schema, schema_hash)
      SELECT 'demo', 'demo.event' || number, 1, 'item', true, 'Event', 'Description', '{}', 'fixture'
      FROM generate_series(1, ${APP_DETAILS_LIST_LIMIT}) number
    `;
    await sql`
      INSERT INTO events.app_subscriptions(id, app_id, event_type, version, state, reason, first_seen_at)
      SELECT 'subscription-' || number, 'demo', 'unknown.event' || number, 1, 'blocked', 'event_not_declared', ${now}
      FROM generate_series(1, ${APP_DETAILS_LIST_LIMIT}) number
    `;
    await sql`
      INSERT INTO notifications.definitions(id, app_id, kind, label, description, recipient_kind)
      SELECT 'demo.notice' || number, 'demo', 'notice' || number, 'Notice', 'Description', 'user'
      FROM generate_series(1, ${APP_DETAILS_LIST_LIMIT}) number
    `;
    const result = AppDetailsSchema.parse(await details("demo", { authority: authority() }));
    for (const key of ["sends", "hears", "notifications"] as const) {
      expect(result[key]).toHaveLength(APP_DETAILS_LIST_LIMIT);
      expect(result.totals[key]).toBe(APP_DETAILS_LIST_LIMIT + 1);
    }
    expect(result.hears.find((subscription) => subscription.eventType.startsWith("unknown."))).toMatchObject({
      publisherAppId: "unknown",
      title: null,
    });
  });

  test("non-admin and read-only OAuth authority are refused by service and HTTP", async () => {
    expect((await routes({ ...authority(), credentialKind: "oauth", scopes: ["admin"] }).request("/apps/demo")).status).toBe(200);
    for (const requestAuthority of [authority(false), { ...authority(), credentialKind: "oauth" as const, scopes: ["read"] }]) {
      await expect(details("demo", { authority: requestAuthority })).rejects.toMatchObject({ status: 403 });
      expect((await routes(requestAuthority).request("/apps/demo")).status).toBe(403);
    }
  });
});
