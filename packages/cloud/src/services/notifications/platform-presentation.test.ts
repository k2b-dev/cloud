import { expect, test } from "bun:test";

test("send validates browser metadata before persistence and normalizes previews only for delivery", async () => {
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { z } from "zod";
    import { bindNotificationDefinitions, notification } from ${JSON.stringify(new URL("../../contracts/notification-types.ts", import.meta.url).pathname)};
    const eventId = "00000000-0000-4000-8000-000000000001";
    const delivered = [];
    const eventWrites = [];
    let sqlCalls = 0;
    const sql = async (parts, ...values) => {
      sqlCalls++;
      const query = parts.join("?");
      if (query.includes("INSERT INTO notifications.events")) { eventWrites.push({ query, values }); return [{ id: eventId }]; }
      if (query.includes("UPDATE notifications.events")) { eventWrites.push({ query, values }); return []; }
      if (query.includes("AS delivery_count")) return [{ delivery_count: 0, preparation_failure_count: 0 }];
      if (query.includes("FROM auth.users")) return [{ id: eventId, mail: "reader@example.org" }];
      if (query.includes("FROM notifications.preferences")) return [];
      if (query.includes("SELECT id, channel, required, status")) return [{ id: eventId, channel: "email", required: true, status: "delivered", error_code: null }];
      if (query.includes("INSERT INTO notifications.deliveries")) return [{ id: eventId }];
      if (query.includes("SELECT id FROM notifications.events") || query.includes("DELETE FROM notifications.deliveries")) return [];
      throw new Error("Unexpected SQL: " + query);
    };
    sql.begin = async callback => callback(sql);
    globalThis.notificationPresentationSql = sql;
    Bun.plugin({ name: "notification-presentation-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/]platform\\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.notificationPresentationSql;'), loader: "ts",
      }));
    }});
    mock.module(${JSON.stringify(new URL("./catalog.ts", import.meta.url).pathname)}, () => ({ ensureNotificationDefinition: async () => {} }));
    mock.module(${JSON.stringify(new URL("./dispatcher.ts", import.meta.url).pathname)}, () => ({ processNotificationDelivery: async () => ({ status: "delivered" }) }));
    mock.module(${JSON.stringify(new URL("./runtime.ts", import.meta.url).pathname)}, () => ({ enqueueNotificationDelivery: async () => {}, enqueueNotificationDeliveries: async () => {} }));
    mock.module(${JSON.stringify(new URL("../secrets.ts", import.meta.url).pathname)}, () => ({ encryptSecret: async () => "encrypted" }));
    mock.module(${JSON.stringify(new URL("./channels.ts", import.meta.url).pathname)}, () => ({
      getNotificationChannel: channel => ({
        resolveDestinations: async () => [{ key: "fixture", label: "Fixture", context: {} }],
        createPayload: ({ presentation }) => { delivered.push({ channel, presentation }); return {}; },
      }),
    }));
    const { sendTypedNotification } = await import(${JSON.stringify(new URL("./platform.ts", import.meta.url).pathname)});
    const send = (presentation, appId = "inventory", channel = "browser") => {
      const definition = bindNotificationDefinitions(appId, { stockLow: notification({
        recipient: "user", label: "Stock", description: "Stock", delivery: { required: [channel] },
        data: z.object({}), render: () => ({ title: " Ready ", ...presentation }),
      }) }).stockLow;
      return sendTypedNotification(definition, { recipient: { userId: eventId }, data: {}, idempotencyKey: "fixture" });
    };
    for (const group of [null, 1, "", " ", " group", "group ", "g".repeat(129), "group/one", "group\\n", "group@one"]) {
      const before = sqlCalls;
      await assert.rejects(send({ group }), /group/);
      assert.equal(sqlCalls, before);
    }
    for (const badge of [null, "2", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const before = sqlCalls;
      await assert.rejects(send({ badge }), /badge/);
      assert.equal(sqlCalls, before);
    }
    for (const appId of ["acme.chat", "my_app", "Inventory", "3d-viewer"]) {
      const before = sqlCalls;
      await assert.rejects(send({ group: "g" }, appId), /group.*app ID.*lowercase letter.*lowercase letters, digits, and hyphens/);
      assert.equal(sqlCalls, before);
      await send({}, appId);
      assert.deepEqual(delivered.at(-1), { channel: "browser", presentation: { title: "Ready" } });
    }
    for (const metadata of [
      {}, { group: "g", badge: 0 }, { group: "conversation:abc_1.2-3", badge: 2 },
      { group: "g".repeat(128), badge: Number.MAX_SAFE_INTEGER }, { badge: 1 },
    ]) {
      await send(metadata);
      assert.deepEqual(delivered.at(-1), { channel: "browser", presentation: { title: "Ready", ...metadata } });
    }
    for (const [preview, expected] of [
      ["  Hello\\n\\tworld\\u0000\\u0085!  ", "Hello world !"],
      ["x".repeat(200), "x".repeat(200)],
      ["x".repeat(201), "x".repeat(199) + "…"],
      ["x".repeat(198) + "😀", "x".repeat(198) + "😀"],
      ["x".repeat(192) + "👩🏽‍💻" + "end", "x".repeat(192) + "👩🏽‍💻…"],
      ["x".repeat(198) + "👩🏽‍💻" + "end", "x".repeat(198) + "…"],
      ["x".repeat(198) + "e\\u0301" + "end", "x".repeat(198) + "…"],
      ["x".repeat(197) + "e\\u0301" + "end", "x".repeat(197) + "e\\u0301…"],
      ["x".repeat(198) + "😀" + "end", "x".repeat(198) + "…"],
      ["x".repeat(197) + "😀" + "end", "x".repeat(197) + "😀…"],
      ["x".repeat(100_000), "x".repeat(199) + "…"],
      [" ".repeat(1_000) + "Unread suffix", undefined],
      [" ".repeat(998) + "👩🏽‍💻" + "suffix", undefined],
      [" ".repeat(994) + "👩🏽‍💻rest", undefined],
      [" ".repeat(997) + "🇩🇪rest", undefined],
      [" ".repeat(998) + "😀rest", "😀…"],
      ["", undefined], [" \\n\\t\\u0000\\u007f\\u0085 ", undefined],
    ]) {
      await send({ preview });
      assert.deepEqual(delivered.at(-1), { channel: "browser", presentation: { title: "Ready", ...(expected ? { preview: expected } : {}) } });
      if (expected) assert.ok(expected.length <= 200);
    }
    const presentation = { title: "Ready", body: "Details", group: "g", badge: 2, targetHref: "/app/inventory" };
    for (const channel of ["browser", "email", "sms"]) {
      await send({ ...presentation, preview: "Hello world !" }, "inventory", channel);
      assert.deepEqual(delivered.at(-1), {
        channel, presentation: { ...presentation, ...(channel === "browser" ? { preview: "Hello world !" } : {}) },
      });
      assert.equal("preview" in delivered.at(-1).presentation, channel === "browser");
    }
    for (const preview of [null, 1, {}]) {
      const before = sqlCalls;
      await assert.rejects(send({ preview }), /preview/);
      assert.equal(sqlCalls, before);
    }
    for (const { query, values } of eventWrites) {
      assert.equal(/group|badge|preview/.test(query), false);
      assert.equal(values.includes("conversation:abc_1.2-3"), false);
      assert.equal(values.includes("Hello world !"), false);
    }
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
