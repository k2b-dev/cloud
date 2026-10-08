import { expect, test } from "bun:test";

test("dispatcher persists mail outcomes, preserves attempts while pending, and supports void drivers", async () => {
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    const id = "00000000-0000-4000-8000-000000000001";
    const mailId = "00000000-0000-4000-8000-000000000002";
    let status, attempts, result, failure, writes, mail, errorCode, errorMessage, nextAttempt, channel;
    const sql = async (parts, ...values) => {
      const query = parts.join("?");
      writes.push({ query, values });
      if (query.includes("RETURNING id, event_id")) {
        status = "sending"; attempts++;
        return [{ id, event_id: id, channel, payload_encrypted: "encrypted", required: true, attempt_count: attempts, outgoing_mail_id: mail }];
      }
      if (query.includes("attempt_count = attempt_count - 1")) { attempts--; assert.ok(query.includes("outgoing_mail_id")); }
      if (query.includes("SET outgoing_mail_id")) mail = values[0];
      if (query.includes("status = 'pending'")) {
        status = "pending";
        if (query.includes("attempt_count = attempt_count - 1")) {
          assert.ok(query.includes("error_code = NULL"));
          nextAttempt = values[0]; mail = values[1]; errorCode = null; errorMessage = values[2];
        } else { nextAttempt = values[0]; errorCode = values[1]; errorMessage = values[2]; }
      }
      if (query.includes("status = 'delivered'")) status = "delivered";
      if (query.includes("status = 'failed'")) { status = "failed"; errorCode = values[1]; errorMessage = values[2]; }
      return [];
    };
    globalThis.notificationDispatcherSql = sql;
    Bun.plugin({ name: "notification-dispatcher-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/]dispatcher\\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.notificationDispatcherSql;'), loader: "ts",
      }));
    }});
    mock.module(${JSON.stringify(new URL("../secrets.ts", import.meta.url).pathname)}, () => ({ decryptSecret: async () => ({ to: "reader@example.org" }) }));
    mock.module(${JSON.stringify(new URL("./channels.ts", import.meta.url).pathname)}, () => ({
      getNotificationChannel: () => ({ deliver: async (payload, context) => {
        assert.deepEqual(context, { deliveryId: id, ...(mail ? { outgoingMailId: mail } : {}) });
        if (failure) throw failure;
        return result;
      }}),
    }));
    const { processNotificationDelivery } = await import(${JSON.stringify(new URL("./dispatcher.ts", import.meta.url).pathname)});
    const reset = () => { status = "pending"; attempts = 0; result = undefined; failure = undefined; writes = []; mail = null; channel = "email"; errorCode = "smtp_failed"; };
    reset();
    result = { status: "pending", outgoingMailId: mailId, retryAfterMs: 2000, errorMessage: "451 Try again" };
    for (let i = 0; i < 7; i++) {
      assert.deepEqual(await processNotificationDelivery(id), { status: "pending", retryAfterMs: 2000 });
      assert.equal(status, "pending"); assert.equal(attempts, 0); assert.equal(mail, mailId);
      assert.equal(errorCode, null); assert.equal(errorMessage, "451 Try again"); assert.equal(nextAttempt, 2000);
    }
    result = { status: "delivered", outgoingMailId: mailId };
    assert.equal((await processNotificationDelivery(id)).status, "delivered");
    assert.equal(status, "delivered"); assert.equal(attempts, 1); assert.equal(mail, mailId);
    reset(); // Existing third-party/browser drivers return void.
    assert.equal((await processNotificationDelivery(id)).status, "delivered");
    for (const retryAfterMs of [undefined, 0, -1, Infinity, NaN, "2000"]) {
      reset(); result = { status: "pending", retryAfterMs, outgoingMailId: "invalid" };
      assert.equal((await processNotificationDelivery(id)).status, "delivered");
      assert.equal(attempts, 1); assert.equal(mail, null);
    }
    reset(); result = { status: "pending", retryAfterMs: 1, outgoingMailId: "invalid" };
    assert.deepEqual(await processNotificationDelivery(id), { status: "pending", retryAfterMs: 2000 });
    assert.equal(nextAttempt, 2000); assert.equal(attempts, 0); assert.equal(mail, null);
    reset(); result = { status: "pending", retryAfterMs: 1e10 };
    assert.deepEqual(await processNotificationDelivery(id), { status: "pending", retryAfterMs: 300000 });
    reset(); failure = Object.assign(new Error("550 Rejected"), { code: "smtp_failed", retryable: false, outgoingMailId: mailId });
    assert.equal((await processNotificationDelivery(id)).status, "failed");
    assert.equal(status, "failed"); assert.equal(attempts, 1); assert.equal(mail, mailId); assert.equal(errorCode, "smtp_failed");
    reset(); failure = Object.assign(new Error("Unavailable"), { code: "mail_unavailable", retryable: true });
    assert.deepEqual(await processNotificationDelivery(id), { status: "retry", retryAfterMs: 2000, error: "Unavailable" });
    assert.equal(status, "pending"); assert.equal(attempts, 1); assert.equal(errorCode, "mail_unavailable");
    reset(); channel = "browser"; failure = Object.assign(new Error("Try again"), { code: "provider_error", retryable: true });
    assert.deepEqual(await processNotificationDelivery(id), { status: "retry", retryAfterMs: 2000, error: "Try again" });
    assert.equal(status, "pending"); assert.equal(attempts, 1); assert.equal(errorCode, "provider_error");
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
