import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createSync, type Sync } from "@k2b/sync";
import { sql } from "bun";
import { smtpSink } from "../../../../../scripts/fixtures/smtp-sink";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { deleteTestNamespace } from "../../../../../scripts/fixtures/test-sync";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate as migrateNotifications } from "../../../../core/src/migrate/core/notifications";
import { migrate as migrateMail } from "../../../../core/src/migrate/core/outgoing-mail";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import * as registry from "../../_internal/registry";
import { processOutgoingMail } from "../outgoing-mail/dispatcher";
import { drainOutgoingMail } from "../outgoing-mail/drain";
import { outgoingMailMessages } from "../outgoing-mail/messages";
import { outgoingMailStore } from "../outgoing-mail/store";
import { encryptSecret } from "../secrets";
import * as settings from "../settings";
import { coreSettings } from "../settings/api";
import { __notificationBatchTest, retryRecipient } from "./batches";
import { processNotificationDelivery } from "./dispatcher";
import { prepareNotificationEmail } from "./email-frame";
import { notificationObservability } from "./observability";

suiteFor("database", "nats")("notification email through outgoing mail", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: Sync;
  let namespace: string;
  let sink: ReturnType<typeof smtpSink>;
  let temporaryFailure = false;
  let profileId: string;
  let userId: string;
  let registered: ReturnType<typeof spyOn<typeof registry, "listApps">>;
  let read: ReturnType<typeof spyOn<typeof settings, "get">>;
  let logo: ReturnType<typeof spyOn<typeof coreSettings, "get">>;
  const stoppedWait = AbortSignal.abort();
  beforeAll(async () => {
    fresh = await useFreshDatabase("notification_email");
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), uid TEXT, display_name TEXT, mail TEXT)`.simple();
    await migrateMail();
    await migrateAudit();
    await migrateNotifications();
    await migrateNotifications(); // Nullable mail IDs are an idempotent migration.
    connection = await connectTestNats({ ignoreClusterUpdates: true });
    namespace = testSyncNamespace("notification-email");
    sync = createSync({ connection, namespace, application: "core", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    await sync.ready();
    registered = spyOn(registry, "listApps").mockResolvedValue([
      {
        id: "core",
        name: "Core",
        icon: "mail",
        description: "Core",
        routes: [],
        baseUrl: "http://test",
        platformPermissions: ["mail:send"],
      },
    ]);
    read = spyOn(settings, "get").mockResolvedValue("Cloud");
    logo = spyOn(coreSettings, "get").mockResolvedValue("https://example.test/logo.svg");
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid, display_name, mail) VALUES ('operator', 'Operator', 'operator@example.org') RETURNING id`;
    if (!user) throw new Error("Missing operator fixture");
    userId = user.id;
  });
  beforeEach(async () => {
    temporaryFailure = false;
    await sql`TRUNCATE notifications.definitions, notifications.messages, notifications.batches, outgoing_mail.messages, outgoing_mail.profiles CASCADE`;
    sink = smtpSink({ reply: (command) => (temporaryFailure && command === "MESSAGE" ? "451 Try again" : undefined) });
    const result = await outgoingMailStore.put(
      "default",
      {
        name: "Default",
        fromAddress: "sender@example.org",
        fromName: "Cloud",
        smtpHost: sink.host,
        smtpPort: sink.port,
        smtpSecure: false,
        smtpUser: null,
        pacePerMinute: 6000,
        dailyRecipientLimit: null,
        maxAttachmentBytes: 1024,
      },
      { actor: { uid: "operator" } },
    );
    // The first profile becomes default; this assertion also checks test setup.
    profileId = (await sql<{ id: string }[]>`SELECT id FROM outgoing_mail.profiles WHERE key = ${result.profile.key}`)[0]!.id;
  });
  afterEach(() => sink?.stop());
  afterAll(async () => {
    registered?.mockRestore();
    read?.mockRestore();
    logo?.mockRestore();
    unbindProcessSync();
    await sync?.drain();
    if (namespace) await deleteTestNamespace(namespace);
    await connection?.drain();
    await sql.close();
    await fresh?.drop();
  });
  const delivery = async () => {
    const definition = `core.fixture-${crypto.randomUUID()}`;
    await sql`INSERT INTO notifications.definitions(id, app_id, kind, label, description, recipient_kind) VALUES (${definition}, 'core', ${definition}, 'Fixture', 'Fixture', 'email')`;
    const [event] = await sql<
      { id: string }[]
    >`INSERT INTO notifications.events(definition_id, recipient_email, recipient_key, idempotency_key, title)
      VALUES (${definition}, 'reader@example.org', 'reader', ${crypto.randomUUID()}, 'Notification subject') RETURNING id`;
    if (!event) throw new Error("Missing event fixture");
    const payload = await encryptSecret({
      to: "reader@example.org",
      subject: "Notification subject",
      rawHtml: "<p>Hello <strong>reader</strong></p>",
    });
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO notifications.deliveries(event_id, channel, destination_key, destination_label, payload_encrypted, required, status)
      VALUES (${event.id}::uuid, 'email', 'reader', 'r***@example.org', ${payload}, true, 'pending') RETURNING id`;
    if (!row) throw new Error("Missing delivery fixture");
    return row.id;
  };
  const poll = async (id: string) => {
    await sql`UPDATE notifications.deliveries SET next_attempt_at = now() WHERE id = ${id}::uuid`;
    return processNotificationDelivery(id, stoppedWait);
  };
  const mailIdFor = async (id: string) => {
    const [row] = await sql<{ outgoing_mail_id: string }[]>`SELECT outgoing_mail_id FROM notifications.deliveries WHERE id = ${id}::uuid`;
    if (!row?.outgoing_mail_id) throw new Error("Missing outgoing mail id");
    return row.outgoing_mail_id;
  };
  test("delivery preserves frame/subject, logs Core, and never resends on re-run or interrupted notification lease", async () => {
    const id = await delivery();
    expect(await poll(id)).toMatchObject({ status: "pending" });
    const mailId = await mailIdFor(id);
    const frame = await prepareNotificationEmail({ rawHtml: "<p>Hello <strong>reader</strong></p>" });
    expect(await outgoingMailMessages.read(mailId)).toMatchObject({
      app_id: "core",
      html_body: frame.html,
      subject: "Notification subject",
    });
    await processOutgoingMail(mailId);
    expect(await poll(id)).toMatchObject({ status: "delivered" });
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]!.raw).toContain("Subject: Notification subject");
    const raw = sink.messages[0]!.raw;
    const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
    // Quoted-printable soft breaks can start a line with "--"; only the real boundary ends the part.
    const htmlPart = raw
      .split(/Content-Type: text\/html[^\r]*\r\n/i)[1]
      ?.split(`\r\n--${boundary}`)[0]
      ?.split("\r\n\r\n")
      .slice(1)
      .join("\r\n\r\n");
    const decoded = htmlPart
      ?.replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\r\n/g, "\n")
      .trim();
    expect(decoded).toBe(frame.html.trim());
    expect(await poll(id)).toEqual({ status: "skipped" });
    // Simulate a crash after SMTP acceptance, before notification settlement.
    const payload = await encryptSecret({ to: "reader@example.org", subject: "Notification subject", content: "Hello" });
    await sql`UPDATE notifications.deliveries SET status = 'pending', outgoing_mail_id = NULL, payload_encrypted = ${payload}, delivered_at = NULL WHERE id = ${id}::uuid`;
    expect(await poll(id)).toMatchObject({ status: "delivered" });
    expect(sink.messages).toHaveLength(1);
    expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(1);
    await sql`UPDATE outgoing_mail.messages SET status = 'bounced' WHERE id = ${mailId}::uuid`;
    expect((await notificationObservability.deliveries.list({})).items[0]).toMatchObject({
      outgoingMailId: mailId,
      outgoingMailStatus: "bounced",
    });
    await sql`DELETE FROM outgoing_mail.messages WHERE id = ${mailId}::uuid`;
    expect((await notificationObservability.deliveries.list({})).items[0]).toMatchObject({
      outgoingMailId: mailId,
      outgoingMailStatus: null,
    });
  });
  test("451 leaves notification pending with no spent attempts, then 250 delivers the same mail", async () => {
    temporaryFailure = true;
    const id = await delivery();
    expect(await poll(id)).toMatchObject({ status: "pending" });
    const mailId = await mailIdFor(id);
    await processOutgoingMail(mailId);
    expect(await poll(id)).toMatchObject({ status: "pending" });
    const [waiting] =
      await sql`SELECT status, attempt_count, error_code, error_message FROM notifications.deliveries WHERE id = ${id}::uuid`;
    expect(waiting).toMatchObject({ status: "pending", attempt_count: 0, error_code: null });
    expect(waiting.error_message).toContain("451");
    temporaryFailure = false;
    // Use the existing due-time seam, avoiding the production minute backoff.
    await sql`UPDATE outgoing_mail.messages SET next_attempt_at = now() WHERE id = ${mailId}::uuid`;
    await processOutgoingMail(mailId);
    expect(await poll(id)).toMatchObject({ status: "delivered" });
    expect(await mailIdFor(id)).toBe(mailId);
    expect(sink.messages).toHaveLength(1);
    expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(1);
  });
  test("delivery recovery never sends again when its accepted mail record has expired", async () => {
    const id = await delivery();
    expect(await poll(id)).toMatchObject({ status: "pending" });
    const mailId = await mailIdFor(id);
    await sql`DELETE FROM outgoing_mail.messages WHERE id = ${mailId}::uuid`;
    expect(await poll(id)).toMatchObject({ status: "failed" });
    expect((await sql`SELECT outgoing_mail_id, error_message FROM notifications.deliveries WHERE id = ${id}::uuid`)[0]).toEqual({
      outgoing_mail_id: mailId,
      error_message: "Outgoing mail record is no longer available.",
    });
    expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(0);
    expect(sink.messages).toHaveLength(0);
  });

  const batch = async () => {
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO notifications.batches(subject, body_markdown, body_html, selection, selection_hash, status)
      VALUES ('Batch subject', 'Hello', '<p>Hello</p>', '{}', 'fixture', 'ready') RETURNING id`;
    if (!row) throw new Error("Missing batch fixture");
    await sql`INSERT INTO notifications.batch_recipients(batch_id, user_id, recipient, uid, provider, profile)
      VALUES (${row.id}::uuid, ${userId}::uuid, 'reader@example.org', 'reader', 'local', 'user')`;
    return row.id;
  };
  test("bulk batch reconciles counters/history, keeps queued mail on stale reclaim, and retries in a new generation", async () => {
    const id = await batch();
    expect(await __notificationBatchTest.processBatchChunk(id)).toEqual({ processed: 1, remaining: 1 });
    const [accepted] = await sql`SELECT * FROM outgoing_mail.messages`;
    expect(accepted).toMatchObject({ lane: "bulk", app_id: "core", status: "queued" });
    await sql`UPDATE notifications.batch_recipients SET updated_at = now() - INTERVAL '6 minutes' WHERE batch_id = ${id}::uuid`;
    expect(await __notificationBatchTest.processBatchChunk(id)).toEqual({ processed: 0, remaining: 1 });
    expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(1);
    // Acceptance committed but its recipient link was lost before a restart.
    await sql`UPDATE notifications.batch_recipients SET outgoing_mail_id = NULL, updated_at = now() - INTERVAL '6 minutes'
      WHERE batch_id = ${id}::uuid`;
    expect(await __notificationBatchTest.processBatchChunk(id)).toEqual({ processed: 1, remaining: 1 });
    expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(1);
    expect((await sql`SELECT outgoing_mail_id FROM notifications.batch_recipients WHERE batch_id = ${id}::uuid`)[0]?.outgoing_mail_id).toBe(
      accepted.id,
    );
    await drainOutgoingMail(profileId);
    expect(await __notificationBatchTest.processBatchChunk(id)).toEqual({ processed: 1, remaining: 0 });
    expect((await sql`SELECT status, sent_count, error_count FROM notifications.batches WHERE id = ${id}::uuid`)[0]).toEqual({
      status: "completed",
      sent_count: 1,
      error_count: 0,
    });
    expect((await sql`SELECT sent_at, error FROM notifications.messages`)[0]).toMatchObject({ sent_at: expect.any(Date), error: null });
    // Force a terminal error and exercise the real operator retry generation.
    await sql`UPDATE notifications.batch_recipients SET status = 'error', error = 'Fixture failure' WHERE batch_id = ${id}::uuid`;
    expect(await retryRecipient({ id, userId, actor: { userId } })).toMatchObject({ ok: true });
    await __notificationBatchTest.processBatchChunk(id);
    const mails = await sql<{ idempotency_key: string }[]>`SELECT idempotency_key FROM outgoing_mail.messages`;
    expect(mails).toHaveLength(2);
    expect(new Set(mails.map((mail) => mail.idempotency_key)).size).toBe(2);
    await sql`UPDATE outgoing_mail.profiles SET next_bulk_slot_at = now() WHERE id = ${profileId}::uuid`;
    await drainOutgoingMail(profileId);
    await __notificationBatchTest.processBatchChunk(id);
    expect(sink.messages).toHaveLength(2);
    expect((await sql`SELECT status, sent_count FROM notifications.batches WHERE id = ${id}::uuid`)[0]).toEqual({
      status: "completed",
      sent_count: 1,
    });
  });
  test("batch reconciliation terminates with a clear error when retention removed its mail record", async () => {
    const id = await batch();
    await __notificationBatchTest.processBatchChunk(id);
    await sql`DELETE FROM outgoing_mail.messages`;
    expect(await __notificationBatchTest.processBatchChunk(id)).toEqual({ processed: 1, remaining: 0 });
    expect((await sql`SELECT status, sent_count, error_count FROM notifications.batches WHERE id = ${id}::uuid`)[0]).toEqual({
      status: "completed_with_errors",
      sent_count: 0,
      error_count: 1,
    });
    expect((await sql`SELECT error FROM notifications.messages`)[0]?.error).toBe("Outgoing mail record is no longer available.");
    expect(await sql`SELECT id FROM outgoing_mail.messages`).toHaveLength(0);
    expect(sink.messages).toHaveLength(0);
  });
});
