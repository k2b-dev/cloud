import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createSync, type Sync } from "@k2b/sync";
import { sql } from "bun";
import { type SmtpSinkOptions, smtpSink } from "../../../../../scripts/fixtures/smtp-sink";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { deleteTestNamespace } from "../../../../../scripts/fixtures/test-sync";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate } from "../../../../core/src/migrate/core/outgoing-mail";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import * as registry from "../../_internal/registry";
import { createAdminOutgoingMailRoutes } from "../../api/admin-outgoing-mail";
import type { MailMessage, MailRecord } from "../../contracts/outgoing-mail";
import type { AppRegistryEntry } from "../../contracts/registry";
import { buildProjectedUser } from "../session/user";
import * as settings from "../settings";
import { outgoingMailLog } from "./admin";
import { processOutgoingMail, recoverOutgoingMail } from "./dispatcher";
import { mail } from "./index";
import { messageAttachmentRefs, outgoingMailMessages } from "./messages";
import { retainOutgoingMail, retainOutgoingMailBatch } from "./retention";
import { startOutgoingMailRuntime, stopOutgoingMailRuntime } from "./runtime";
import { outgoingMailStore } from "./store";
import { mailAttachments } from "./sync";

const caller = (id: string) => {
  clearProcessApplicationId();
  bindProcessApplicationId(id, ["mail:send"]);
};
const app = (id: string): AppRegistryEntry => ({
  id,
  name: id === "inventory" ? "Inventory" : id,
  icon: "mail",
  description: id,
  routes: [],
  baseUrl: "http://test",
  platformPermissions: ["mail:send"],
});
const context = { actor: { uid: "mail-send-test" } };
const input = {
  to: ["reader@example.org"],
  subject: "Hello",
  text: "Plain text",
  html: "<p>Hello</p><script>alert(1)</script>",
  ref: { scope: "order", id: "42" },
};
const stopWaiting = AbortSignal.abort();
const data = (result: Awaited<ReturnType<typeof mail.send>>): MailRecord => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};

suiteFor("database", "nats")("outgoing mail acceptance and Core delivery", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: Sync;
  let registered: ReturnType<typeof spyOn<typeof registry, "listApps">>;
  let sink: ReturnType<typeof smtpSink>;
  let namespace: string;
  beforeAll(async () => {
    fresh = await useFreshDatabase("outgoing_mail_send");
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
    await migrate();
    await migrateAudit();
    connection = await connectTestNats({ ignoreClusterUpdates: true });
    namespace = testSyncNamespace("outgoing-mail-send");
    sync = createSync({ connection, namespace, application: "core", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    await sync.ready();
    registered = spyOn(registry, "listApps").mockResolvedValue([app("core"), app("inventory"), app("other")]);
  });
  beforeEach(async () => {
    caller("inventory");
    await sql`DELETE FROM outgoing_mail.messages`;
    await sql`DELETE FROM outgoing_mail.app_profiles`;
    await sql`DELETE FROM outgoing_mail.app_access`;
    await sql`DELETE FROM outgoing_mail.profiles`;
    await sql`DELETE FROM settings.entries`;
    await sql`DELETE FROM audit.events`;
    sink = smtpSink();
    await configure();
  });
  afterEach(async () => {
    await stopOutgoingMailRuntime();
    sink?.stop();
  });
  afterAll(async () => {
    await stopOutgoingMailRuntime();
    registered?.mockRestore();
    clearProcessApplicationId();
    unbindProcessSync();
    await sync?.drain();
    if (namespace) await deleteTestNamespace(namespace);
    await connection?.drain();
    await sql.close();
    await fresh?.drop();
  });
  const configure = async (changes: { dailyRecipientLimit?: number; maxAttachmentBytes?: number } = {}) => {
    const profiles = await outgoingMailStore.list();
    const current = profiles.find((profile) => profile.key === "alerts");
    await outgoingMailStore.put(
      "alerts",
      {
        name: "Alerts",
        fromAddress: "alerts@example.org",
        fromName: null,
        smtpHost: sink.host,
        smtpPort: sink.port,
        smtpSecure: false,
        smtpUser: null,
        pacePerMinute: 60,
        dailyRecipientLimit: null,
        maxAttachmentBytes: 25 * 1024 * 1024,
        ...(current ? { revision: current.revision } : {}),
        ...changes,
      },
      context,
    );
  };
  const scriptedSink = async (reply: SmtpSinkOptions["reply"]) => {
    sink.stop();
    sink = smtpSink({ reply });
    await configure();
  };
  const accept = async (message: MailMessage = input) => data(await mail.send(message, { signal: stopWaiting }));
  const delivery = async (record: MailRecord) => {
    await processOutgoingMail(record.id);
    return (await outgoingMailMessages.read(record.id))!;
  };

  test("stream attachment reaches SMTP once, with correct metadata, identity and sanitized unframed HTML", async () => {
    await startOutgoingMailRuntime();
    const bytes = new TextEncoder().encode("stream attachment bytes");
    const record = data(
      await mail.send({
        ...input,
        attachments: [{ filename: "hello.txt", contentType: "text/plain", content: new Blob([bytes]).stream() }],
      }),
    );
    expect(record.status).toBe("sent");
    expect(sink.messages).toHaveLength(1);
    const message = sink.messages[0]!;
    expect(message.from).toBe("alerts@example.org");
    expect(message.raw).toContain("From: Inventory <alerts@example.org>");
    expect(message.raw).toContain(`Message-ID: <${record.id}@example.org>`);
    expect(message.raw).toContain(Buffer.from(bytes).toString("base64"));
    expect(message.raw).not.toContain("alert(1)");
    expect(message.raw).not.toContain("Cloud test email");
    expect(record.attachments[0]).toMatchObject({
      filename: "hello.txt",
      size: bytes.length,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    });
    const row = await outgoingMailMessages.read(record.id);
    expect(row?.attachment_refs).toBeNull();
    expect(JSON.stringify(row?.attachments)).not.toContain(Buffer.from(bytes).toString("base64"));
    expect(await outgoingMailLog.get(record.id)).not.toHaveProperty("text");
    const events = await sql<
      { metadata: Record<string, unknown> }[]
    >`SELECT metadata FROM audit.events WHERE action = 'outgoing_mail.send'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ appId: "inventory", recipientCount: 1, id: record.id });
    expect(JSON.stringify(events)).not.toContain(input.to[0]!);
    expect(JSON.stringify(events)).not.toContain(input.subject);
  }, 45_000);
  test("attachment total and disallowed headers fail before recording", async () => {
    await configure({ maxAttachmentBytes: 3 });
    expect(
      await mail.send(
        {
          ...input,
          attachments: [
            { filename: "a", contentType: "text/plain", content: new Uint8Array(2) },
            { filename: "b", contentType: "text/plain", content: new Uint8Array(2) },
          ],
        },
        { signal: stopWaiting },
      ),
    ).toMatchObject({ ok: false, error: { code: "attachments_too_large" } });
    expect(await mail.send({ ...input, headers: { "X-Cloud-Trace": "secret" } })).toMatchObject({
      ok: false,
      error: { code: "bad_input" },
    });
    expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(0);
  });
  test("550 permanently fails with the SMTP answer; 451 requeues and later succeeds", async () => {
    await scriptedSink((command) => (command === "MESSAGE" ? "550 permanent rejection" : undefined));
    const failed = await delivery(await accept());
    expect(failed.status).toBe("failed");
    expect(failed.error_message).toContain("550 permanent rejection");
    await scriptedSink((command) => (command === "MESSAGE" ? "451 please retry" : undefined));
    const retry = await delivery(await accept());
    expect(retry.status).toBe("queued");
    expect(retry.error_message).toContain("451 please retry");
    expect(new Date(retry.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
    expect(retry.attempt_count).toBe(1);
    await scriptedSink(() => undefined);
    await sql`UPDATE outgoing_mail.messages SET next_attempt_at = now() WHERE id = ${retry.id}::uuid`;
    await processOutgoingMail(retry.id);
    expect((await outgoingMailMessages.read(retry.id))?.status).toBe("sent");
    expect(sink.messages).toHaveLength(1);
    expect((await outgoingMailMessages.read(retry.id))?.attempt_count).toBe(2);
  });
  test("expired queued mail fails with its last answer even when its retry time is later", async () => {
    const record = await accept();
    await sql`UPDATE outgoing_mail.messages SET deadline_at = now() - INTERVAL '1 second', next_attempt_at = now() + INTERVAL '1 hour', error_code = 'smtp_failed', error_message = '451 last answer' WHERE id = ${record.id}::uuid`;
    expect(await recoverOutgoingMail()).toContain(record.id);
    const row = await delivery(record);
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("451 last answer");
    expect(sink.messages).toHaveLength(0);
  });
  test("all rejected recipients permanently fail with the SMTP answer", async () => {
    await scriptedSink((command) => (command === "RCPT" ? "550 unknown recipient" : undefined));
    const row = await delivery(await accept());
    expect(row.status).toBe("failed");
    expect(row.error_message).toContain("550 unknown recipient");
    expect(sink.messages).toHaveLength(0);
  });
  test("individual RCPT rejections remain sent with recipient failures", async () => {
    await scriptedSink((command, argument) => (command === "RCPT" && argument.includes("bad@") ? "550 unknown recipient" : undefined));
    const row = await delivery(await accept({ ...input, to: ["good@example.org", "bad@example.org"] }));
    expect(row.status).toBe("sent");
    const result = await mail.list({ ids: [row.id] });
    expect(result.ok && result.data.items[0]?.failures).toEqual([
      { recipient: "bad@example.org", reason: "550 unknown recipient", at: expect.any(String) },
    ]);
  });
  test("known keys cancel unread streams, and racing keys return one record and one SMTP message", async () => {
    const first = await accept({ ...input, key: "known" });
    let read = 0,
      cancelled = false;
    const content = new ReadableStream<Uint8Array>(
      {
        pull() {
          read++;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const duplicate = await accept({ ...input, key: "known", attachments: [{ filename: "unread", contentType: "text/plain", content }] });
    expect(duplicate.id).toBe(first.id);
    expect(read).toBe(0);
    expect(cancelled).toBe(true);
    const raced = await Promise.all(
      Array.from({ length: 2 }, () =>
        accept({ ...input, key: "race", attachments: [{ filename: "hello", contentType: "text/plain", content: new Uint8Array([1, 2]) }] }),
      ),
    );
    expect(raced[0]!.id).toBe(raced[1]!.id);
    const objects = [];
    for await (const object of mailAttachments().list({ tenantId: raced[0]!.id })) objects.push(object);
    expect(objects.filter((object) => object.ref.key.startsWith(raced[0]!.id))).toHaveLength(1);
    await delivery(raced[0]!);
    await delivery(raced[1]!);
    expect(sink.messages).toHaveLength(1);
    expect(await sql`SELECT id FROM outgoing_mail.messages WHERE idempotency_key = 'race'`).toHaveLength(1);
    expect(await sql`SELECT id FROM audit.events WHERE action = 'outgoing_mail.send'`).toHaveLength(4);
  });
  test("rolling quota remains atomic under ten concurrent calls and profiles report real usage", async () => {
    await configure({ dailyRecipientLimit: 5 });
    const results = await Promise.all(Array.from({ length: 10 }, () => mail.send(input, { signal: stopWaiting })));
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    for (const result of results.filter((result) => !result.ok))
      expect(result).toMatchObject({ error: { code: "quota_exceeded", limit: 5, used: 5, requested: 1 } });
    expect(await mail.profiles()).toMatchObject({ ok: true, data: [{ quota: { dailyRecipients: 5, usedLast24h: 5 } }] });
    const first = results.find((result) => result.ok)!;
    if (!first.ok) throw new Error("Missing accepted record");
    await outgoingMailLog.cancel(first.data.id, context);
    expect((await mail.send(input, { signal: stopWaiting })).ok).toBe(true);
    await sql`UPDATE outgoing_mail.messages SET created_at = now() - INTERVAL '25 hours'`;
    expect(await mail.profiles()).toMatchObject({ ok: true, data: [{ quota: { usedLast24h: 0 } }] });
  });
  test("lost commit replies and failed acceptance races each audit the recovered send exactly once", async () => {
    const original = outgoingMailMessages.accept;
    const acceptCall = spyOn(outgoingMailMessages, "accept").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("Commit reply lost");
    });
    try {
      const committed = await accept({ ...input, key: "lost-commit" });
      expect(committed.status).toBe("queued");
      expect(await sql`SELECT id FROM audit.events WHERE action = 'outgoing_mail.send'`).toHaveLength(1);
      acceptCall.mockRestore();
      const winner = await accept({ ...input, key: "lost-race" });
      let reads = 0;
      const known = outgoingMailMessages.known;
      const lookup = spyOn(outgoingMailMessages, "known").mockImplementation((...args) =>
        ++reads === 1 ? Promise.resolve(undefined) : known(...args),
      );
      const failed = spyOn(outgoingMailMessages, "accept").mockRejectedValue(new Error("Acceptance transaction failed"));
      try {
        const recovered = await accept({ ...input, key: "lost-race" });
        expect(recovered.id).toBe(winner.id);
        expect(await sql`SELECT id FROM audit.events WHERE action = 'outgoing_mail.send'`).toHaveLength(3);
        expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(2);
      } finally {
        failed.mockRestore();
        lookup.mockRestore();
      }
    } finally {
      acceptCall.mockRestore();
    }
  });
  test("list stays app-scoped and keyset pages survive tied timestamps, new rows and deleted anchors", async () => {
    for (let i = 0; i < 5; i++) await accept({ ...input, ref: { scope: "order", id: String(i) } });
    await sql`UPDATE outgoing_mail.messages SET created_at = '2026-10-07T00:00:00.123456Z'`;
    caller("other");
    const foreign = await accept();
    caller("inventory");
    const first = await mail.list({}, { perPage: 2 });
    if (!first.ok) throw new Error("List failed");
    const ids = first.data.items.map((item) => item.id);
    expect(first.data.total).toBe(5);
    const anchor = first.data.items.at(-1)!;
    await sql`DELETE FROM outgoing_mail.messages WHERE id = ${anchor.id}::uuid`;
    const newer = await accept();
    const second = await mail.list({}, { perPage: 2, cursor: first.data.nextCursor });
    if (!second.ok) throw new Error("List failed");
    const third = await mail.list({}, { perPage: 2, cursor: second.data.nextCursor });
    if (!third.ok) throw new Error("List failed");
    ids.push(...second.data.items.map((item) => item.id), ...third.data.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(5);
    expect(ids).not.toContain(foreign.id);
    expect(ids).not.toContain(newer.id);
    expect(await mail.list({ ids: [foreign.id] })).toMatchObject({ ok: true, data: { items: [] } });
    expect(await mail.list({}, { cursor: "invalid" })).toMatchObject({ ok: false, error: { code: "bad_input" } });
  });
  test("revoked grants and removed profiles cancel queued mail and delete stored attachments", async () => {
    const queued = await accept({ ...input, attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([1]) }] });
    const ref = messageAttachmentRefs((await outgoingMailMessages.read(queued.id))!)[0]!;
    await outgoingMailStore.setAppAccess("inventory", { mode: "selected", profiles: [] }, context);
    const row = await delivery(queued);
    expect(row.status).toBe("cancelled");
    expect(row.error_code).toBe("profile_not_allowed");
    expect(await mailAttachments().get(ref)).toBeNull();
    expect(row.attachment_refs).toBeNull();
    await outgoingMailStore.setAppAccess("inventory", { mode: "default" }, context);
    const removed = await accept();
    await sql`DELETE FROM outgoing_mail.profiles`;
    expect((await delivery(removed)).error_code).toBe("profile_removed");
    expect(sink.messages).toHaveLength(0);
  });
  test("lost attachments permanently fail before SMTP, while stale sending rows recover", async () => {
    const queued = await accept({ ...input, attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([1]) }] });
    const refs = messageAttachmentRefs((await outgoingMailMessages.read(queued.id))!);
    await mailAttachments().delete(refs[0]!);
    expect((await delivery(queued)).error_code).toBe("attachment_lost");
    expect(sink.messages).toHaveLength(0);
    const stale = await accept();
    await sql`UPDATE outgoing_mail.messages SET status = 'sending', updated_at = now() - INTERVAL '6 minutes' WHERE id = ${stale.id}::uuid`;
    expect(await recoverOutgoingMail()).toContain(stale.id);
    expect((await delivery(stale)).status).toBe("sent");
  });
  test("retention purges bodies and headers, keeps metadata, and deletes at most 1000 rows per batch", async () => {
    const record = await accept({ ...input, headers: { "X-App": "hello" } });
    await sql`UPDATE outgoing_mail.messages SET created_at = now() - INTERVAL '100 days' WHERE id = ${record.id}::uuid`;
    expect(await retainOutgoingMailBatch(90, 365)).toEqual({ purged: 1, deleted: 0 });
    const purged = (await outgoingMailMessages.read(record.id))!;
    expect(purged.text_body).toBeNull();
    expect(purged.html_body).toBeNull();
    expect(purged.headers).toBeNull();
    expect(purged.subject).toBe(input.subject);
    expect(purged.content_purged_at).not.toBeNull();
    expect(await outgoingMailLog.content(record.id, context)).toMatchObject({ purged: true });
    await sql`INSERT INTO outgoing_mail.messages(id, app_id, profile_key, lane, to_addresses, recipient_count, subject, message_id_header, status, deadline_at, created_at)
      SELECT gen_random_uuid(), 'inventory', 'alerts', 'immediate', ARRAY['reader@example.org'], 1, 'old', '<' || gen_random_uuid()::text || '@example.org>', 'failed', now(), now() - INTERVAL '400 days' FROM generate_series(1, 1001)`;
    expect(await retainOutgoingMailBatch(90, 365)).toEqual({ purged: 0, deleted: 1000 });
    expect(await retainOutgoingMailBatch(90, 365)).toEqual({ purged: 0, deleted: 1 });
    const unpurged = await accept();
    await sql`UPDATE outgoing_mail.messages SET created_at = now() - INTERVAL '60 days' WHERE id = ${unpurged.id}::uuid`;
    expect(await retainOutgoingMailBatch(90, 30)).toEqual({ purged: 0, deleted: 2 });
    expect(await outgoingMailMessages.read(unpurged.id)).toBeUndefined();
  });
  suiteFor("valkey")("retention API settings", () => {
    test("PUT changes effective settings used by the retention job and audits old and new values", async () => {
      const keys = ["outgoing_mail.content_retention_days", "outgoing_mail.record_retention_days"];
      await settings.invalidateSettingsCache(keys);
      const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
      const routes = createAdminOutgoingMailRoutes(async (c, next) => {
        c.set("user", user);
        await next();
      });
      try {
        const content = await accept();
        const expired = await accept();
        await sql`UPDATE outgoing_mail.messages SET created_at = now() - INTERVAL '15 days' WHERE id = ${content.id}::uuid`;
        await sql`UPDATE outgoing_mail.messages SET created_at = now() - INTERVAL '40 days' WHERE id = ${expired.id}::uuid`;
        expect(await (await routes.request("/retention")).json()).toEqual({ contentDays: 90, recordDays: 365 });
        await retainOutgoingMail();
        expect((await outgoingMailMessages.read(content.id))?.text_body).toBe(input.text);
        expect(await outgoingMailMessages.read(expired.id)).toBeDefined();
        const next = { contentDays: 10, recordDays: 30 };
        const saved = await routes.request("/retention", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual(next);
        expect(await (await routes.request("/retention")).json()).toEqual(next);
        expect(
          await sql<{ metadata: unknown }[]>`SELECT metadata FROM audit.events WHERE action = 'outgoing_mail.retention.update'`,
        ).toEqual([{ metadata: { old: { contentDays: 90, recordDays: 365 }, new: next } }]);
        await retainOutgoingMail();
        expect((await outgoingMailMessages.read(content.id))?.text_body).toBeNull();
        expect(await outgoingMailMessages.read(expired.id)).toBeUndefined();
        // Generic settings may hold either ordering; record deletion still wins.
        await sql.begin(async (tx) => {
          await settings.set(keys[0]!, 90, tx);
          await settings.set(keys[1]!, 1, tx);
        });
        await settings.invalidateSettingsCache(keys);
        await retainOutgoingMail();
        expect(await outgoingMailMessages.read(content.id)).toBeUndefined();
      } finally {
        await sql`DELETE FROM settings.entries WHERE key IN ('outgoing_mail.content_retention_days', 'outgoing_mail.record_retention_days')`;
        await settings.invalidateSettingsCache(keys);
      }
    });
  });
  test("admin metadata never contains content, content reads audit once, and only queued rows cancel", async () => {
    const record = await accept();
    const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
    const routes = createAdminOutgoingMailRoutes(async (c, next) => {
      c.set("user", user);
      await next();
    });
    const listed = await routes.request("/messages?app=inventory&profile=alerts&status=queued&ref=order:42&recipient=reader");
    expect(await listed.json()).toMatchObject({ items: [{ id: record.id, appId: "inventory" }] });
    expect(await (await routes.request(`/messages/${record.id}`)).json()).not.toHaveProperty("text");
    expect(await (await routes.request(`/messages/${record.id}/content`)).json()).toMatchObject({ text: input.text, purged: false });
    expect(await sql`SELECT id FROM audit.events WHERE action = 'outgoing_mail.message.read'`).toHaveLength(1);
    const cancelled = await routes.request(`/messages/${record.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled", errorCode: "cancelled_by_admin" });
    expect((await routes.request(`/messages/${record.id}/cancel`, { method: "POST" })).status).toBe(409);
    expect(await sql`SELECT id FROM audit.events WHERE action = 'outgoing_mail.message.cancel'`).toHaveLength(1);
    const sent = await delivery(await accept());
    expect((await routes.request(`/messages/${sent.id}/cancel`, { method: "POST" })).status).toBe(409);
  });
  test("without a worker send waits at most 30 seconds, returns queued, and recovery sends after startup", async () => {
    const started = Date.now();
    const record = data(await mail.send(input));
    expect(record.status).toBe("queued");
    expect(Date.now() - started).toBeLessThan(33_000);
    expect(sink.messages).toHaveLength(0);
    await startOutgoingMailRuntime();
    const deadline = Date.now() + 5000;
    while ((await outgoingMailMessages.read(record.id))?.status !== "sent" && Date.now() < deadline) await Bun.sleep(25);
    expect((await outgoingMailMessages.read(record.id))?.status).toBe("sent");
    expect(sink.messages).toHaveLength(1);
  }, 45_000);
  test("aborting only the wait leaves durable mail deliverable", async () => {
    const record = await accept();
    expect(record.status).toBe("queued");
    expect((await delivery(record)).status).toBe("sent");
    expect(sink.messages).toHaveLength(1);
  });
});
