import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createSync, type Sync } from "@k2b/sync";
import { sql } from "bun";
import { smtpSink } from "../../../../../scripts/fixtures/smtp-sink";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { deleteTestNamespace } from "../../../../../scripts/fixtures/test-sync";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate } from "../../../../core/src/migrate/core/outgoing-mail";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import * as registry from "../../_internal/registry";
import { createAdminOutgoingMailRoutes } from "../../api/admin-outgoing-mail";
import type { MailMessage } from "../../contracts/outgoing-mail";
import { audit } from "../audit";
import { buildProjectedUser } from "../session/user";
import { outgoingMailLog } from "./admin";
import { MAIL_RECOVERY_MS } from "./bulk";
import { attemptOutgoingMail, processOutgoingMail, recoverOutgoingMail } from "./dispatcher";
import { claimOutgoingBulkMail, drainOutgoingMail, dueOutgoingBulkProfiles, MAIL_DRAIN_MS, nextOutgoingBulkDelay } from "./drain";
import { mail } from "./index";
import { messageAttachmentRefs, outgoingMailMessages } from "./messages";
import { startOutgoingMailRuntime, stopOutgoingMailRuntime } from "./runtime";
import { outgoingMailStore } from "./store";
import { mailAttachments } from "./sync";

const context = { actor: { uid: "mail-bulk-test" } };
const input: MailMessage = {
  to: ["reader@example.org"],
  subject: "Hello",
  text: "Hello",
  html: "<p>Hello</p><script>bad()</script>",
  headers: { "X-Test": "bulk" },
};
suiteFor("database", "nats")("atomic bulk mail and paced Core delivery", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: Sync;
  let registered: ReturnType<typeof spyOn<typeof registry, "listApps">>;
  let sink: ReturnType<typeof smtpSink>;
  let namespace: string;
  let profileId: string;
  let response: ((command: string, argument: string) => string | undefined) | undefined;
  beforeAll(async () => {
    fresh = await useFreshDatabase("outgoing_mail_bulk");
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
    await migrate();
    await migrateAudit();
    connection = await connectTestNats({ ignoreClusterUpdates: true });
    namespace = testSyncNamespace("outgoing-mail-bulk");
    sync = createSync({ connection, namespace, application: "core", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    await sync.ready();
    registered = spyOn(registry, "listApps").mockResolvedValue([
      {
        id: "inventory",
        name: "Inventory",
        icon: "mail",
        description: "Inventory",
        routes: [],
        baseUrl: "http://test",
        platformPermissions: ["mail:send"],
      },
    ]);
  });
  beforeEach(async () => {
    clearProcessApplicationId();
    bindProcessApplicationId("inventory", ["mail:send"]);
    await sql`DELETE FROM outgoing_mail.messages`;
    await sql`DELETE FROM outgoing_mail.app_profiles`;
    await sql`DELETE FROM outgoing_mail.app_access`;
    await sql`DELETE FROM outgoing_mail.profiles`;
    await sql`DELETE FROM audit.events`;
    response = undefined;
    sink = smtpSink({ reply: (command, argument) => response?.(command, argument) });
    const configured = await outgoingMailStore.put(
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
      },
      context,
    );
    const [profile] = await sql<{ id: string }[]>`SELECT id FROM outgoing_mail.profiles WHERE key = ${configured.profile.key}`;
    profileId = profile!.id;
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
  const enqueue = async (messages: MailMessage[] = [input]) => {
    const result = await mail.enqueue(messages);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.data;
  };
  // Move the gate instead of sleeping one minute for pace=1 or waiting on retry backoff.
  const openGate = () =>
    sql`UPDATE outgoing_mail.profiles SET next_bulk_slot_at = now() - INTERVAL '1 second' WHERE id = ${profileId}::uuid`;
  const deliverOne = async () => {
    await openGate();
    const claimed = await claimOutgoingBulkMail(profileId);
    if (!claimed) throw new Error("Missing due bulk row");
    await attemptOutgoingMail(claimed.row);
    return (await outgoingMailMessages.read(claimed.row.id))!;
  };

  test("120 messages: concurrent drain claims reserve one exact one-second slot and send every row once", async () => {
    const batch = await enqueue(Array.from({ length: 120 }, (_, index) => ({ ...input, key: `paced-${index}` })));
    const first = (await outgoingMailMessages.read(batch.ids[0]!))!;
    expect(first).toMatchObject({ batch_id: batch.batchId, status: "queued", message_id_header: `<${first.id}@example.org>` });
    expect(new Date(first.deadline_at).getTime() - new Date(first.created_at).getTime()).toBe(24 * 60 * 60_000);
    expect(first.html_body).not.toContain("bad()");
    const [types] = await sql<{ headers: string; attachments: string; refs: string }[]>`SELECT jsonb_typeof(headers) AS headers,
        jsonb_typeof(attachments) AS attachments, jsonb_typeof(attachment_refs) AS refs FROM outgoing_mail.messages WHERE id = ${first.id}::uuid`;
    expect(types).toEqual({ headers: "object", attachments: "array", refs: "array" });
    const sent = new Set<string>();
    for (let index = 0; index < 120; index++) {
      await openGate();
      const claims = await Promise.all([claimOutgoingBulkMail(profileId), claimOutgoingBulkMail(profileId)]);
      const winners = claims.filter((claim) => claim !== undefined);
      expect(winners).toHaveLength(1);
      const claim = winners[0]!;
      // PostgreSQL's returned times prove interval math independently of wall-clock sleeps.
      expect(new Date(claim.slotAt).getTime() - new Date(claim.grantedAt).getTime()).toBe(1000);
      expect(sent.has(claim.row.id)).toBe(false);
      sent.add(claim.row.id);
      await attemptOutgoingMail(claim.row);
    }
    expect(sent.size).toBe(120);
    expect(sink.messages).toHaveLength(120);
    expect(new Set(sink.messages.map((message) => message.raw.match(/Message-ID: (.+)/)?.[1])).size).toBe(120);
    expect(await sql`SELECT id FROM outgoing_mail.messages WHERE batch_id = ${batch.batchId}::uuid AND status = 'sent'`).toHaveLength(120);
    expect(await nextOutgoingBulkDelay(profileId)).toBeUndefined();
  }, 60_000);
  test("three 451 attempts use one, two and four minute backoff, then SMTP 250 settles", async () => {
    let attempts = 0;
    response = (command) => (command === "MESSAGE" && ++attempts <= 3 ? "451 please retry" : undefined);
    const batch = await enqueue();
    for (const [index, delay] of [60_000, 120_000, 240_000].entries()) {
      const before = Date.now();
      const row = await deliverOne();
      expect(row.status).toBe("queued");
      expect(row.attempt_count).toBe(index + 1);
      expect(row.error_message).toContain("451 please retry");
      expect(new Date(row.next_attempt_at!).getTime() - before).toBeGreaterThanOrEqual(delay);
      expect(new Date(row.next_attempt_at!).getTime() - Date.now()).toBeLessThanOrEqual(delay);
      await sql`UPDATE outgoing_mail.messages SET next_attempt_at = now() WHERE id = ${batch.ids[0]!}::uuid`;
    }
    expect((await deliverOne()).status).toBe("sent");
    expect(sink.messages).toHaveLength(1);
  });
  test("expired bulk retries settle in recovery with their last answer and no pacing slot", async () => {
    const batch = await enqueue();
    const id = batch.ids[0]!;
    await sql`UPDATE outgoing_mail.messages SET deadline_at = now() - INTERVAL '1 second', next_attempt_at = now() + INTERVAL '1 hour', error_message = '451 last answer', error_code = 'smtp_failed' WHERE id = ${id}::uuid`;
    expect(await dueOutgoingBulkProfiles()).not.toContain(profileId);
    await openGate();
    expect(await claimOutgoingBulkMail(profileId)).toBeUndefined();
    await enqueue([input, input]);
    const before = await sql`SELECT next_bulk_slot_at FROM outgoing_mail.profiles WHERE id = ${profileId}::uuid`;
    await recoverOutgoingMail();
    expect(await sql`SELECT next_bulk_slot_at FROM outgoing_mail.profiles WHERE id = ${profileId}::uuid`).toEqual(before);
    expect(await outgoingMailMessages.read(id)).toMatchObject({
      status: "failed",
      error_code: "smtp_failed",
      error_message: "451 last answer",
      next_attempt_at: null,
      attempt_count: 0,
    });
    expect(await sql`SELECT id FROM outgoing_mail.messages WHERE status = 'queued'`).toHaveLength(2);
    expect(sink.messages).toHaveLength(0);
  });
  test("only expired bulk rows need no continuation", async () => {
    await enqueue();
    await sql`UPDATE outgoing_mail.messages SET deadline_at = now() - INTERVAL '1 second'`;
    expect(await nextOutgoingBulkDelay(profileId)).toBeUndefined();
  });
  test("a due 451 retry is claimed before fresh mail accepted later", async () => {
    response = (command) => (command === "MESSAGE" ? "451 please retry" : undefined);
    const batch = await enqueue();
    expect((await deliverOne()).status).toBe("queued");
    await sql`UPDATE outgoing_mail.messages SET next_attempt_at = now() - INTERVAL '1 second' WHERE id = ${batch.ids[0]!}::uuid`;
    await enqueue(Array.from({ length: 5 }, () => input));
    await openGate();
    expect((await claimOutgoingBulkMail(profileId))?.row.id).toBe(batch.ids[0]);
  });
  test("profile deletion cancels queued and stale sending bulk mail and releases attachments", async () => {
    await outgoingMailStore.put(
      "bulk",
      {
        name: "Bulk",
        fromAddress: "bulk@example.org",
        fromName: null,
        smtpHost: sink.host,
        smtpPort: sink.port,
        smtpSecure: false,
        smtpUser: null,
        pacePerMinute: 60,
        dailyRecipientLimit: null,
        maxAttachmentBytes: 25 * 1024 * 1024,
      },
      context,
    );
    await outgoingMailStore.setAppAccess("inventory", { mode: "selected", profiles: ["bulk"] }, context);
    const message = {
      ...input,
      profile: "bulk",
      attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([42]) }],
    };
    const batch = await enqueue([message, message, message]);
    const refs = [];
    for (const id of batch.ids) refs.push(...messageAttachmentRefs((await outgoingMailMessages.read(id))!));
    await sql`UPDATE outgoing_mail.messages SET status = 'sending', updated_at = now() - INTERVAL '6 minutes' WHERE id = ${batch.ids[0]!}::uuid`;
    await outgoingMailStore.delete("bulk", context);
    await recoverOutgoingMail();
    for (const id of batch.ids)
      expect(await outgoingMailMessages.read(id)).toMatchObject({
        status: "cancelled",
        error_code: "profile_removed",
        error_message: "Outgoing mail profile was removed.",
        next_attempt_at: null,
        attachment_refs: null,
      });
    for (const ref of refs) expect(await mailAttachments().get(ref)).toBeNull();
    expect(sink.messages).toHaveLength(0);
  });
  test("a pacing slot starts after waiting for a profile share lock", async () => {
    // A 10-second slot keeps the follow-up claim independent of runner speed.
    await sql`UPDATE outgoing_mail.profiles SET pace_per_minute = 6 WHERE id = ${profileId}::uuid`;
    await enqueue([input, input]);
    await openGate();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Acceptance holds this share lock while it inserts a batch.
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM outgoing_mail.profiles WHERE id = ${profileId}::uuid FOR SHARE`;
      locked.resolve();
      await release.promise;
      const [held] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
      return held!.at;
    });
    await locked.promise;
    const pending = claimOutgoingBulkMail(profileId);
    let heldUntil: string;
    try {
      await Bun.sleep(1500);
    } finally {
      release.resolve();
      heldUntil = await holder;
    }
    const claim = await pending;
    expect(claim).toBeDefined();
    // Transaction-start time would grant the slot before the lock was released.
    expect(new Date(claim!.grantedAt).getTime()).toBeGreaterThanOrEqual(new Date(heldUntil).getTime());
    expect(new Date(claim!.slotAt).getTime() - new Date(claim!.grantedAt).getTime()).toBe(10_000);
    expect(await claimOutgoingBulkMail(profileId)).toBeUndefined();
  });
  test("1000 keyed messages use a constant number of advisory locks during acceptance", async () => {
    let done = false;
    let maximum = 0;
    let samples = 0;
    const poll = (async () => {
      while (!done) {
        // pg_locks is cluster-wide; count only this suite's fresh database.
        const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_locks
          WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        maximum = Math.max(maximum, row!.count);
        samples++;
        await Bun.sleep(1);
      }
    })();
    try {
      await enqueue(Array.from({ length: 1000 }, (_, index) => ({ ...input, key: `lock-${index}` })));
    } finally {
      done = true;
      await poll;
    }
    expect(samples).toBeGreaterThan(1);
    expect(maximum).toBeGreaterThan(0);
    expect(maximum).toBeLessThanOrEqual(10);
  }, 30_000);
  test("a keyed send and enqueue share one quota recipient and record", async () => {
    await sql`UPDATE outgoing_mail.profiles SET daily_recipient_limit = 1 WHERE id = ${profileId}::uuid`;
    const original = mailAttachments().put.bind(mailAttachments());
    const uploaded = Promise.withResolvers<void>();
    let uploads = 0;
    const put = spyOn(mailAttachments(), "put").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++uploads === 2) uploaded.resolve();
      await uploaded.promise;
      return result;
    });
    try {
      const message = { ...input, key: "same", attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([42]) }] };
      const [sent, batch] = await Promise.all([mail.send(message, { signal: AbortSignal.abort() }), mail.enqueue([message])]);
      if (!sent.ok) throw new Error(sent.error.message);
      if (!batch.ok) throw new Error(batch.error.message);
      expect(batch.data.ids).toEqual([sent.data.id]);
      expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(1);
    } finally {
      put.mockRestore();
    }
  });
  test("a registered app that drops mail:send is cancelled before SMTP", async () => {
    await enqueue();
    const apps = await registry.listApps();
    registered.mockResolvedValue(apps.map(({ platformPermissions: _, ...app }) => app));
    try {
      expect(await deliverOne()).toMatchObject({
        status: "cancelled",
        error_code: "profile_not_allowed",
        error_message: "The application no longer declares mail:send.",
      });
      expect(sink.messages).toHaveLength(0);
    } finally {
      registered.mockResolvedValue(apps);
    }
  });
  test("a temporarily unregistered app still delivers accepted mail", async () => {
    await enqueue();
    const apps = await registry.listApps();
    registered.mockResolvedValue([]);
    try {
      expect((await deliverOne()).status).toBe("sent");
      expect(sink.messages).toHaveLength(1);
    } finally {
      registered.mockResolvedValue(apps);
    }
  });
  test("a profile with only a 60-minute retry continues within the recovery interval", async () => {
    const batch = await enqueue();
    await sql`UPDATE outgoing_mail.messages SET next_attempt_at = now() + INTERVAL '1 hour' WHERE id = ${batch.ids[0]!}::uuid`;
    expect(await drainOutgoingMail(profileId)).toBe(MAIL_RECOVERY_MS);
    expect((await outgoingMailMessages.read(batch.ids[0]!))?.attempt_count).toBe(0);
    expect(sink.messages).toHaveLength(0);
  });
  test("whole-batch recipient quota is checked before upload and serializes concurrent enqueue and send", async () => {
    await sql`UPDATE outgoing_mail.profiles SET daily_recipient_limit = 2 WHERE id = ${profileId}::uuid`;
    let cancelled = false,
      pulls = 0;
    const content = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const put = spyOn(mailAttachments(), "put");
    try {
      expect(
        await mail.enqueue([
          { ...input, to: ["a@example.org", "b@example.org"], attachments: [{ filename: "a", contentType: "text/plain", content }] },
          input,
        ]),
      ).toMatchObject({ ok: false, error: { code: "quota_exceeded", limit: 2, used: 0, requested: 3 } });
      expect(put).not.toHaveBeenCalled();
      expect(cancelled).toBe(true);
      expect(pulls).toBe(0);
      expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(0);
    } finally {
      put.mockRestore();
    }
    const results = await Promise.all([mail.enqueue([input, input]), mail.send(input, { signal: AbortSignal.abort() })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: "quota_exceeded" } });
  });
  test("known keys reuse batch ID, cancel unread streams, and partial overlap preserves input order", async () => {
    const original = await enqueue([
      { ...input, key: "a" },
      { ...input, key: "b" },
    ]);
    let cancelled = 0,
      pulls = 0;
    const repeat = ["a", "b"].map((key) => ({
      ...input,
      key,
      attachments: [
        {
          filename: "unread",
          contentType: "text/plain",
          content: new ReadableStream<Uint8Array>(
            {
              pull() {
                pulls++;
              },
              cancel() {
                cancelled++;
              },
            },
            { highWaterMark: 0 },
          ),
        },
      ],
    }));
    expect(await enqueue(repeat)).toEqual(original);
    expect(cancelled).toBe(2);
    expect(pulls).toBe(0);
    const partial = await enqueue([
      { ...input, key: "c" },
      { ...input, key: "b" },
    ]);
    expect(partial.batchId).not.toBe(original.batchId);
    expect(partial.ids[1]).toBe(original.ids[1]);
    expect(await sql<{ id: string }[]>`SELECT id FROM outgoing_mail.messages WHERE batch_id = ${partial.batchId}::uuid`).toEqual([
      { id: partial.ids[0]! },
    ]);
    expect(await mail.list({ batchId: partial.batchId })).toMatchObject({ ok: true, data: { total: 1 } });
    const audits = await sql<{ metadata: unknown }[]>`SELECT metadata FROM audit.events WHERE action = 'outgoing_mail.send'`;
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain(input.to[0]!);
  });
  test("racing keys keep the first batch and delete losing uploads", async () => {
    const put = spyOn(mailAttachments(), "put");
    try {
      const make = () => [
        { ...input, key: "race", attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([42]) }] },
      ];
      const batches = await Promise.all([enqueue(make()), enqueue(make())]);
      expect(batches[0]).toEqual(batches[1]);
      expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(1);
      const row = (await outgoingMailMessages.read(batches[0]!.ids[0]!))!;
      for (const call of put.mock.calls) {
        const ref = {
          storeId: "cloud-outgoing-mail-attachments",
          tenantId: call[0].tenantId!,
          key: call[0].key,
          size: 1,
          digest: "unused",
        };
        const object = await mailAttachments().info({ tenantId: ref.tenantId, key: ref.key });
        if (ref.tenantId === row.id) expect(object).not.toBeNull();
        else expect(object).toBeNull();
      }
      expect(messageAttachmentRefs(row)).toHaveLength(1);
      expect((await deliverOne()).status).toBe("sent");
      expect(sink.messages).toHaveLength(1);
    } finally {
      put.mockRestore();
    }
  });
  test("backlog uses pace across applications and rejects the complete batch", async () => {
    await sql`UPDATE outgoing_mail.profiles SET pace_per_minute = 1 WHERE id = ${profileId}::uuid`;
    await enqueue(Array.from({ length: 1000 }, () => input));
    await enqueue(Array.from({ length: 439 }, () => input));
    const competing = mail.enqueue([input]);
    clearProcessApplicationId();
    bindProcessApplicationId("other", ["mail:send"]);
    const raced = await Promise.all([competing, mail.enqueue([input])]);
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
    expect(raced.find((result) => !result.ok)).toMatchObject({ error: { code: "backlog_full" } });
    expect(await mail.enqueue([input])).toMatchObject({ ok: false, error: { code: "backlog_full", status: 409 } });
    expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(1440);
    await sql`UPDATE outgoing_mail.profiles SET pace_per_minute = 2 WHERE id = ${profileId}::uuid`;
    expect((await mail.enqueue([input])).ok).toBe(true);
  });
  test("shutdown and stale sending recovery preserve every queued message and isolate lanes", async () => {
    const batch = await enqueue([input, input, input]);
    const heartbeat = mock(async () => {});
    await drainOutgoingMail(profileId, AbortSignal.abort(), heartbeat);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(await sql`SELECT id FROM outgoing_mail.messages WHERE status = 'queued'`).toHaveLength(3);
    await processOutgoingMail(batch.ids[0]!);
    expect(sink.messages).toHaveLength(0);
    const shutdown = new AbortController();
    response = (command) => {
      if (command === "DATA") shutdown.abort();
      return undefined;
    };
    await openGate();
    await drainOutgoingMail(profileId, shutdown.signal, heartbeat);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(
      await sql`SELECT id FROM outgoing_mail.messages WHERE attempt_count = 1 AND status = 'queued' AND next_attempt_at IS NOT NULL`,
    ).toHaveLength(1);
    expect(sink.messages).toHaveLength(0);
    response = undefined;
    await sql`UPDATE outgoing_mail.messages SET next_attempt_at = now() WHERE batch_id = ${batch.batchId}::uuid`;
    await openGate();
    const stale = await claimOutgoingBulkMail(profileId);
    expect(stale).toBeDefined();
    await sql`UPDATE outgoing_mail.messages SET updated_at = now() - INTERVAL '6 minutes' WHERE id = ${stale!.row.id}::uuid`;
    expect(await recoverOutgoingMail()).toEqual([]);
    expect(await dueOutgoingBulkProfiles()).toContain(profileId);
    for (let index = 0; index < 3; index++) expect((await deliverOne()).status).toBe("sent");
    expect(sink.messages).toHaveLength(3);
    const immediate = await mail.send(input, { signal: AbortSignal.abort() });
    if (!immediate.ok) throw new Error(immediate.error.message);
    await openGate();
    expect(await claimOutgoingBulkMail(profileId)).toBeUndefined();
    expect((await outgoingMailMessages.read(immediate.data.id))?.status).toBe("queued");
  });
  test("crossing the claim window during DATA finishes that attempt and heartbeats without claiming another row", async () => {
    const batch = await enqueue([input, input]);
    const started = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(started);
    const heartbeat = mock(async () => {});
    response = (command) => {
      if (command === "DATA") clock.mockReturnValue(started + MAIL_DRAIN_MS);
      return undefined;
    };
    try {
      await openGate();
      await drainOutgoingMail(profileId, undefined, heartbeat);
      expect(sink.messages).toHaveLength(1);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(await sql`SELECT id FROM outgoing_mail.messages WHERE batch_id = ${batch.batchId}::uuid AND status = 'sent'`).toHaveLength(1);
      expect(
        await sql`SELECT id FROM outgoing_mail.messages WHERE batch_id = ${batch.batchId}::uuid AND status = 'queued' AND attempt_count = 0`,
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
  test("batch API cancellation leaves sent and sending rows intact, cleans objects and audits once", async () => {
    const message = { ...input, attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([42]) }] };
    const batch = await enqueue([message, message, message]);
    const sent = await deliverOne();
    await openGate();
    const sending = await claimOutgoingBulkMail(profileId);
    const queued = (await outgoingMailMessages.read(batch.ids.find((id) => id !== sent.id && id !== sending!.row.id)!))!;
    const refs = messageAttachmentRefs(queued);
    const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
    const routes = createAdminOutgoingMailRoutes(async (c, next) => {
      c.set("user", user);
      await next();
    });
    const cancelled = await routes.request(`/batches/${batch.batchId}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ batchId: batch.batchId, cancelled: 1 });
    expect((await outgoingMailMessages.read(queued.id))?.error_code).toBe("cancelled_by_admin");
    expect((await outgoingMailMessages.read(sent.id))?.status).toBe("sent");
    expect((await outgoingMailMessages.read(sending!.row.id))?.status).toBe("sending");
    for (const ref of refs) expect(await mailAttachments().get(ref)).toBeNull();
    expect(await sql<{ metadata: unknown }[]>`SELECT metadata FROM audit.events WHERE action = 'outgoing_mail.batch.cancel'`).toEqual([
      { metadata: { appIds: ["inventory"], count: 1 } },
    ]);
    await attemptOutgoingMail(sending!.row);
    expect(sink.messages).toHaveLength(2);
    expect(await outgoingMailLog.cancelBatch(batch.batchId, context)).toEqual({ batchId: batch.batchId, cancelled: 0 });
    expect((await routes.request(`/batches/${crypto.randomUUID()}/cancel`, { method: "POST" })).status).toBe(404);
    expect((await routes.request("/batches/not-a-uuid/cancel", { method: "POST" })).status).toBe(400);
  });
  test("permanent 5xx records its SMTP answer and revoked access cancels before SMTP", async () => {
    response = (command) => (command === "MESSAGE" ? "550 permanent rejection" : undefined);
    await enqueue();
    expect(await deliverOne()).toMatchObject({ status: "failed", error_message: expect.stringContaining("550 permanent rejection") });
    await enqueue();
    await outgoingMailStore.setAppAccess("inventory", { mode: "selected", profiles: [] }, context);
    expect(await deliverOne()).toMatchObject({ status: "cancelled", error_code: "profile_not_allowed" });
    expect(sink.messages).toHaveLength(0);
  });
  test("acceptance audit failure rolls back all messages and removes all uploaded objects", async () => {
    const put = spyOn(mailAttachments(), "put");
    const record = spyOn(audit, "record").mockRejectedValue(new Error("Audit unavailable"));
    try {
      const message = { ...input, attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([42]) }] };
      expect(await mail.enqueue([message, message])).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
      expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(0);
      for (const call of put.mock.calls) expect(await mailAttachments().info({ tenantId: call[0].tenantId!, key: call[0].key })).toBeNull();
    } finally {
      record.mockRestore();
      put.mockRestore();
    }
  });
  test("unknown acceptance returns an audited Result, retains uploaded objects, and safely retries the same keys", async () => {
    const original = sql.begin.bind(sql);
    let commitResponseLost = false;
    const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
      if (typeof run !== "function") throw new Error("Expected transaction callback");
      if (commitResponseLost) throw new Error("Recovery storage unavailable");
      const result: unknown = await original(run);
      if (result && typeof result === "object" && "created" in result) {
        commitResponseLost = true;
        throw new Error("Commit response lost");
      }
      return result;
    });
    const message = {
      ...input,
      key: "unknown-commit",
      attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([42]) }],
    };
    try {
      expect(await mail.enqueue([message])).toMatchObject({
        ok: false,
        error: { code: "mail_unavailable", message: expect.stringContaining("Retry with the same keys") },
      });
      const [row] = await sql<
        { id: string; batch_id: string }[]
      >`SELECT id, batch_id FROM outgoing_mail.messages WHERE app_id = 'inventory' AND idempotency_key = ${message.key}`;
      expect(row).toBeDefined();
      const refs = messageAttachmentRefs((await outgoingMailMessages.read(row!.id))!);
      expect(refs).toHaveLength(1);
      for (const ref of refs) expect(await mailAttachments().info({ tenantId: ref.tenantId, key: ref.key })).not.toBeNull();
      expect(
        await sql<{ outcome: string }[]>`SELECT outcome FROM audit.events WHERE action = 'outgoing_mail.send' ORDER BY outcome`,
      ).toEqual([{ outcome: "allowed" }, { outcome: "denied" }]);
      begin.mockRestore();
      expect(await enqueue([message])).toEqual({ batchId: row!.batch_id, ids: [row!.id] });
      expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(1);
    } finally {
      begin.mockRestore();
    }
  });
  test("Core recovers due bulk rows and runs the coalesced drain worker", async () => {
    await sql`UPDATE outgoing_mail.profiles SET pace_per_minute = 6000 WHERE id = ${profileId}::uuid`;
    const batch = await enqueue([input, input, input]);
    await startOutgoingMailRuntime();
    const deadline = Date.now() + 5000;
    // Rows accepted in the same millisecond have no defined order, so wait for the whole batch.
    const sent = async () =>
      (
        await sql<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM outgoing_mail.messages WHERE batch_id = ${batch.batchId}::uuid AND status = 'sent'`
      )[0]!.count;
    while (Date.now() < deadline && (await sent()) < 3) await Bun.sleep(20);
    expect(await sql`SELECT id FROM outgoing_mail.messages WHERE batch_id = ${batch.batchId}::uuid AND status = 'sent'`).toHaveLength(3);
    expect(sink.messages).toHaveLength(3);
  }, 10_000);
  test("a lost COMMIT response recovers the whole accepted batch and preserves its objects and audit", async () => {
    const original = sql.begin.bind(sql);
    const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
      if (typeof run !== "function") throw new Error("Expected transaction callback");
      const result: unknown = await original(run);
      if (result && typeof result === "object" && "created" in result) throw new Error("Commit response lost");
      return result;
    });
    try {
      const message = { ...input, attachments: [{ filename: "a", contentType: "text/plain", content: new Uint8Array([42]) }] };
      const batch = await enqueue([message, message]);
      expect(await sql`SELECT id FROM outgoing_mail.messages WHERE batch_id = ${batch.batchId}::uuid`).toHaveLength(2);
      expect(await sql`SELECT id FROM audit.events WHERE action = 'outgoing_mail.send'`).toHaveLength(1);
      for (const id of batch.ids) {
        const row = (await outgoingMailMessages.read(id))!;
        expect(await mailAttachments().get(messageAttachmentRefs(row)[0]!)).not.toBeNull();
      }
    } finally {
      begin.mockRestore();
    }
  });
});
