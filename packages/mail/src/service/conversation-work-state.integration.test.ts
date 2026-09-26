import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { releaseDueSnoozes } from "./collaboration";
import type { ConnectorEnvelope, ConnectorProtocolFacts } from "./connectors";
import { createMailbox } from "./mailboxes";
import { createBlobReadable } from "./message-blobs";
import { hydrateMessageFromSource } from "./message-hydration";
import { EMPTY_MESSAGE_PROTOCOL_FACTS } from "./message-protocol";
import { ingestEnvelope } from "./sync-runtime";

const suite = suiteFor("database", "nats");

const protocolFacts = (autoSubmitted: string | null): ConnectorProtocolFacts => ({
  ...EMPTY_MESSAGE_PROTOCOL_FACTS,
  returnPath: "<support@example.test>",
  autoSubmitted,
  contentType: "text/plain; charset=utf-8",
});

suite("mail conversation work-state projection", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  const userIds: string[] = [];
  const accessIds: string[] = [];
  const sourceBlobIds: string[] = [];
  let mailboxId = "";
  let remoteResourceId = "";
  let folderId = "";
  let senderIdentityId = "";
  let context: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const uid = `mail-work-state-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Mail work-state test', false)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create Mail work-state test user");
    userIds.push(user.id);
    context = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid,
          provider: "local",
          profile: "user",
          displayName: "Mail work-state test",
          givenName: "Mail",
          sn: "Test",
          mail: `${uid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `mail-work-state-${suffix}`,
    };

    const mailbox = await createMailbox(context, { name: `Work state ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    mailboxIds.push(mailboxId);
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"c".repeat(64)}, 'active')
      RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`work-state-${suffix}`}, 'Inbox', 'inbox', 'current')
      RETURNING id
    `;
    remoteResourceId = resource!.id;
    folderId = folder!.id;
    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, is_default, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Support', 'Support', 'support@example.test', true, 'verified')
      RETURNING id
    `;
    senderIdentityId = identity!.id;
  });

  afterAll(async () => {
    for (const id of mailboxIds) {
      const rows = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
      accessIds.push(...rows.map((row) => row.access_id));
      const sourceRows = await sql<{ source_blob_id: string }[]>`
        SELECT source_blob_id
        FROM mail.message_contents
        WHERE mailbox_id = ${id}::uuid
          AND source_blob_id IS NOT NULL
      `;
      sourceBlobIds.push(...sourceRows.map((row) => row.source_blob_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
    }
    if (sourceBlobIds.length > 0) {
      await sql`
        DELETE FROM mail.message_part_blobs
        WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sourceBlobIds}::jsonb))
      `;
    }
    if (accessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  const envelope = (params: {
    uid: number;
    messageId: string;
    inReplyTo: string | null;
    from: string;
    to: string;
    date: Date;
    autoSubmitted?: string | null;
  }): ConnectorEnvelope => ({
    remoteRef: { folderStableKey: `work-state-${suffix}`, uidValidity: "1", uid: String(params.uid), modseq: null },
    providerMessageId: null,
    providerThreadId: null,
    messageId: params.messageId,
    inReplyTo: params.inReplyTo,
    references: params.inReplyTo ? [params.inReplyTo] : [],
    protocolFacts: protocolFacts(params.autoSubmitted ?? null),
    subject: params.inReplyTo ? "Re: Work-state projection" : "Work-state projection",
    sentAt: params.date,
    internalDate: params.date,
    sizeBytes: 256,
    flags: [],
    labels: [],
    addresses: {
      from: [{ name: null, address: params.from }],
      replyTo: [],
      to: [{ name: null, address: params.to }],
      cc: [],
      bcc: [],
    },
    mimeStructure: {},
  });

  const hydrate = async (messageId: string, source: readonly string[]) => {
    const body = Buffer.from([...source, "Content-Type: text/plain; charset=utf-8", "", "Work-state test body"].join("\r\n"));
    await hydrateMessageFromSource({
      messageId,
      source: Readable.from([body]),
      expectedSize: body.byteLength,
    });
    return body;
  };

  test("projects verified inbound, automatic, and human replies deterministically", async () => {
    const initialMessageId = `<work-state-inbound-${suffix}@example.test>`;
    const initial = envelope({
      uid: 1,
      messageId: initialMessageId,
      inReplyTo: null,
      from: "customer@example.test",
      to: "support@example.test",
      date: new Date("2026-07-22T08:00:00.000Z"),
    });
    const initialId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: initial });
    const initialSource = await hydrate(initialId, [
      `Message-ID: ${initialMessageId}`,
      "From: Customer <customer@example.test>",
      "To: Support <support@example.test>",
      `Subject: ${initial.subject}`,
    ]);
    const [storedSource] = await sql<
      {
        source_blob_id: string;
        source_hash: string;
        protocol_facts: Record<string, unknown>;
        selected_headers: Record<string, unknown>;
      }[]
    >`
      SELECT source_blob_id, source_hash, protocol_facts, selected_headers
      FROM mail.message_contents
      WHERE id = ${initialId}::uuid
    `;
    expect(storedSource?.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSource?.protocol_facts).toMatchObject({
      version: 1,
      autoSubmitted: null,
      contentType: "text/plain; charset=utf-8",
    });
    expect(storedSource?.selected_headers).toHaveProperty("message-id");
    expect(storedSource?.selected_headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(storedSource?.selected_headers).not.toHaveProperty("autoSubmitted");
    const sourceChunks: Buffer[] = [];
    for await (const chunk of createBlobReadable(storedSource!.source_blob_id)) sourceChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(sourceChunks)).toEqual(initialSource);
    const [link] = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id FROM mail.conversation_messages WHERE message_id = ${initialId}::uuid
    `;
    if (!link) throw new Error("Initial message was not linked to a conversation");
    const futureSnooze = new Date(Date.now() + 60 * 60_000).toISOString();
    await sql`
      UPDATE mail.conversations
      SET work_status = 'done', snoozed_until = ${futureSnooze}::timestamptz, revision = revision + 1
      WHERE id = ${link.conversation_id}::uuid
    `;

    const automaticMessageId = `<work-state-automatic-${suffix}@example.test>`;
    const automatic = envelope({
      uid: 2,
      messageId: automaticMessageId,
      inReplyTo: initialMessageId,
      from: "support@example.test",
      to: "customer@example.test",
      date: new Date("2026-07-22T08:01:00.000Z"),
      autoSubmitted: "auto-replied",
    });
    const automaticId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: automatic });
    await hydrate(automaticId, [
      `Message-ID: ${automaticMessageId}`,
      `In-Reply-To: ${initialMessageId}`,
      "Auto-Submitted: auto-replied",
      "From: Support <support@example.test>",
      "To: Customer <customer@example.test>",
      `Subject: ${automatic.subject}`,
    ]);
    const [afterAutomatic] = await sql<{ work_status: string; snoozed_until: Date | string | null }[]>`
      SELECT work_status, snoozed_until FROM mail.conversations WHERE id = ${link.conversation_id}::uuid
    `;
    expect(afterAutomatic?.work_status).toBe("done");
    expect(new Date(afterAutomatic!.snoozed_until!).toISOString()).toBe(futureSnooze);

    await sql`UPDATE mail.sender_identities SET status = 'disabled', is_default = false WHERE id = ${senderIdentityId}::uuid`;

    const replyMessageId = `<work-state-reply-${suffix}@example.test>`;
    const reply = envelope({
      uid: 3,
      messageId: replyMessageId,
      inReplyTo: automaticMessageId,
      from: "support@example.test",
      to: "customer@example.test",
      date: new Date("2026-07-22T08:02:00.000Z"),
      autoSubmitted: "no",
    });
    const replyId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: reply });
    await hydrate(replyId, [
      `Message-ID: ${replyMessageId}`,
      `In-Reply-To: ${automaticMessageId}`,
      "Auto-Submitted: no",
      "From: Support <support@example.test>",
      "To: Customer <customer@example.test>",
      `Subject: ${reply.subject}`,
    ]);
    const [afterReply] = await sql<{ work_status: string; snoozed_until: Date | string | null }[]>`
      SELECT work_status, snoozed_until FROM mail.conversations WHERE id = ${link.conversation_id}::uuid
    `;
    expect(afterReply?.work_status).toBe("waiting");
    expect(new Date(afterReply!.snoozed_until!).toISOString()).toBe(futureSnooze);

    const inboundMessageId = `<work-state-return-${suffix}@example.test>`;
    const inbound = envelope({
      uid: 4,
      messageId: inboundMessageId,
      inReplyTo: replyMessageId,
      from: "customer@example.test",
      to: "support@example.test",
      date: new Date("2026-07-22T08:03:00.000Z"),
    });
    const inboundId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: inbound });
    await hydrate(inboundId, [
      `Message-ID: ${inboundMessageId}`,
      `In-Reply-To: ${replyMessageId}`,
      "From: Customer <customer@example.test>",
      "To: Support <support@example.test>",
      `Subject: ${inbound.subject}`,
    ]);
    const [afterInbound] = await sql<{ work_status: string; snoozed_until: Date | string | null }[]>`
      SELECT work_status, snoozed_until FROM mail.conversations WHERE id = ${link.conversation_id}::uuid
    `;
    expect(afterInbound).toEqual({ work_status: "needs_action", snoozed_until: null });
  }, 30_000);

  test("releases due snoozes once without changing their work state", async () => {
    const [conversation] = await sql<{ id: string; revision: number }[]>`
      INSERT INTO mail.conversations (short_id,
        mailbox_id, subject, participant_summary, latest_message_at, work_status, snoozed_until
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        'Expired snooze',
        'customer@example.test',
        now(),
        'waiting',
        now() - interval '1 minute'
      )
      RETURNING id, revision::int AS revision
    `;
    const released = await releaseDueSnoozes(10);
    expect(released).toBeGreaterThanOrEqual(1);
    const [state] = await sql<{ work_status: string; snoozed_until: null; revision: number; activities: number }[]>`
      SELECT
        conversation.work_status,
        conversation.snoozed_until,
        conversation.revision::int AS revision,
        (
          SELECT COUNT(*)::int
          FROM mail.activity_events activity
          WHERE activity.conversation_id = conversation.id
            AND activity.action = 'conversation.snooze_expired'
        ) AS activities
      FROM mail.conversations conversation
      WHERE conversation.id = ${conversation!.id}::uuid
    `;
    expect(state).toEqual({
      work_status: "waiting",
      snoozed_until: null,
      revision: conversation!.revision + 1,
      activities: 1,
    });
    expect(await releaseDueSnoozes(10)).toBe(0);
    expect(releaseDueSnoozes(0)).rejects.toThrow("positive safe integer");
  }, 30_000);

  test("retains the exact source when protocol parsing fails", async () => {
    const failed = envelope({
      uid: 5,
      messageId: `<work-state-invalid-source-${suffix}@example.test>`,
      inReplyTo: null,
      from: "customer@example.test",
      to: "support@example.test",
      date: new Date("2026-07-22T08:04:00.000Z"),
    });
    const messageId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: failed,
    });
    const source = Buffer.from(`X-Oversized: ${"x".repeat(2 * 1024 * 1024)}\r\n\r\nbody`);

    await expect(
      hydrateMessageFromSource({
        messageId,
        source: Readable.from([source]),
        expectedSize: source.byteLength,
      }),
    ).rejects.toMatchObject({ code: "EMAXLEN" });

    const [stored] = await sql<
      {
        source_blob_id: string;
        source_hash: string;
        hydration_status: string;
        hydration_error_code: string;
      }[]
    >`
      SELECT source_blob_id, source_hash, hydration_status, hydration_error_code
      FROM mail.message_contents
      WHERE id = ${messageId}::uuid
    `;
    expect(stored).toMatchObject({
      hydration_status: "failed",
      hydration_error_code: "EMAXLEN",
    });
    expect(stored?.source_hash).toMatch(/^[a-f0-9]{64}$/);
    const chunks: Buffer[] = [];
    for await (const chunk of createBlobReadable(stored!.source_blob_id)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(source);
  }, 30_000);
});
