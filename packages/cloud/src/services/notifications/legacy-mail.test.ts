import { expect, test } from "bun:test";

test("legacy sends use stable message keys, leave accepted mail pending, and create fresh explicit resends", async () => {
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    const id = "00000000-0000-4000-8000-000000000001";
    let mailStatus, row, calls;
    const reset = () => { calls = []; row = { id, type: "email", recipient: "reader@example.org", subject: "Legacy", content: "<p>Hello</p>", sent_at: null, error: null, created_at: new Date(), sent_by: null, sent_by_name: null }; };
    const sql = async (parts, ...values) => {
      const query = parts.join("?");
      if (query.includes("INSERT INTO notifications.messages")) return [{ id }];
      if (query.includes("SELECT")) return [row];
      if (query.includes("sent_at = now()")) { row.sent_at = new Date(); row.error = null; }
      else if (query.includes("error = NULL")) { row.sent_at = null; row.error = null; }
      else if (query.includes("error =")) { row.error = values[0]; if (query.includes("sent_at = NULL")) row.sent_at = null; }
      return [];
    };
    globalThis.notificationLegacySql = sql;
    Bun.plugin({ name: "notification-legacy-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/]index\\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.notificationLegacySql;'), loader: "ts",
      }));
    }});
    mock.module(${JSON.stringify(new URL("../logging/index.ts", import.meta.url).pathname)}, () => ({ logger: () => ({ error() {}, info() {}, warn() {} }), trace: {} }));
    mock.module(${JSON.stringify(new URL("./email-mail.ts", import.meta.url).pathname)}, () => ({
      notificationMailError: error => error,
      notificationMailOutcomeById: async () => { throw new Error("Legacy sends have no delivery id"); },
      sendNotificationMail: async (...args) => { calls.push(args); return { status: mailStatus, id }; },
      notificationMailOutcome: async record => {
        if (["failed", "cancelled"].includes(record.status)) throw new Error("550 Rejected");
        return { status: ["sent", "bounced"].includes(record.status) ? "delivered" : "pending", outgoingMailId: id, retryAfterMs: 2000 };
      },
    }));
    const { notifications } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)});
    for (const status of ["sent", "bounced", "queued", "sending", "failed", "cancelled"]) {
      reset(); mailStatus = status;
      const expected = ["sent", "bounced"].includes(status) ? "sent" : ["queued", "sending"].includes(status) ? "pending" : "error";
      const result = await notifications.send({ type: "email", recipient: row.recipient, subject: row.subject, rawHtml: row.content });
      assert.equal(result.status, expected);
      assert.equal(calls[0][3], "notification-message:" + id);
      assert.deepEqual(calls[0][2], { content: undefined, rawHtml: row.content });
      assert.equal(Boolean(row.sent_at), expected === "sent"); assert.equal(Boolean(row.error), expected === "error");
      reset(); mailStatus = status;
      const summary = await notifications.sendAllPendingSystem();
      assert.equal(summary.sent, expected === "sent" ? 1 : 0); assert.equal(summary.failed, expected === "error" ? 1 : 0);
      assert.equal(calls[0][3], "notification-message:" + id);
      reset(); row.sent_at = new Date(); row.error = "Old failure";
      const resend = await notifications.resend(id);
      assert.equal(resend.ok, expected !== "error"); assert.equal(calls[0][3], undefined);
      assert.equal(Boolean(row.sent_at), expected === "sent"); assert.equal(Boolean(row.error), expected === "error");
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
