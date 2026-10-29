import { expect, test } from "bun:test";

test("excluded channels never resolve destinations or prepare payloads from older preferences or deployment fallbacks", async () => {
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { z } from "zod";
    import { bindNotificationDefinitions, notification } from ${JSON.stringify(new URL("../../contracts/notification-types.ts", import.meta.url).pathname)};
    const eventId = "00000000-0000-4000-8000-000000000001";
    let selected = ["email", "sms", "browser"];
    let customized = true;
    const resolved = [], prepared = [], persisted = [];
    const sql = async (parts, ...values) => {
      const query = parts.join("?");
      if (query.includes("FROM auth.users")) return [{ id: eventId, mail: "reader@example.test" }];
      if (query.includes("FROM notifications.preferences")) return customized ? [{ channels: selected }] : [];
      if (query.includes("INSERT INTO notifications.events")) return [{ id: eventId }];
      if (query.includes("AS delivery_count")) return [{ delivery_count: 0, preparation_failure_count: 0 }];
      if (query.includes("SELECT id FROM notifications.events") || query.includes("DELETE FROM notifications.deliveries") || query.includes("UPDATE notifications.events")) return [];
      if (query.includes("INSERT INTO notifications.deliveries")) { persisted.push(values[1]); return [{ id: eventId }]; }
      if (query.includes("SELECT id, channel, required, status")) return [];
      throw new Error("Unexpected SQL: " + query);
    };
    sql.begin = async callback => callback(sql);
    globalThis.notificationExcludedSql = sql;
    Bun.plugin({ name: "notification-excluded-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/]platform\\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.notificationExcludedSql;'), loader: "ts",
      }));
    }});
    mock.module(${JSON.stringify(new URL("./catalog.ts", import.meta.url).pathname)}, () => ({ ensureNotificationDefinition: async () => {} }));
    mock.module(${JSON.stringify(new URL("./dispatcher.ts", import.meta.url).pathname)}, () => ({ processNotificationDelivery: async () => { throw new Error("No required delivery"); } }));
    mock.module(${JSON.stringify(new URL("./runtime.ts", import.meta.url).pathname)}, () => ({ enqueueNotificationDelivery: async () => {}, enqueueNotificationDeliveries: async () => {} }));
    mock.module(${JSON.stringify(new URL("../secrets.ts", import.meta.url).pathname)}, () => ({ encryptSecret: async () => "encrypted" }));
    mock.module(${JSON.stringify(new URL("./channels.ts", import.meta.url).pathname)}, () => ({
      getNotificationChannel: channel => ({
        resolveDestinations: async () => { resolved.push(channel); return [{ key: "fixture", label: "Fixture", context: {} }]; },
        createPayload: () => { prepared.push(channel); return {}; },
      }),
    }));
    const { sendTypedNotification } = await import(${JSON.stringify(new URL("./platform.ts", import.meta.url).pathname)});
    const definition = bindNotificationDefinitions("inventory", { update: notification({
      recipient: "user", label: "Update", description: "Updates.", excludedReason: "Too frequent.",
      delivery: { recommended: ["browser"], excluded: ["email", "sms"] },
      data: z.object({}), render: () => ({ title: "Update" }),
      email: () => { throw new Error("Excluded email renderer must never run"); },
    }) }).update;
    const send = () => sendTypedNotification(definition, { recipient: { userId: eventId }, data: {}, idempotencyKey: "fixture" });
    await send();
    assert.deepEqual(resolved, ["browser"]);
    assert.deepEqual(prepared, ["browser"]);
    assert.deepEqual(persisted, ["browser"]);
    selected = ["email", "sms"];
    resolved.length = prepared.length = persisted.length = 0;
    await send();
    assert.deepEqual(resolved, []);
    assert.deepEqual(prepared, []);
    assert.deepEqual(persisted, ["none"]);
    customized = false;
    persisted.length = 0;
    await send();
    assert.deepEqual(resolved, ["browser"]);
    assert.deepEqual(prepared, ["browser"]);
    assert.deepEqual(persisted, ["browser"]);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
