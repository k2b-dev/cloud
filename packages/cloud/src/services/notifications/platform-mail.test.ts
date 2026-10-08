import { expect, test } from "bun:test";

test("typed summaries queue accepted email but preserve errors for required channel retries", async () => {
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    import { z } from "zod";
    import { bindNotificationDefinitions, notification } from ${JSON.stringify(new URL("../../contracts/notification-types.ts", import.meta.url).pathname)};
    let status = "pending", channel = "email", errorCode = null;
    const eventId = "00000000-0000-4000-8000-000000000001";
    const sql = async (parts) => {
      const query = parts.join("?");
      if (query.includes("INSERT INTO notifications.events")) return [];
      if (query.includes("SELECT id FROM notifications.events")) return [{ id: eventId }];
      if (query.includes("AS delivery_count")) return [{ delivery_count: 1, preparation_failure_count: 0 }];
      if (query.includes("SELECT id, channel, required, status")) return [{ id: eventId, channel, required: true, status, error_code: errorCode }];
      throw new Error("Unexpected SQL: " + query);
    };
    sql.begin = async callback => callback(sql);
    globalThis.notificationPlatformSql = sql;
    Bun.plugin({ name: "notification-platform-mail-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/]platform\\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.notificationPlatformSql;'), loader: "ts",
      }));
    }});
    mock.module(${JSON.stringify(new URL("./catalog.ts", import.meta.url).pathname)}, () => ({ ensureNotificationDefinition: async () => {} }));
    mock.module(${JSON.stringify(new URL("./dispatcher.ts", import.meta.url).pathname)}, () => ({ processNotificationDelivery: async () => { throw new Error("An existing event must not be dispatched again"); } }));
    mock.module(${JSON.stringify(new URL("./runtime.ts", import.meta.url).pathname)}, () => ({ enqueueNotificationDelivery: async () => {}, enqueueNotificationDeliveries: async () => {} }));
    const { sendTypedNotification } = await import(${JSON.stringify(new URL("./platform.ts", import.meta.url).pathname)});
    const definition = bindNotificationDefinitions("core", { emailTest: notification({
      recipient: "email", label: "Test", description: "Test", delivery: { required: ["email"] },
      data: z.object({}), render: () => ({ title: "Test" }),
    }) }).emailTest;
    for (const state of [
      { status: "pending", channel: "email", errorCode: null, summary: "queued" },
      { status: "sending", channel: "email", errorCode: null, summary: "queued" },
      { status: "failed", channel: "email", errorCode: "smtp_failed", summary: "error" },
      { status: "failed", channel: "email", errorCode: null, summary: "error" },
      { status: "suppressed", channel: "email", errorCode: null, summary: "error" },
      { status: "delivered", channel: "email", errorCode: null, summary: "delivered" },
      { status: "pending", channel: "email", errorCode: "mail_unavailable", summary: "error" },
      { status: "pending", channel: "browser", errorCode: "provider_error", summary: "error" },
      { status: "sending", channel: "browser", errorCode: "provider_error", summary: "error" },
    ]) {
      ({ status, channel, errorCode } = state);
      const result = await sendTypedNotification(definition, { recipient: { email: "reader@example.org" }, data: {}, idempotencyKey: "fixture" });
      assert.equal(result.created, false);
      assert.equal(result.status, state.summary);
      assert.equal(result.deliveries[0].errorCode, errorCode);
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
