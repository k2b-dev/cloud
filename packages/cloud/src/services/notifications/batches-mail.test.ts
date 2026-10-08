import { expect, test } from "bun:test";

test("batch chunks retain recipients through enqueue failures, reclaims, settlement and operator retries", async () => {
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    const batchId = "00000000-0000-4000-8000-000000000001";
    let sequence = 10;
    const nextId = () => "00000000-0000-4000-8000-" + String(sequence++).padStart(12, "0");
    const batch = { id: batchId, subject: "Batch", body_markdown: "Hello", body_html: "<p>Hello</p>", selection: {}, selection_hash: "hash", status: "ready", created_at: new Date() };
    let recipients = [], failure, calls = [], loseAttachment = false;
    const history = new Map(), mails = new Map();
    const reset = () => {
      batch.status = "ready"; history.clear(); mails.clear(); failure = undefined; calls = []; loseAttachment = false;
      recipients = [1, 2].map(n => ({ user_id: nextId(), recipient: "reader" + n + "@example.org", status: "pending", notification_id: null, outgoing_mail_id: null, attempt_count: 0 }));
    };
    const sql = async (parts, ...values) => {
      const query = parts.join("?");
      if (query.includes("SET status = 'running'")) { if (!["ready", "running"].includes(batch.status)) return []; batch.status = "running"; return [batch]; }
      if (query.includes("WITH terminal AS")) {
        assert.ok(query.includes("r.outgoing_mail_id = t.outgoing_mail_id"));
        const settled = [];
        for (const r of recipients) {
          const mail = [...mails.values()].find(m => m.id === r.outgoing_mail_id);
          if (r.status !== "sending" || !r.outgoing_mail_id || mail && !["sent", "bounced", "failed", "cancelled"].includes(mail.status)) continue;
          r.status = mail && ["sent", "bounced"].includes(mail.status) ? "sent" : "error";
          r.sent_at = r.status === "sent" ? new Date() : null; r.error = r.status === "sent" ? null : mail ? "550 Rejected" : "Outgoing mail record is no longer available.";
          Object.assign(history.get(r.notification_id), { sent_at: r.sent_at, error: r.error }); settled.push({ id: r.notification_id });
        }
        return settled;
      }
      if (query.includes("RETURNING r.user_id, r.recipient")) {
        assert.ok(query.includes("outgoing_mail_id IS NULL"), "in-flight queued mail must not be reclaimed");
        return recipients.filter(r => !r.outgoing_mail_id && (r.status === "pending" || r.status === "sending" && r.stale)).map(r => {
          r.status = "sending"; r.attempt_count++; r.stale = false;
          return { user_id: r.user_id, recipient: r.recipient, notification_id: r.notification_id };
        });
      }
      if (query.includes("INSERT INTO notifications.messages")) {
        const id = nextId(); history.set(id, { id, sent_at: null, error: null }); return [{ id }];
      }
      if (query.includes("SET notification_id")) { recipients.find(r => r.user_id === values[2]).notification_id = values[0]; return []; }
      if (query.includes("SET outgoing_mail_id")) {
        if (loseAttachment) { loseAttachment = false; throw new Error("Database reply lost"); }
        const r = recipients.find(r => r.user_id === values[2]);
        if (r.status === "sending" && r.notification_id === values[3]) r.outgoing_mail_id = values[0];
        return [];
      }
      if (query.includes("WITH changed AS")) {
        assert.ok(query.includes("notification_id = ANY"));
        for (const r of recipients.filter(r => r.status === "sending" && !r.outgoing_mail_id && values[3].includes(r.notification_id))) {
          r.status = values[0]; r.error = values[1]; history.get(r.notification_id).error = r.error;
        }
        return [];
      }
      if (query.includes("SELECT COUNT(*)::int AS count")) return [{ count: recipients.filter(r => ["pending", "sending"].includes(r.status)).length }];
      if (query.includes("WITH counts AS")) {
        batch.sent_count = recipients.filter(r => r.status === "sent").length;
        batch.error_count = recipients.filter(r => r.status === "error").length;
        if (!["ready", "cancelled"].includes(batch.status) && recipients.every(r => !["pending", "sending"].includes(r.status))) batch.status = batch.error_count ? "completed_with_errors" : "completed";
        return [batch];
      }
      if (query.includes("SELECT * FROM notifications.batches")) return [batch];
      if (query.includes("SET status = 'pending'")) {
        assert.ok(query.includes("outgoing_mail_id = NULL"));
        const r = recipients.find(r => r.user_id === values[1]);
        if (r.status !== "error") return [];
        Object.assign(r, { status: "pending", notification_id: null, outgoing_mail_id: null, error: null }); return [{ ...r }];
      }
      if (query.includes("SET status = 'ready'")) { batch.status = "ready"; return []; }
      throw new Error("Unexpected SQL: " + query);
    };
    sql.begin = async callback => callback(sql);
    globalThis.notificationBatchSql = sql;
    Bun.plugin({ name: "notification-batch-mail-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/]batches\\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.notificationBatchSql;'), loader: "ts",
      }));
    }});
    mock.module(${JSON.stringify(new URL("../../_internal/process-sync.ts", import.meta.url).pathname)}, () => ({ lazySync: () => () => ({ submit: async () => ({ jobId: "retry" }) }) }));
    mock.module(${JSON.stringify(new URL("../logging/index.ts", import.meta.url).pathname)}, () => ({ logger: () => ({ error() {} }), trace: {} }));
    mock.module(${JSON.stringify(new URL("../../shared/markdown.ts", import.meta.url).pathname)}, () => ({ markdown: {} }));
    mock.module(${JSON.stringify(new URL("../postgres.ts", import.meta.url).pathname)}, () => ({ parsePgJsonValue: v => v, toPgTextArray: v => v, toPgUuidArray: v => v }));
    mock.module(${JSON.stringify(new URL("../audit/index.ts", import.meta.url).pathname)}, () => ({ audit: { record: async () => {} } }));
    mock.module(${JSON.stringify(new URL("./email-frame.ts", import.meta.url).pathname)}, () => ({ prepareNotificationEmail: async () => ({ html: "<!DOCTYPE html><html><body>Hello</body></html>", text: "Hello" }) }));
    mock.module(${JSON.stringify(new URL("./email-mail.ts", import.meta.url).pathname)}, () => ({ notificationMailError: error => Object.assign(error, { retryable: ["mail_unavailable", "backlog_full", "quota_exceeded"].includes(error.code ?? "mail_unavailable") }) }));
    mock.module(${JSON.stringify(new URL("../outgoing-mail/store.ts", import.meta.url).pathname)}, () => ({ OutgoingMailError: class extends Error { constructor(code, message) { super(message); this.code = code; } } }));
    mock.module(${JSON.stringify(new URL("../outgoing-mail/enqueue.ts", import.meta.url).pathname)}, () => ({ enqueueMail: async (app, messages, options) => {
      assert.equal(app, "core"); assert.deepEqual(options, { trustedHtml: true }); calls.push(messages);
      if (failure) throw failure;
      return { batchId: "bulk", ids: messages.map(message => {
        assert.ok(!("profile" in message)); assert.ok(message.html.startsWith("<!DOCTYPE"));
        let mail = mails.get(message.key);
        if (!mail) { mail = { id: nextId(), status: "queued" }; mails.set(message.key, mail); }
        return mail.id;
      }) };
    }}));
    const { __notificationBatchTest: hooks, retryRecipient } = await import(${JSON.stringify(new URL("./batches.ts", import.meta.url).pathname)});
    reset();
    assert.deepEqual(await hooks.processBatchChunk(batchId), { processed: 2, remaining: 2 });
    assert.equal(calls.length, 1); assert.equal(calls[0].length, 2); assert.equal(mails.size, 2);
    const firstKeys = calls[0].map(m => m.key);
    assert.ok(recipients.every(r => r.status === "sending" && r.outgoing_mail_id));
    assert.ok([...history.values()].every(m => !m.sent_at && !m.error));
    recipients.forEach(r => r.stale = true);
    await hooks.processBatchChunk(batchId); assert.equal(calls.length, 1);
    // Lost recipient linkage after acceptance must still reuse the persisted generation.
    recipients.forEach(r => { r.outgoing_mail_id = null; r.stale = true; });
    await hooks.processBatchChunk(batchId); assert.deepEqual(calls[1].map(m => m.key), firstKeys); assert.equal(mails.size, 2);
    [...mails.values()][0].status = "bounced"; [...mails.values()][1].status = "failed";
    assert.deepEqual(await hooks.processBatchChunk(batchId), { processed: 2, remaining: 0 });
    assert.equal(batch.status, "completed_with_errors"); assert.equal(batch.sent_count, 1); assert.equal(batch.error_count, 1);
    assert.ok([...history.values()][0].sent_at); assert.equal([...history.values()][1].error, "550 Rejected");
    const failedRecipient = recipients.find(r => r.status === "error");
    assert.equal((await retryRecipient({ id: batchId, userId: failedRecipient.user_id, actor: { userId: failedRecipient.user_id } })).ok, true);
    await hooks.processBatchChunk(batchId); assert.equal(mails.size, 3); assert.ok(!firstKeys.includes(calls.at(-1)[0].key));
    for (const code of ["backlog_full", "quota_exceeded", "mail_unavailable", "profile_not_allowed", "profile_unknown", "bad_input"]) {
      reset(); failure = Object.assign(new Error(code), { code });
      const outcome = await hooks.processBatchChunk(batchId);
      const retryable = ["backlog_full", "quota_exceeded", "mail_unavailable"].includes(code);
      assert.equal(outcome.remaining, retryable ? 2 : 0); assert.equal(outcome.processed, 0);
      assert.ok(recipients.every(r => r.status === (retryable ? "pending" : "error")));
      assert.equal(mails.size, 0);
      if (retryable) {
        const keys = calls[0].map(m => m.key); failure = undefined;
        await hooks.processBatchChunk(batchId); assert.deepEqual(calls[1].map(m => m.key), keys);
      } else assert.ok([...history.values()].every(m => m.error === code));
    }
    reset();
    await hooks.processBatchChunk(batchId); mails.clear();
    assert.deepEqual(await hooks.processBatchChunk(batchId), { processed: 2, remaining: 0 });
    assert.equal(calls.length, 1); assert.equal(batch.status, "completed_with_errors");
    assert.ok([...history.values()].every(m => m.error === "Outgoing mail record is no longer available."));
    reset(); loseAttachment = true;
    await hooks.processBatchChunk(batchId);
    assert.equal(mails.size, 2); assert.ok(recipients.every(r => r.status === "pending"));
    await hooks.processBatchChunk(batchId); assert.equal(mails.size, 2);
    assert.deepEqual(calls[1].map(m => m.key), calls[0].map(m => m.key));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
