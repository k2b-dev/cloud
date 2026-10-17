import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { releaseDueSnoozes } from "./collaboration";
import { type ConnectorEnvelope, type ConnectorProtocolFacts, MAX_IMAP_LITERAL_BYTES } from "./connectors";
import { updateConversationCollaboration } from "./conversation-assignments";
import { refreshConversationTimeline } from "./conversation-timeline";
import { splitConversation } from "./conversations";
import { createMailbox } from "./mailboxes";
import { createBlobReadable } from "./message-blobs";
import { loadMailboxTransportFence } from "./mailbox-transport-fence";
import { hydrateMessageFromSource, recordMissingMessageSources, releaseExpiredHydrationClaims } from "./message-hydration";
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
  let sentFolderId = "";
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
    const [sentFolder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`work-state-sent-${suffix}`}, 'Sent', 'sent', 'current')
      RETURNING id
    `;
    remoteResourceId = resource!.id;
    folderId = folder!.id;
    sentFolderId = sentFolder!.id;
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

  test("a split gives the moved link a new transaction and link order and clears its status decision", async () => {
    const first = envelope({
      uid: 151,
      messageId: `<split-xid-first-${suffix}@example.test>`,
      inReplyTo: null,
      from: `split-xid-${suffix}@example.test`,
      to: "support@example.test",
      date: new Date("2026-10-01T10:00:00.000Z"),
    });
    const firstId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: first });
    const reply = envelope({
      uid: 152,
      messageId: `<split-xid-reply-${suffix}@example.test>`,
      inReplyTo: first.messageId,
      from: `split-xid-${suffix}@example.test`,
      to: "support@example.test",
      date: new Date("2026-10-01T10:01:00.000Z"),
    });
    const replyId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: reply });
    const conversation = await conversationForMessage(firstId);
    expect((await conversationForMessage(replyId)).id).toBe(conversation.id);
    const [before] = await sql<{ linked_xid: string; link_seq: string }[]>`
      UPDATE mail.conversation_messages SET status_covered = true, hydrated_revision = 1
      WHERE message_id = ${replyId}::uuid RETURNING linked_xid::text, link_seq::text
    `;
    expect(before?.linked_xid).toMatch(/^\d+$/);
    expect(before?.link_seq).toMatch(/^\d+$/);
    const split = await splitConversation({
      context,
      mailboxId,
      conversationId: conversation.id,
      input: { messageIds: [replyId], expectedRevision: conversation.revision, reason: "Separate request", confirm: true },
    });
    expect(split.ok).toBe(true);
    if (!split.ok) throw new Error(split.error.message);
    const [after] = await sql<{ linked_xid: string; link_seq: string; status_covered: boolean | null; hydrated_revision: number | null }[]>`
      SELECT linked_xid::text, link_seq::text, status_covered, hydrated_revision FROM mail.conversation_messages WHERE message_id = ${replyId}::uuid
    `;
    expect(after?.linked_xid).toMatch(/^\d+$/);
    expect(after?.linked_xid).not.toBe(before?.linked_xid);
    expect(after?.link_seq).toMatch(/^\d+$/);
    expect(BigInt(after!.link_seq)).toBeGreaterThan(BigInt(before!.link_seq));
    expect(after?.status_covered).toBeNull();
    expect(after?.hydrated_revision).toBeNull();
  });

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

  test("starts a conversation with a new message found in Sent as waiting, but not one from the own address in the Inbox", async () => {
    const startingWorkStatus = async (uid: number, key: string, ingestFolderId: string) => {
      const message = envelope({
        uid,
        messageId: `<work-state-${key}-${suffix}@example.test>`,
        inReplyTo: null,
        from: "support@example.test",
        to: "customer@example.test",
        date: new Date("2026-07-22T09:00:00.000Z"),
      });
      message.subject = `Work-state ${key}`;
      const messageId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId: ingestFolderId, message });
      const [conversation] = await sql<{ work_status: string }[]>`
        SELECT conversation.work_status
        FROM mail.conversation_messages link
        JOIN mail.conversations conversation ON conversation.id = link.conversation_id
        WHERE link.message_id = ${messageId}::uuid
      `;
      return conversation?.work_status;
    };
    // A message written in another email client waits for an answer.
    expect(await startingWorkStatus(6, "announcement", sentFolderId)).toBe("waiting");
    // A contact form that sends in the mailbox's name delivers a request someone has to handle.
    expect(await startingWorkStatus(9, "contact-form", folderId)).toBe("needs_action");
  }, 30_000);

  test("a timeline refresh waits for a hydration of the same conversation instead of overwriting it", async () => {
    const olderMessageId = `<work-state-timeline-older-${suffix}@example.test>`;
    const older = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: envelope({
        uid: 7,
        messageId: olderMessageId,
        inReplyTo: null,
        from: "customer@example.test",
        to: "support@example.test",
        date: new Date("2026-07-23T09:00:00.000Z"),
      }),
    });
    const newerDate = new Date("2026-07-23T10:00:00.000Z");
    const newer = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: envelope({
        uid: 8,
        messageId: `<work-state-timeline-newer-${suffix}@example.test>`,
        inReplyTo: olderMessageId,
        from: "customer@example.test",
        to: "support@example.test",
        date: newerDate,
      }),
    });
    const [link] = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id FROM mail.conversation_messages WHERE message_id = ${newer}::uuid
    `;
    const conversationId = link!.conversation_id;
    await sql`UPDATE mail.message_contents SET hydration_status = 'complete' WHERE id = ${older}::uuid`;

    // A hydration holds the conversation while it completes the newer message.
    let completed!: () => void;
    const holding = new Promise<void>((resolve) => {
      completed = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hydration = sql.begin(async (tx) => {
      await tx`SELECT id FROM mail.conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
      await tx`UPDATE mail.message_contents SET hydration_status = 'complete' WHERE id = ${newer}::uuid`;
      completed();
      await released;
      await refreshConversationTimeline(tx, conversationId);
    });
    await holding;
    let started!: (pid: number) => void;
    const refreshPid = new Promise<number>((resolve) => {
      started = resolve;
    });
    const refresh = sql.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      started(backend!.pid);
      await refreshConversationTimeline(tx, conversationId);
    });
    // Release the hydration only once the refresh waits for the conversation.
    const pid = await refreshPid;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [backend] = await sql<{ wait_event_type: string | null }[]>`
        SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}
      `;
      if (backend?.wait_event_type === "Lock") break;
      await Bun.sleep(20);
    }
    release();
    await Promise.all([hydration, refresh]);

    const [conversation] = await sql<{ latest_message_at: Date }[]>`
      SELECT latest_message_at FROM mail.conversations WHERE id = ${conversationId}::uuid
    `;
    expect(conversation?.latest_message_at.getTime()).toBe(newerDate.getTime());
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

  const conversationForMessage = async (messageId: string) => {
    const [conversation] = await sql<
      {
        id: string;
        revision: number;
        work_status: string;
        snoozed_until: Date | string | null;
      }[]
    >`
      SELECT conversation.id, conversation.revision::int AS revision, conversation.work_status, conversation.snoozed_until
      FROM mail.conversation_messages link
      JOIN mail.conversations conversation ON conversation.id = link.conversation_id
      WHERE link.message_id = ${messageId}::uuid
    `;
    if (!conversation) throw new Error("Message was not linked to a conversation");
    return conversation;
  };

  const decideWorkState = async (
    messageId: string,
    input: { completion?: "done" | "open"; workStatus?: "waiting"; snoozedUntil?: string },
  ) => {
    const conversation = await conversationForMessage(messageId);
    const updated = await updateConversationCollaboration({
      context,
      mailboxId,
      conversationId: conversation.id,
      locale: "en",
      input: { expectedRevision: conversation.revision, ...input },
    });
    if (!updated.ok) throw new Error(updated.error.message);
    return updated.data;
  };

  const reconciledActivities = (messageId: string) => sql<{ id: string }[]>`
    SELECT id FROM mail.activity_events
    WHERE mailbox_id = ${mailboxId}::uuid
      AND action = 'conversation.work_state_changed' AND outcome = 'reconciled'
      AND metadata ->> 'messageId' = ${messageId}
  `;

  let terminalFailureUid = 15000;
  const terminalFailurePair = async (key: string, decision: "done" | "waiting" | "snooze" = "done", sizeBytes = 256) => {
    const uid = terminalFailureUid;
    terminalFailureUid += 3;
    const first = envelope({
      uid,
      messageId: `<terminal-${key}-first-${suffix}@example.test>`,
      inReplyTo: null,
      from: `terminal-${key}-${suffix}@example.test`,
      to: "support@example.test",
      date: new Date("2026-10-01T11:00:00.000Z"),
    });
    const firstId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: first });
    await hydrate(firstId, [`Message-ID: ${first.messageId}`, `From: ${first.addresses.from[0]!.address}`, "To: support@example.test"]);
    await decideWorkState(
      firstId,
      decision === "snooze"
        ? { snoozedUntil: new Date(Date.now() + 60 * 60_000).toISOString() }
        : decision === "waiting"
          ? { workStatus: "waiting", snoozedUntil: new Date(Date.now() + 60 * 60_000).toISOString() }
          : { completion: "done" },
    );
    const second = envelope({
      uid: uid + 1,
      messageId: `<terminal-${key}-second-${suffix}@example.test>`,
      inReplyTo: first.messageId,
      from: first.addresses.from[0]!.address,
      to: "support@example.test",
      date: new Date("2026-10-01T11:01:00.000Z"),
    });
    second.sizeBytes = sizeBytes;
    const secondId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: second });
    expect((await conversationForMessage(secondId)).id).toBe((await conversationForMessage(firstId)).id);
    return { first, firstId, second, secondId };
  };

  const failTooLarge = async (messageId: string) => {
    await sql`UPDATE mail.message_contents SET size_bytes = ${MAX_IMAP_LITERAL_BYTES + 1} WHERE id = ${messageId}::uuid`;
    await expect(hydrateMessageFromSource({ messageId, source: Readable.from([]) })).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
  };

  const expectTerminalReopened = async (messageId: string) => {
    const conversation = await conversationForMessage(messageId);
    expect(conversation.work_status).toBe("needs_action");
    expect(conversation.snoozed_until).toBeNull();
    expect(await reconciledActivities(messageId)).toHaveLength(1);
  };

  for (const decision of ["done", "waiting", "snooze"] as const) {
    test(`terminal oversized inbound reopens ${decision} and repair does not repeat its activity`, async () => {
      const { second, secondId } = await terminalFailurePair(`oversized-${decision}`, decision, MAX_IMAP_LITERAL_BYTES + 1);
      const before = await conversationForMessage(secondId);
      await failTooLarge(secondId);
      await expectTerminalReopened(secondId);
      expect((await conversationForMessage(secondId)).revision).toBe(before.revision + 1);
      const [link] = await sql<{ hydrated_revision: number }[]>`
        SELECT hydrated_revision::int FROM mail.conversation_messages WHERE message_id = ${secondId}::uuid
      `;
      expect(link?.hydrated_revision).toBe(before.revision + 1);
      await sql`
        UPDATE mail.message_contents SET hydration_status = 'envelope', hydration_attempt = 0, size_bytes = 256
        WHERE id = ${secondId}::uuid
      `;
      await hydrate(secondId, [
        `Message-ID: ${second.messageId}`,
        `In-Reply-To: ${second.inReplyTo}`,
        `From: ${second.addresses.from[0]!.address}`,
        "To: support@example.test",
      ]);
      await expectTerminalReopened(secondId);
    }, 30_000);
  }

  test("terminal failure locks the mailbox before the conversation", async () => {
    const { secondId } = await terminalFailurePair("mailbox-lock-order");
    const conversation = await conversationForMessage(secondId);
    let failing: Promise<void> | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid FOR UPDATE`;
        const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!holder) throw new Error("Lock holder backend was not found");
        failing = failTooLarge(secondId);
        void failing.catch(() => undefined);

        const deadline = Date.now() + 5_000;
        let waiting = 0;
        while (Date.now() < deadline) {
          const [activity] = await sql<{ waiting: number }[]>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database()
              AND ${holder.pid}::int = ANY(pg_blocking_pids(pid))
          `;
          waiting = activity?.waiting ?? 0;
          if (waiting > 0) break;
          await Bun.sleep(20);
        }
        expect(waiting).toBeGreaterThan(0);

        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`SELECT id FROM mail.conversations WHERE id = ${conversation.id}::uuid FOR UPDATE`;
      });
      await failing;
    } finally {
      await failing?.catch(() => undefined);
    }
    await expectTerminalReopened(secondId);
  }, 30_000);

  test("terminal missing source reopens Done only on the fifth attempt", async () => {
    const { secondId } = await terminalFailurePair("missing-source");
    const fence = await loadMailboxTransportFence(remoteResourceId);
    if (!fence) throw new Error("Mailbox transport fence was not found");
    const before = await conversationForMessage(secondId);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await recordMissingMessageSources([secondId], fence)).toEqual([secondId]);
      if (attempt < 5) {
        expect(await conversationForMessage(secondId)).toEqual(before);
        expect(await reconciledActivities(secondId)).toHaveLength(0);
      }
    }
    await expectTerminalReopened(secondId);
    expect(await recordMissingMessageSources([secondId], fence)).toEqual([]);
    await expectTerminalReopened(secondId);
  }, 30_000);

  test("terminal expired claim reopens Done only on the last attempt", async () => {
    const { secondId } = await terminalFailurePair("expired-claim");
    const before = await conversationForMessage(secondId);
    for (const attempt of [4, 5]) {
      await sql`
        UPDATE mail.message_contents
        SET
          hydration_status = 'hydrating',
          hydration_claim_id = gen_random_uuid(),
          hydration_claimed_at = now() - interval '20 minutes',
          hydration_attempt = ${attempt}
        WHERE id = ${secondId}::uuid
      `;
      expect(await releaseExpiredHydrationClaims()).toContainEqual({ id: secondId, mailbox_id: mailboxId });
      if (attempt < 5) {
        expect(await conversationForMessage(secondId)).toEqual(before);
        expect(await reconciledActivities(secondId)).toHaveLength(0);
      }
    }
    await expectTerminalReopened(secondId);
  }, 30_000);

  test("terminal source stream failure reopens Done while a retryable failure leaves it unchanged", async () => {
    const { secondId } = await terminalFailurePair("stream-failure");
    const before = await conversationForMessage(secondId);
    for (const previousAttempt of [0, 4]) {
      await sql`UPDATE mail.message_contents SET hydration_attempt = ${previousAttempt} WHERE id = ${secondId}::uuid`;
      const error = Object.assign(new Error("Test source interrupted"), { code: "TEST_SOURCE_INTERRUPTED" });
      const source = Readable.from(
        (async function* () {
          yield Buffer.from("From: sender@example.test\r\n");
          throw error;
        })(),
      );
      await expect(hydrateMessageFromSource({ messageId: secondId, source })).rejects.toBe(error);
      if (previousAttempt === 0) {
        expect(await conversationForMessage(secondId)).toEqual(before);
        expect(await reconciledActivities(secondId)).toHaveLength(0);
      }
    }
    await expectTerminalReopened(secondId);
  }, 30_000);

  test("an older terminal failure keeps Done and does not bump its revision", async () => {
    const { first, secondId } = await terminalFailurePair("older-failure");
    const older = {
      ...first,
      inReplyTo: first.messageId,
      references: [first.messageId!],
      messageId: `<terminal-older-${suffix}@example.test>`,
      internalDate: new Date("2026-10-01T10:59:00.000Z"),
    };
    older.remoteRef = { ...first.remoteRef, uid: String(Number(first.remoteRef.uid) + 2) };
    const olderId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: older });
    expect((await conversationForMessage(olderId)).id).toBe((await conversationForMessage(secondId)).id);
    const before = await conversationForMessage(olderId);
    await failTooLarge(olderId);
    expect(await conversationForMessage(olderId)).toEqual(before);
    expect(await reconciledActivities(olderId)).toHaveLength(0);
    const [link] = await sql<{ hydrated_revision: string | null }[]>`
      SELECT hydrated_revision FROM mail.conversation_messages WHERE message_id = ${olderId}::uuid
    `;
    expect(link?.hydrated_revision).toBeNull();
  }, 30_000);

  test("a person's Done covering an unloadable reply wins without a revision bump", async () => {
    const { secondId } = await terminalFailurePair("covered");
    await decideWorkState(secondId, { completion: "done" });
    const before = await conversationForMessage(secondId);
    await failTooLarge(secondId);
    expect(await conversationForMessage(secondId)).toEqual(before);
    expect(await reconciledActivities(secondId)).toHaveLength(0);
  }, 30_000);

  test("terminal failure without a visible change leaves the revision and hydrated revision alone", async () => {
    const { secondId } = await terminalFailurePair("no-op");
    await decideWorkState(secondId, { completion: "open" });
    const before = await conversationForMessage(secondId);
    expect(before.work_status).toBe("needs_action");
    await failTooLarge(secondId);
    expect(await conversationForMessage(secondId)).toEqual(before);
    expect(await reconciledActivities(secondId)).toHaveLength(0);
    const [link] = await sql<{ hydrated_revision: string | null }[]>`
      SELECT hydrated_revision FROM mail.conversation_messages WHERE message_id = ${secondId}::uuid
    `;
    expect(link?.hydrated_revision).toBeNull();
  }, 30_000);

  test("an older outbound load cannot override a newer terminal inbound failure", async () => {
    const { first, secondId } = await terminalFailurePair("older-outbound");
    const outbound = envelope({
      uid: Number(first.remoteRef.uid) + 2,
      messageId: `<terminal-older-outbound-${suffix}@example.test>`,
      inReplyTo: first.messageId,
      from: "support@example.test",
      to: first.addresses.from[0]!.address,
      date: new Date("2026-10-01T11:00:30.000Z"),
    });
    const outboundId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: outbound });
    expect((await conversationForMessage(outboundId)).id).toBe((await conversationForMessage(secondId)).id);
    await failTooLarge(secondId);
    await expectTerminalReopened(secondId);
    await hydrate(outboundId, [
      `Message-ID: ${outbound.messageId}`,
      `In-Reply-To: ${first.messageId}`,
      "From: support@example.test",
      `To: ${outbound.addresses.to[0]!.address}`,
    ]);
    await expectTerminalReopened(secondId);
    expect(await reconciledActivities(outboundId)).toHaveLength(0);
  }, 30_000);

  test("reopening counts a terminally failed reply to restore Needs action", async () => {
    const { first, secondId } = await terminalFailurePair("reopen");
    const outbound = envelope({
      uid: Number(first.remoteRef.uid) + 2,
      messageId: `<terminal-reopen-outbound-${suffix}@example.test>`,
      inReplyTo: first.messageId,
      from: "support@example.test",
      to: first.addresses.from[0]!.address,
      date: new Date("2026-10-01T11:00:30.000Z"),
    });
    outbound.remoteRef.folderStableKey = `work-state-sent-${suffix}`;
    const outboundId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId: sentFolderId, message: outbound });
    expect((await conversationForMessage(outboundId)).id).toBe((await conversationForMessage(secondId)).id);
    await hydrate(outboundId, [
      `Message-ID: ${outbound.messageId}`,
      `In-Reply-To: ${first.messageId}`,
      "From: support@example.test",
      `To: ${outbound.addresses.to[0]!.address}`,
    ]);
    expect((await conversationForMessage(secondId)).work_status).toBe("waiting");
    await failTooLarge(secondId);
    expect((await conversationForMessage(secondId)).work_status).toBe("needs_action");
    expect((await decideWorkState(secondId, { completion: "done" })).workStatus).toBe("done");
    await decideWorkState(secondId, { completion: "open" });
    expect((await conversationForMessage(secondId)).work_status).toBe("needs_action");
  }, 30_000);

  test("reopening lets an envelope-only reply reopen the conversation to Needs action", async () => {
    const ownAddress = `reopen-outbound-${suffix}@example.test`;
    await sql`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, is_default, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Reopen test', 'Support', ${ownAddress}, false, 'verified')
    `;
    const outbound = envelope({
      uid: 13021,
      messageId: `<reopen-outbound-${suffix}@example.test>`,
      inReplyTo: `<reopen-parent-${suffix}@example.test>`,
      from: ownAddress,
      to: "customer@example.test",
      date: new Date("2026-10-01T10:00:00.000Z"),
    });
    outbound.subject = `Re: Work-state reopen ${suffix}`;
    outbound.remoteRef.folderStableKey = `work-state-sent-${suffix}`;
    const outboundId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId: sentFolderId, message: outbound });
    await hydrate(outboundId, [
      `Message-ID: ${outbound.messageId}`,
      `In-Reply-To: ${outbound.inReplyTo}`,
      `From: ${ownAddress}`,
      "To: customer@example.test",
      `Subject: ${outbound.subject}`,
    ]);
    expect((await conversationForMessage(outboundId)).work_status).toBe("waiting");
    const reply = envelope({
      uid: 13022,
      messageId: `<reopen-inbound-${suffix}@example.test>`,
      inReplyTo: outbound.messageId,
      from: "customer@example.test",
      to: ownAddress,
      date: new Date("2026-10-01T10:01:00.000Z"),
    });
    reply.subject = outbound.subject;
    const replyId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: reply });
    expect((await conversationForMessage(replyId)).id).toBe((await conversationForMessage(outboundId)).id);
    expect((await decideWorkState(replyId, { completion: "done" })).workStatus).toBe("done");
    expect((await decideWorkState(replyId, { completion: "open" })).workStatus).toBe("waiting");
    await hydrate(replyId, [
      `Message-ID: ${reply.messageId}`,
      `In-Reply-To: ${outbound.messageId}`,
      "From: customer@example.test",
      `To: ${ownAddress}`,
      `Subject: ${reply.subject}`,
    ]);
    expect((await conversationForMessage(replyId)).work_status).toBe("needs_action");
    expect(await reconciledActivities(replyId)).toHaveLength(1);
  }, 30_000);

  for (const decision of ["Done", "snooze"] as const) {
    test(`keeps Done or a snooze that a person set before Mail hydrated the message (${decision})`, async () => {
      const key = decision.toLowerCase();
      const sender = `before-hydration-${key}-${suffix}@example.test`;
      const message = envelope({
        uid: decision === "Done" ? 101 : 102,
        messageId: `<before-hydration-${key}-${suffix}@example.test>`,
        inReplyTo: null,
        from: sender,
        to: "support@example.test",
        date: new Date("2026-10-01T08:00:00.000Z"),
      });
      const messageId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message });
      const futureSnooze = new Date(Date.now() + 60 * 60_000).toISOString();
      const decided = await decideWorkState(messageId, decision === "Done" ? { completion: "done" } : { snoozedUntil: futureSnooze });
      expect(decided.workStatus).toBe(decision === "Done" ? "done" : "needs_action");
      expect(decided.snoozedUntil).toBe(decision === "Done" ? null : futureSnooze);
      await hydrate(messageId, [
        `Message-ID: ${message.messageId}`,
        `From: ${sender}`,
        "To: support@example.test",
        `Subject: ${message.subject}`,
      ]);
      const conversation = await conversationForMessage(messageId);
      expect(conversation.work_status).toBe(decided.workStatus);
      expect(conversation.snoozed_until ? new Date(conversation.snoozed_until).toISOString() : null).toBe(decided.snoozedUntil);
      expect(await reconciledActivities(messageId)).toEqual([]);
    }, 30_000);
  }

  for (const decision of ["Done", "snooze"] as const) {
    const name =
      decision === "Done"
        ? "reopens a Done conversation for a message that arrives after the decision"
        : "clears a snooze for a message that arrives after the decision";
    test(name, async () => {
      const key = decision.toLowerCase();
      const sender = `after-decision-${key}-${suffix}@example.test`;
      const firstMessageId = `<after-decision-${key}-first-${suffix}@example.test>`;
      const first = envelope({
        uid: decision === "Done" ? 111 : 121,
        messageId: firstMessageId,
        inReplyTo: null,
        from: sender,
        to: "support@example.test",
        date: new Date("2026-10-01T09:00:00.000Z"),
      });
      const firstId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: first });
      await hydrate(firstId, [`Message-ID: ${firstMessageId}`, `From: ${sender}`, "To: support@example.test", `Subject: ${first.subject}`]);
      const futureSnooze = new Date(Date.now() + 60 * 60_000).toISOString();
      const decided = await decideWorkState(firstId, decision === "Done" ? { completion: "done" } : { snoozedUntil: futureSnooze });
      expect(decided.workStatus).toBe(decision === "Done" ? "done" : "needs_action");
      expect(decided.snoozedUntil).toBe(decision === "Done" ? null : futureSnooze);
      const second = envelope({
        uid: decision === "Done" ? 112 : 122,
        messageId: `<after-decision-${key}-second-${suffix}@example.test>`,
        inReplyTo: firstMessageId,
        from: sender,
        to: "support@example.test",
        date: new Date("2026-10-01T09:01:00.000Z"),
      });
      const secondId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: second });
      expect((await conversationForMessage(secondId)).id).toBe((await conversationForMessage(firstId)).id);
      await hydrate(secondId, [
        `Message-ID: ${second.messageId}`,
        `In-Reply-To: ${firstMessageId}`,
        `From: ${sender}`,
        "To: support@example.test",
        `Subject: ${second.subject}`,
      ]);
      const conversation = await conversationForMessage(secondId);
      expect(conversation.work_status).toBe("needs_action");
      expect(conversation.snoozed_until).toBeNull();
      expect(await reconciledActivities(secondId)).toHaveLength(1);
    }, 30_000);
  }
});
