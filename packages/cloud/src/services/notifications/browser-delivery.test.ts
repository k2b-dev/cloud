import { expect, test } from "bun:test";

// Isolate provider/settings mocks so other notification suites keep real modules.
test("browser delivery carries localized previews, namespaces groups, and preserves title-only payloads", async () => {
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    const endpointId = "00000000-0000-4000-8000-000000000001";
    const eventId = "00000000-0000-4000-8000-000000000002";
    const subscription = {
      endpoint: "https://push.example.org/device", expirationTime: null,
      keys: { p256dh: "p".repeat(65), auth: "a".repeat(24) },
    };
    const sent = [];
    const prepared = [];
    const sql = async (parts) => {
      const query = parts.join("?");
      if (query.includes("SELECT id FROM notifications.endpoints")) return [{ id: endpointId }];
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.includes("SELECT id FROM notifications.events")) return [];
      if (query.includes("AS delivery_count")) return [{ delivery_count: 0, preparation_failure_count: 0 }];
      if (query.includes("FROM auth.users")) return [{ id: endpointId, mail: "reader@example.org" }];
      if (query.includes("FROM notifications.preferences")) return [];
      if (query.includes("SELECT id, endpoint_hash")) return [{ id: endpointId, endpoint_hash: "device", label: "Device", secret_encrypted: "subscription" }];
      if (query.includes("INSERT INTO notifications.events") || query.includes("INSERT INTO notifications.deliveries")) return [{ id: eventId }];
      if (query.includes("SELECT id, channel, required, status")) return [{ id: eventId, channel: "browser", required: true, status: "pending", error_code: null }];
      if (query.includes("UPDATE notifications.events") || query.includes("UPDATE notifications.deliveries") || query.includes("DELETE FROM notifications.deliveries")) return [];
      throw new Error("Unexpected SQL: " + query);
    };
    sql.begin = async callback => callback(sql);
    globalThis.notificationBrowserSql = sql;
    Bun.plugin({ name: "notification-browser-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/](?:browser|platform)\\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.notificationBrowserSql;'), loader: "ts",
      }));
    }});
    mock.module("web-push", () => ({ default: { setVapidDetails: () => {} } }));
    mock.module(${JSON.stringify(new URL("../settings/api.ts", import.meta.url).pathname)}, () => ({
      coreSettings: { get: async key => key === "app.url" ? "https://cloud.example.org" : "configured" },
    }));
    mock.module(${JSON.stringify(new URL("./web-push-transport.ts", import.meta.url).pathname)}, () => ({
      sendPinnedWebPush: async (subscription, payload, options) => { sent.push({ subscription, payload, options }); },
    }));
    mock.module(${JSON.stringify(new URL("./catalog.ts", import.meta.url).pathname)}, () => ({ ensureNotificationDefinition: async () => {} }));
    mock.module(${JSON.stringify(new URL("./dispatcher.ts", import.meta.url).pathname)}, () => ({ processNotificationDelivery: async () => ({ status: "pending" }) }));
    mock.module(${JSON.stringify(new URL("./runtime.ts", import.meta.url).pathname)}, () => ({ enqueueNotificationDelivery: async () => {}, enqueueNotificationDeliveries: async () => {} }));
    mock.module(${JSON.stringify(new URL("../secrets.ts", import.meta.url).pathname)}, () => ({
      decryptSecret: async () => subscription,
      encryptSecret: async payload => { prepared.push(payload); return "encrypted"; },
    }));
    await import(${JSON.stringify(new URL("./browser.ts", import.meta.url).pathname)});
    const { getNotificationChannel } = await import(${JSON.stringify(new URL("./channels.ts", import.meta.url).pathname)});
    const driver = getNotificationChannel("browser");
    const input = {
      presentation: { title: "Ready", body: "Sensitive body", targetHref: "/app/inventory" },
      destination: { key: "device", label: "Device", context: { endpointId, subscription } },
      event: { id: eventId, definitionId: "inventory.stockLow" },
    };
    const plain = driver.createPayload(input);
    assert.deepEqual(plain, { endpointId, subscription, eventId, title: "Ready", targetHref: "/app/inventory" });
    await driver.deliver(plain);
    assert.deepEqual(sent[0], {
      subscription,
      payload: JSON.stringify({ type: "cloud-notification", eventId, title: "Ready", targetHref: "/app/inventory" }),
      options: { TTL: 86400, urgency: "normal", topic: createHash("sha256").update(eventId).digest("base64url").slice(0, 32) },
    });
    for (const preview of ["Short preview", "p".repeat(200)]) {
      const payload = driver.createPayload({ ...input, presentation: { ...input.presentation, preview } });
      assert.deepEqual(payload, { ...plain, preview });
      await driver.deliver(payload);
      assert.equal(JSON.parse(sent.at(-1).payload).preview, preview);
      assert.equal("body" in payload, false);
      assert.equal("body" in JSON.parse(sent.at(-1).payload), false);
    }
    const groupedStart = sent.length;
    for (const [appId, id, badge] of [
      ["inventory", eventId, 3], ["inventory", crypto.randomUUID(), 0], ["other", crypto.randomUUID(), 2],
    ]) {
      const before = Date.now();
      const payload = driver.createPayload({
        ...input, event: { id, definitionId: appId + ".stockLow" },
        presentation: { ...input.presentation, group: "stock:one", badge },
      });
      assert.ok(Number.isSafeInteger(payload.createdAt));
      assert.ok(payload.createdAt >= before && payload.createdAt <= Date.now());
      assert.deepEqual(payload, { ...plain, eventId: id, group: appId + ":stock:one", badge, createdAt: payload.createdAt });
      await driver.deliver(payload);
      const last = sent.at(-1);
      assert.deepEqual(JSON.parse(last.payload), {
        type: "cloud-notification", eventId: id, title: "Ready", targetHref: "/app/inventory", group: appId + ":stock:one", badge, createdAt: payload.createdAt,
      });
      assert.equal(last.options.topic, createHash("sha256").update(id).digest("base64url").slice(0, 32));
    }
    assert.notEqual(sent[groupedStart].options.topic, sent[groupedStart + 1].options.topic);
    assert.notEqual(sent[groupedStart].options.topic, sent[groupedStart + 2].options.topic);
    const beforeGroup = Date.now();
    const maxGroup = driver.createPayload({ ...input, presentation: { title: "Ready", group: "g".repeat(128) } });
    assert.ok(Number.isSafeInteger(maxGroup.createdAt));
    assert.ok(maxGroup.createdAt >= beforeGroup && maxGroup.createdAt <= Date.now());
    assert.equal(maxGroup.group, "inventory:" + "g".repeat(128));
    await driver.deliver(maxGroup);
    const beforeBadge = Date.now();
    const badgeOnly = driver.createPayload({ ...input, presentation: { title: "Ready", badge: 0 } });
    assert.ok(Number.isSafeInteger(badgeOnly.createdAt));
    assert.ok(badgeOnly.createdAt >= beforeBadge && badgeOnly.createdAt <= Date.now());
    assert.equal(badgeOnly.badge, 0);
    assert.equal("group" in badgeOnly, false);
    await driver.deliver(badgeOnly);
    assert.equal(sent.at(-1).options.topic, sent[0].options.topic);
    assert.equal(JSON.parse(sent.at(-1).payload).createdAt, badgeOnly.createdAt);
    for (const metadata of [{ group: null }, { group: 1 }, { group: "bad group" }, { badge: "2" }, { badge: -1 }, { badge: 1.5 }, { badge: Number.MAX_SAFE_INTEGER + 1 }]) {
      await assert.rejects(driver.deliver({ ...plain, ...metadata }));
    }
    for (const preview of [null, 1, {}, "", "p".repeat(201)]) {
      await assert.rejects(driver.deliver({ ...plain, preview }));
    }
    for (const createdAt of [null, "1", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(driver.deliver({ ...plain, createdAt }));
    }
    assert.throws(() => driver.createPayload({
      ...input, event: { id: eventId, definitionId: "acme.chat.stockLow" },
      presentation: { title: "Ready", group: "stock:one" },
    }), /group/);
    const { z } = await import("zod");
    const { bindNotificationDefinitions, notification } = await import(${JSON.stringify(new URL("../../contracts/notification-types.ts", import.meta.url).pathname)});
    const { sendTypedNotification } = await import(${JSON.stringify(new URL("./platform.ts", import.meta.url).pathname)});
    const definition = bindNotificationDefinitions("inventory", { update: notification({
      recipient: "user", label: "Update", description: "Localized update", delivery: { required: ["browser"] },
      data: z.object({}), render: (_data, { locale }) => ({
        title: "Ready", body: "Sensitive body", preview: locale === "de" ? "  Neue Nachricht\\nlesen  " : "  Read new\\nmessage  ",
      }),
    }) }).update;
    for (const [locale, preview] of [["de", "Neue Nachricht lesen"], ["en", "Read new message"]]) {
      await sendTypedNotification(definition, { recipient: { userId: endpointId }, data: {}, locale, idempotencyKey: locale });
      assert.equal(prepared.at(-1).preview, preview);
      await driver.deliver(prepared.at(-1));
      assert.equal(JSON.parse(sent.at(-1).payload).preview, preview);
      assert.equal("body" in JSON.parse(sent.at(-1).payload), false);
    }
    const email = getNotificationChannel("email");
    const emailInput = { ...input, destination: { key: "email", label: "Email", context: { email: "reader@example.org" } } };
    assert.deepEqual(
      email.createPayload({ ...emailInput, presentation: { ...input.presentation, group: "stock:one", badge: 3, preview: "Browser only" } }),
      email.createPayload(emailInput),
    );
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
