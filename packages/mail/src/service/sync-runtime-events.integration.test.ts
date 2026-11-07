import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import type { AppEventEnvelope } from "@k2b/cloud/events";
import { appEventFixture, createAppEventTestHarness, deliverAppEvent } from "@k2b/cloud/events/testing";
import { accounts } from "@k2b/cloud/services";
import { createAppEventBroker } from "@k2b/cloud/services/app-events";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { ConnectorEnvelope } from "./connectors";
import { ingestEnvelope } from "./sync-runtime";

const suite = suiteFor("database", "nats");

suite("Mail receipt events at the sync and event-service seams", () => {
  let mailboxId: string;
  let mailboxShortId: string;
  let remoteResourceId: string;
  const folders = new Map<string, string>();

  beforeAll(async () => {
    await migrate();
    createAppEventTestHarness("mail", mailCapabilities);
    const [mailbox] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.mailboxes (short_id, name) VALUES (${newShortId()}, 'Receipt event fixture') RETURNING id, short_id
    `;
    if (!mailbox) throw new Error("Mailbox fixture missing");
    mailboxId = mailbox.id;
    mailboxShortId = mailbox.short_id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"e".repeat(64)}) RETURNING id
    `;
    if (!resource) throw new Error("Resource fixture missing");
    remoteResourceId = resource.id;
    for (const role of ["inbox", "all", "archive", "trash", "junk", "sent"]) {
      const [folder] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${newShortId()}, ${remoteResourceId}::uuid, ${role}, ${role}, ${role}, 'current') RETURNING id
      `;
      if (!folder) throw new Error("Folder fixture missing");
      folders.set(role, folder.id);
    }
    await sql`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, from_address, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Own sender', 'own@example.test', 'verified')
    `;
    // The Mail integration preload owns and drops this entire disposable database.
  });

  const envelope = (uid: number, from = "sender@example.test"): ConnectorEnvelope => ({
    remoteRef: { folderStableKey: "fixture", uidValidity: "1", uid: String(uid), modseq: "1" },
    providerMessageId: `receipt-${uid}`,
    providerThreadId: null,
    messageId: `<receipt-${uid}@example.test>`,
    inReplyTo: null,
    references: [],
    subject: `Private subject ${uid}`,
    sentAt: new Date("2026-11-01T12:00:00Z"),
    internalDate: new Date("2026-11-01T12:00:00Z"),
    sizeBytes: 100,
    flags: [],
    labels: [],
    addresses: {
      from: [{ name: "Private sender", address: from }],
      to: [{ name: null, address: "own@example.test" }],
      cc: [],
      bcc: [],
      replyTo: [],
    },
    mimeStructure: { type: "text/plain", part: "1" },
  });
  const folderId = (role: string): string => {
    const id = folders.get(role);
    if (!id) throw new Error(`Missing ${role} folder`);
    return id;
  };
  const ingest = (message: ConnectorEnvelope, role = "inbox", captureWorkflowTriggers = true) =>
    sql.begin((tx) => ingestEnvelope({ db: tx, mailboxId, remoteResourceId, folderId: folderId(role), message, captureWorkflowTriggers }));
  const pending = async (messageId: string): Promise<AppEventEnvelope[]> => {
    const [message] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.message_contents WHERE id = ${messageId}::uuid`;
    if (!message) throw new Error("Message fixture missing");
    return (
      await sql<{ payload: AppEventEnvelope }[]>`
      SELECT payload FROM events.outbox WHERE app_id = 'mail' AND kind = 'event'
        AND payload->'subject'->>'id' = ${message.short_id} ORDER BY seq
    `
    ).map((row) => row.payload);
  };

  test("historical selection excludes unsuitable copies and source resolution requires current mailbox read access", async () => {
    const incoming = await ingest(envelope(700), "inbox", false);
    await ingest(envelope(700), "archive", false);
    const excluded = await Promise.all([
      ingest(envelope(701), "junk", false),
      ingest(envelope(702, "own@example.test"), "inbox", false),
      ingest(envelope(703), "all", false),
      ingest(envelope(704), "sent", false),
    ]);
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
      VALUES(${`mail-code-${crypto.randomUUID()}`},'local','user',false) RETURNING id`;
    const user = await accounts.users.get({ id: person!.id });
    if (!user) throw new Error("Missing historical Mail reader");
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission)
      VALUES(${user.id}::uuid,'read') RETURNING id`;
    if (!grant) throw new Error("Missing historical mailbox grant");
    await sql`INSERT INTO mail.mailbox_access(mailbox_id,access_id) VALUES(${mailboxId}::uuid,${grant.id}::uuid)`;
    const context: CapabilityExecutionContext = {
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: user.id },
      user,
      locale: "en",
      requestId: "mail-code-history",
      origin: "app",
      signal: new AbortController().signal,
      target: { type: "mail.mailbox", id: mailboxShortId },
    };
    const selected = await mailCapabilities.queries["message.catchup"].run({ cutoffAt: "9999-01-01T00:00:00Z" }, context);
    if (!selected.ok) throw new Error(`Historical selection refused: ${selected.error.code}: ${selected.error.message}`);
    const [message] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.message_contents WHERE id=${incoming}::uuid`;
    const excludedRows = await sql<
      { short_id: string }[]
    >`SELECT short_id FROM mail.message_contents WHERE id=ANY(${`{${excluded.join(",")}}`}::uuid[])`;
    const ids = selected.data.data.items.map((item) => item.event.subject.id);
    expect(ids.filter((id) => id === message!.short_id)).toHaveLength(1);
    for (const row of excludedRows) expect(ids).not.toContain(row.short_id);
    const resolved = await mailCapabilities.queries["message.event"].run({ id: message!.short_id }, context);
    expect(resolved).toMatchObject({ ok: true, data: { data: { subject: { id: message!.short_id }, place: { id: mailboxShortId } } } });
    const outside = await mailCapabilities.queries["message.catchup"].run({ from: "2027-01-01T00:00:00Z" }, context);
    expect(outside).toMatchObject({ ok: true, data: { data: { items: [], nextCursor: null } } });
    // Administrator status is not mailbox read access. Exercise revocation of the actual grant.
    await sql`DELETE FROM mail.mailbox_access WHERE mailbox_id=${mailboxId}::uuid AND access_id=${grant.id}::uuid`;
    const denied = await mailCapabilities.queries["message.event"].run({ id: message!.short_id }, context);
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  test("one receipt survives sync retry, labels and moves with public refs and the original placement identity", async () => {
    const message = envelope(1);
    const id = await ingest(message);
    expect(await ingest(message)).toBe(id);
    expect(await ingest({ ...message, labels: ["Later"] }, "archive")).toBe(id);
    const events = await pending(id);
    expect(events).toHaveLength(1);
    const [event] = events;
    const [stored] = await sql<{ short_id: string; receipt_id: string }[]>`
      SELECT message.short_id, ref.id AS receipt_id FROM mail.message_contents message
      JOIN mail.remote_message_refs ref ON ref.message_id = message.id
      WHERE message.id = ${id}::uuid AND ref.folder_id = ${folderId("inbox")}::uuid
    `;
    expect(event).toMatchObject({
      type: "mail.message.received",
      version: 1,
      source: "mail",
      subject: { type: "mail.message", id: stored!.short_id },
      place: { type: "mail.mailbox", id: mailboxShortId },
      data: { receiptId: stored!.receipt_id },
    });
    expect(event!.data).toEqual({ receiptId: stored!.receipt_id });
    expect(JSON.stringify(event)).not.toContain("Private");
    await expect(deliverAppEvent(mailCapabilities, event!.type, event!)).rejects.toThrow("resource_events_unsupported");

    // Core validates the real Mail declaration and deduplicates broker redelivery by event ID.
    const broker = createAppEventBroker({
      db: sql,
      registry: async () => [
        {
          appId: "mail",
          appName: "Mail",
          appDescription: "Mail",
          appIcon: "mail",
          endpoint: "http://mail.test",
          manifest: compileCapabilityManifest("mail", mailCapabilities),
        },
      ],
    });
    await broker.accept(event, 1);
    await broker.accept(event, 2);
    expect(
      await sql<{ state: string; code: string | null }[]>`SELECT state, code FROM events.app_events WHERE id = ${event!.id}::uuid`,
    ).toEqual([{ state: "accepted", code: null }]);
    const fixture = appEventFixture(mailCapabilities, "message.received", {
      subject: "Msg123",
      place: "Box123",
      data: { receiptId: stored!.receipt_id },
    });
    const [size] = await sql<{ bytes: number }[]>`SELECT octet_length(${JSON.stringify(fixture)}::text::jsonb::text) AS bytes`;
    expect(size?.bytes).toBe(314);
  });

  test("All Mail waits for the first non-All-Mail copy and never receives later copies again", async () => {
    const message = envelope(2);
    const id = await ingest(message, "all");
    expect(await pending(id)).toEqual([]);
    await ingest(message, "all");
    expect(await pending(id)).toEqual([]);
    await ingest(message, "inbox");
    await ingest(message, "archive");
    expect(await pending(id)).toHaveLength(1);
    const [ref] = await sql<{ id: string }[]>`
      SELECT id FROM mail.remote_message_refs WHERE message_id = ${id}::uuid AND folder_id = ${folderId("inbox")}::uuid
    `;
    expect((await pending(id))[0]!.data).toEqual({ receiptId: ref!.id });
  });

  test("concurrent copies claim one pending receipt", async () => {
    const message = envelope(3);
    const id = await ingest(message, "all");
    await Promise.all([ingest(message, "inbox"), ingest(message, "archive")]);
    expect(await pending(id)).toHaveLength(1);
  });

  for (const role of ["trash", "junk"]) {
    test(`${role} never emits a receipt, including an All Mail pending copy and later restoration`, async () => {
      for (const firstInAll of [false, true]) {
        const message = envelope((role === "trash" ? 10 : 20) + Number(firstInAll));
        const id = await ingest(message, firstInAll ? "all" : role);
        await ingest(message, role);
        await ingest(message, "inbox");
        expect(await pending(id)).toEqual([]);
      }
    });
  }

  test("outbound and self-sender messages do not receive, including when first seen in All Mail", async () => {
    for (const [uid, role] of [
      [30, "sent"],
      [31, "inbox"],
      [32, "all"],
    ] as const) {
      const message = envelope(uid, "OWN@example.test");
      const id = await ingest(message, role);
      await ingest(message, "inbox");
      expect(await pending(id)).toEqual([]);
    }
  });

  test("provider backfill/reconcile imports never become new receipts on retry or a later placement", async () => {
    for (const [uid, role] of [
      [40, "inbox"],
      [41, "all"],
    ] as const) {
      const message = envelope(uid);
      const id = await ingest(message, role, false);
      await ingest(message, role, true);
      await ingest(message, "archive", true);
      expect(await pending(id)).toEqual([]);
    }
    // A pending incremental receipt consumed by a non-triggering import stays consumed.
    const message = envelope(42);
    const id = await ingest(message, "all");
    await ingest(message, "inbox", false);
    await ingest(message, "archive", true);
    expect(await pending(id)).toEqual([]);
  });

  test("domain rollback rolls back publication and the receipt claim; retry publishes once", async () => {
    const message = envelope(50);
    const id = await ingest(message, "all");
    await expect(
      sql.begin(async (tx) => {
        await ingestEnvelope({ db: tx, mailboxId, remoteResourceId, folderId: folderId("inbox"), message, captureWorkflowTriggers: true });
        throw new Error("receipt rollback");
      }),
    ).rejects.toThrow("receipt rollback");
    expect(await pending(id)).toEqual([]);
    expect(await sql<{ receipt_pending: boolean }[]>`SELECT receipt_pending FROM mail.message_contents WHERE id = ${id}::uuid`).toEqual([
      { receipt_pending: true },
    ]);
    await ingest(message);
    await ingest(message);
    expect(await pending(id)).toHaveLength(1);
  });
});
