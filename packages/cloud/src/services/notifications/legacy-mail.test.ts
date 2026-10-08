import { expect, test } from "bun:test";

test("legacy sends use stable message keys, leave accepted mail pending, and create fresh explicit resends", async () => {
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    const id = "00000000-0000-4000-8000-000000000001";
    let mailStatus, row, calls;
    const mails = new Map();
    const reset = () => { calls = []; mails.clear(); row = { id, type: "email", recipient: "reader@example.org", subject: "Legacy", content: "<p>Hello</p>", sent_at: null, error: null, outgoing_mail_id: null, mail_generation: 0, created_at: new Date(), sent_by: null, sent_by_name: null }; };
    const sql = async (parts, ...values) => {
      const query = parts.join("?");
      if (query.includes("INSERT INTO notifications.messages")) return [{ id }];
      if (query.includes("SELECT COUNT")) return [{ count: !row.sent_at && !row.error && !row.outgoing_mail_id ? 1 : 0 }];
      if (query.includes("SELECT m.*")) return [{ ...row, current_mail_status: [...mails.values()].find(m => m.id === row.outgoing_mail_id)?.status ?? null }];
      if (query.includes("SELECT")) return query.includes("outgoing_mail_id IS NULL") && row.outgoing_mail_id ? [] : [{ ...row }];
      if (query.includes("SET mail_generation = mail_generation + 1")) {
        row.mail_generation++; row.outgoing_mail_id = null; row.sent_at = null; row.error = null; return [{ ...row }];
      }
      if (query.includes("subject = COALESCE")) {
        assert.ok(query.includes("mail_generation + 1") && query.includes("outgoing_mail_id = CASE"));
        if (values[0] !== null) row.subject = values[0];
        if (values[3]) { row.mail_generation++; row.outgoing_mail_id = null; row.error = null; }
        return [];
      }
      if (query.includes("SET outgoing_mail_id")) { row.outgoing_mail_id = values[0]; row.sent_at = null; row.error = null; }
      else if (query.includes("sent_at = now()")) { row.sent_at = new Date(); row.error = null; }
      else if (query.includes("error =")) { row.error = values[0]; if (query.includes("sent_at = NULL")) row.sent_at = null; }
      return [];
    };
    sql.begin = async callback => callback(sql);
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
      sendNotificationMail: async (...args) => {
        calls.push(args); let record = mails.get(args[3]);
        if (!record) { record = { status: mailStatus, id: crypto.randomUUID() }; mails.set(args[3], record); }
        return record;
      },
      notificationMailOutcome: async record => {
        if (["failed", "cancelled"].includes(record.status)) throw new Error("550 Rejected");
        return { status: ["sent", "bounced"].includes(record.status) ? "delivered" : "pending", outgoingMailId: record.id, retryAfterMs: 2000 };
      },
    }));
    mock.module(${JSON.stringify(new URL("./batches.ts", import.meta.url).pathname)}, () => ({ notificationBatches: {} }));
    const { notifications } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)});
    for (const status of ["sent", "bounced", "queued", "sending", "failed", "cancelled"]) {
      reset(); mailStatus = status;
      const expected = ["sent", "bounced"].includes(status) ? "sent" : ["queued", "sending"].includes(status) ? "pending" : "error";
      const result = await notifications.send({ type: "email", recipient: row.recipient, subject: row.subject, rawHtml: row.content });
      assert.equal(result.status, expected); assert.ok(row.outgoing_mail_id);
      assert.equal(calls[0][3], "notification-message:" + id);
      assert.deepEqual(calls[0][2], { content: undefined, rawHtml: row.content });
      assert.equal(Boolean(row.sent_at), expected === "sent"); assert.equal(Boolean(row.error), expected === "error");
      reset(); mailStatus = status;
      const summary = await notifications.sendAllPendingSystem();
      assert.equal(summary.sent, expected === "sent" ? 1 : 0); assert.equal(summary.failed, expected === "error" ? 1 : 0);
      assert.equal(calls[0][3], "notification-message:" + id);
      reset(); row.sent_at = new Date(); row.error = "Old failure";
      const resend = await notifications.resend(id);
      assert.equal(resend.ok, expected !== "error"); assert.equal(calls[0][3], "notification-message:" + id);
      assert.equal(Boolean(row.sent_at), expected === "sent"); assert.equal(Boolean(row.error), expected === "error");
    }
    reset(); mailStatus = "queued";
    assert.equal((await notifications.resend(id)).ok, true);
    assert.ok(row.outgoing_mail_id); assert.equal(mails.size, 1);
    assert.equal(await notifications.getPendingSystemCount(), 0);
    await notifications.sendAllPendingSystem(); assert.equal(calls.length, 1);
    assert.equal((await notifications.resend(id)).ok, true); assert.equal(calls.length, 1);
    [...mails.values()][0].status = "sent"; row.sent_at = new Date();
    assert.equal((await notifications.resend(id)).ok, true);
    assert.equal(calls[1][3], "notification-message:" + id + ":1"); assert.equal(row.mail_generation, 1);
    assert.equal((await notifications.resend(id)).ok, true); assert.equal(mails.size, 2); assert.equal(calls.length, 2);
    row.error = "Failed";
    await notifications.update(id, { subject: "Edited" });
    assert.equal(row.mail_generation, 2); assert.equal(row.outgoing_mail_id, null); assert.equal(row.error, null);
    await notifications.sendAllPendingSystem(); assert.equal(calls[2][3], "notification-message:" + id + ":2");
    reset(); mailStatus = "queued";
    await notifications.resend(id);
    row.outgoing_mail_id = null; // Crash after mail acceptance, before recording its ID.
    await notifications.resend(id); assert.equal(mails.size, 1); assert.equal(row.mail_generation, 0);
    mails.clear(); // Retention removed the previously accepted mail.
    await notifications.resend(id); assert.equal(calls.at(-1)[3], "notification-message:" + id + ":1");

  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
