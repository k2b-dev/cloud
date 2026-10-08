import { expect, test } from "bun:test";

// Isolate provider/settings mocks so other notification suites keep real modules.
test("browser delivery namespaces groups and collapses push topics without changing ungrouped payloads", async () => {
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
    const sql = async (parts) => {
      const query = parts.join("?");
      if (query.includes("SELECT id FROM notifications.endpoints")) return [{ id: endpointId }];
      if (query.includes("pg_advisory_xact_lock")) return [];
      throw new Error("Unexpected SQL: " + query);
    };
    sql.begin = async callback => callback(sql);
    globalThis.notificationBrowserSql = sql;
    Bun.plugin({ name: "notification-browser-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/]browser\\.ts$/ }, async ({ path }) => ({
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
    for (const [appId, id, badge] of [
      ["inventory", eventId, 3], ["inventory", crypto.randomUUID(), 0], ["other", crypto.randomUUID(), 2],
    ]) {
      const payload = driver.createPayload({
        ...input, event: { id, definitionId: appId + ".stockLow" },
        presentation: { ...input.presentation, group: "stock:one", badge },
      });
      assert.deepEqual(payload, { ...plain, eventId: id, group: appId + ":stock:one", badge });
      await driver.deliver(payload);
      const last = sent.at(-1);
      assert.deepEqual(JSON.parse(last.payload), {
        type: "cloud-notification", eventId: id, title: "Ready", targetHref: "/app/inventory", group: appId + ":stock:one", badge,
      });
      assert.equal(last.options.topic, createHash("sha256").update(appId + ":stock:one").digest("base64url").slice(0, 32));
    }
    assert.equal(sent[1].options.topic, sent[2].options.topic);
    assert.notEqual(sent[1].options.topic, sent[3].options.topic);
    const maxGroup = driver.createPayload({ ...input, presentation: { title: "Ready", group: "g".repeat(128) } });
    assert.equal(maxGroup.group, "inventory:" + "g".repeat(128));
    await driver.deliver(maxGroup);
    const badgeOnly = driver.createPayload({ ...input, presentation: { title: "Ready", badge: 0 } });
    assert.equal(badgeOnly.badge, 0);
    assert.equal("group" in badgeOnly, false);
    await driver.deliver(badgeOnly);
    assert.equal(sent.at(-1).options.topic, sent[0].options.topic);
    for (const metadata of [{ group: null }, { group: 1 }, { group: "bad group" }, { badge: "2" }, { badge: -1 }, { badge: 1.5 }, { badge: Number.MAX_SAFE_INTEGER + 1 }]) {
      await assert.rejects(driver.deliver({ ...plain, ...metadata }));
    }
    const email = getNotificationChannel("email");
    const emailInput = { ...input, destination: { key: "email", label: "Email", context: { email: "reader@example.org" } } };
    assert.deepEqual(
      email.createPayload({ ...emailInput, presentation: { ...input.presentation, group: "stock:one", badge: 3 } }),
      email.createPayload(emailInput),
    );
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
