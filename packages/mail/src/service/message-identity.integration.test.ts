import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { deleteWorkflowScope } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import type { ConnectorEnvelope } from "./connectors";
import { createMailbox } from "./mailboxes";
import { hydrateMessageFromSource } from "./message-hydration";
import { ingestEnvelope } from "./sync-runtime";
import { activateWorkflow, createWorkflow } from "./workflow-definition-service";

const suite = suiteFor("database", "nats");

const noEffectBudget = {
  maxTargets: 1,
  maxMoves: 0,
  maxCopies: 0,
  maxSends: 0,
  maxDrafts: 0,
  maxFlagChanges: 0,
  maxNotifications: 0,
  maxKeywordChanges: 0,
  maxCollaborationChanges: 0,
  maxAiCalls: 0,
};

type Address = { name: string; address: string };

/**
 * A generic IMAP server without OBJECTID or X-GM-EXT-1: Mail sees no provider message or
 * thread id and must recognize a message through its headers alone.
 */
suite("mail message identity and threading on generic IMAP", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const support = "support@example.test";
  let userId = "";
  let mailboxId = "";
  let remoteResourceId = "";
  let workflowId = "";
  const folders: Record<"inbox" | "archive" | "sent", string> = { inbox: "", archive: "", sent: "" };
  let context: MailRequestContext;
  let nextUid = 100;

  const envelope = (params: {
    folder: keyof typeof folders;
    messageId: string;
    subject: string;
    from: Address;
    to: Address[];
    cc?: Address[];
    date: Date;
    internalDate?: Date;
    sizeBytes?: number;
    inReplyTo?: string;
    references?: string[];
  }): ConnectorEnvelope => {
    nextUid += 1;
    return {
      remoteRef: { folderStableKey: `${params.folder}-${suffix}`, uidValidity: "1", uid: String(nextUid), modseq: String(nextUid) },
      providerMessageId: null,
      providerThreadId: null,
      messageId: params.messageId,
      inReplyTo: params.inReplyTo ?? null,
      references: params.references ?? [],
      subject: params.subject,
      sentAt: params.date,
      internalDate: params.internalDate ?? params.date,
      sizeBytes: params.sizeBytes ?? 512,
      flags: [],
      labels: [],
      addresses: { from: [params.from], replyTo: [], to: params.to, cc: params.cc ?? [], bcc: [] },
      mimeStructure: {},
    };
  };

  const ingest = (folder: keyof typeof folders, message: ConnectorEnvelope, incremental = false) =>
    ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: folders[folder],
      message,
      captureWorkflowTriggers: incremental,
    });

  /** What a folder sync records once the message has left the folder: see markMissingUids. */
  const leaveFolder = async (folder: keyof typeof folders, message: ConnectorEnvelope) => {
    await sql`
      WITH missing AS (
        UPDATE mail.remote_message_refs
        SET stale_at = now()
        WHERE folder_id = ${folders[folder]}::uuid AND uid_validity = 1 AND uid = ${message.remoteRef.uid}::numeric
        RETURNING id
      )
      UPDATE mail.message_placements placement
      SET deleted_at = now(), updated_at = now()
      FROM missing
      WHERE placement.remote_message_ref_id = missing.id
    `;
  };

  const conversationOf = async (messageId: string): Promise<string> => {
    const [link] = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id::text FROM mail.conversation_messages WHERE message_id = ${messageId}::uuid
    `;
    if (!link) throw new Error("Message is not linked to a conversation");
    return link.conversation_id;
  };

  const projection = async (messageIdHeader: string) => {
    const [row] = await sql<{ contents: number; links: number; live_placements: number }[]>`
      WITH contents AS (
        SELECT id FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid AND message_id = ${messageIdHeader}
      )
      SELECT
        (SELECT COUNT(*)::int FROM contents) AS contents,
        (SELECT COUNT(*)::int FROM mail.conversation_messages WHERE message_id IN (SELECT id FROM contents)) AS links,
        (
          SELECT COUNT(*)::int
          FROM mail.message_placements
          WHERE message_id IN (SELECT id FROM contents) AND deleted_at IS NULL
        ) AS live_placements
    `;
    return row;
  };

  const receivedEvents = async (): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM workflows.event WHERE target_workflow_id = ${workflowId}::uuid
    `;
    return row?.count ?? 0;
  };

  beforeAll(async () => {
    await migrate();
    const [user] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-identity-${suffix}`}, 'local', 'user', 'Mail identity', false)
      RETURNING id, uid
    `;
    if (!user) throw new Error("Failed to create Mail identity test user");
    userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid: user.uid,
          provider: "local",
          profile: "user",
          displayName: "Mail identity",
          givenName: "Mail",
          sn: "Identity",
          mail: `${user.uid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `mail-identity-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Message identity ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}, 'active')
      RETURNING id
    `;
    remoteResourceId = resource!.id;
    for (const [key, role] of [
      ["inbox", "inbox"],
      ["archive", "archive"],
      ["sent", "sent"],
    ] as const) {
      const [folder] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${newShortId()}, ${remoteResourceId}::uuid, ${`${key}-${suffix}`}, ${key}, ${role}, 'current')
        RETURNING id
      `;
      folders[key] = folder!.id;
    }
    // The account address is also the sender identity, as in a typical team mailbox.
    await sql`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username,
        imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode,
        secret_kind, encrypted_secret, status
      ) VALUES (
        ${mailboxId}::uuid, 'Identity fixture', ${support}, ${support},
        'imap.example.test', 993, 'implicit',
        'smtp.example.test', 465, 'implicit',
        'password', 'fixture-secret', 'active'
      )
    `;
    await sql`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, is_default, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Support', 'Support', ${support}, true, 'verified')
    `;
    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name: `Received ${suffix}`,
        priority: 100,
        source: `triggers:
  messageReceived:
    with: {}
steps:
  - succeed:
      message: Received
`,
        effectBudget: noEffectBudget,
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const activated = await activateWorkflow({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: created.data.currentVersion.id },
    });
    if (!activated.ok) throw new Error(activated.error.message);
    workflowId = created.data.id;
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`
        DELETE FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid RETURNING access_id
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
      if (access.length > 0) {
        await sql`
          DELETE FROM auth.access
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))
        `;
      }
    }
    if (context) await sql`DELETE FROM audit.events WHERE request_id = ${context.requestId}`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  const customer: Address = { name: "Customer", address: "customer@example.test" };
  const supportAddress: Address = { name: "Support", address: support };

  test("a message moved in another client stays one message and is not received again", async () => {
    const messageId = `<moved-${suffix}@example.test>`;
    const date = new Date("2026-08-01T09:00:00.000Z");
    const inInbox = envelope({ folder: "inbox", messageId, subject: "Moved message", from: customer, to: [supportAddress], date });
    const eventsBefore = await receivedEvents();
    const originalId = await ingest("inbox", inInbox, true);
    expect(await projection(messageId)).toEqual({ contents: 1, links: 1, live_placements: 1 });
    expect(await receivedEvents()).toBe(eventsBefore + 1);

    // The phone files it into Archive: the server gives it a new UID there.
    const inArchive = envelope({ folder: "archive", messageId, subject: "Moved message", from: customer, to: [supportAddress], date });
    await leaveFolder("inbox", inInbox);
    expect(await ingest("archive", inArchive, true)).toBe(originalId);
    expect(await projection(messageId)).toEqual({ contents: 1, links: 1, live_placements: 1 });
    expect(await receivedEvents()).toBe(eventsBefore + 1);

    // A copy instead of a move: the message sits in two folders and is still one message.
    const copy = envelope({ folder: "inbox", messageId, subject: "Moved message", from: customer, to: [supportAddress], date });
    expect(await ingest("inbox", copy, true)).toBe(originalId);
    expect(await projection(messageId)).toEqual({ contents: 1, links: 1, live_placements: 2 });
    expect(await receivedEvents()).toBe(eventsBefore + 1);
  });

  test("a message without a Message-ID stays one message when another client moves it", async () => {
    const fields = {
      messageId: "",
      subject: "Disk usage alert",
      from: { name: "Monitor", address: "monitor@example.test" },
      to: [supportAddress],
      date: new Date("2026-08-01T10:00:00.000Z"),
    };
    const inInbox = { ...envelope({ folder: "inbox", ...fields }), messageId: null };
    const eventsBefore = await receivedEvents();
    const originalId = await ingest("inbox", inInbox, true);
    await leaveFolder("inbox", inInbox);
    expect(await ingest("archive", { ...envelope({ folder: "archive", ...fields }), messageId: null }, true)).toBe(originalId);
    expect(await receivedEvents()).toBe(eventsBefore + 1);
  });

  test("a message moved before its body was loaded is loaded once from its new folder", async () => {
    const messageId = `<moved-early-${suffix}@example.test>`;
    const date = new Date("2026-08-02T09:00:00.000Z");
    const source = Buffer.from(
      [
        `Message-ID: ${messageId}`,
        "Date: Sun, 02 Aug 2026 09:00:00 +0000",
        `From: Customer <${customer.address}>`,
        `To: Support <${support}>`,
        "Subject: Moved before hydration",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body that only the archived copy can provide",
      ].join("\r\n"),
    );
    const fields = {
      messageId,
      subject: "Moved before hydration",
      from: customer,
      to: [supportAddress],
      date,
      sizeBytes: source.byteLength,
    };
    const inInbox = envelope({ folder: "inbox", ...fields });
    const originalId = await ingest("inbox", inInbox);
    await leaveFolder("inbox", inInbox);
    const archivedId = await ingest("archive", envelope({ folder: "archive", ...fields }));
    expect(archivedId).toBe(originalId);
    expect(await hydrateMessageFromSource({ messageId: archivedId, source: Readable.from([source]) })).toMatchObject({
      status: "hydrated",
    });
    const [message] = await sql<{ hydration_status: string; links: number; live_refs: number }[]>`
      SELECT
        message.hydration_status,
        (SELECT COUNT(*)::int FROM mail.conversation_messages WHERE message_id = message.id) AS links,
        (SELECT COUNT(*)::int FROM mail.remote_message_refs WHERE message_id = message.id AND stale_at IS NULL) AS live_refs
      FROM mail.message_contents message
      WHERE message.mailbox_id = ${mailboxId}::uuid AND message.message_id = ${messageId}
    `;
    expect(message).toEqual({ hydration_status: "complete", links: 1, live_refs: 1 });
  });

  test("a message whose body went missing before a move loads it from its new folder", async () => {
    const messageId = `<moved-missing-${suffix}@example.test>`;
    const source = Buffer.from(
      [
        `Message-ID: ${messageId}`,
        "Date: Tue, 04 Aug 2026 09:00:00 +0000",
        `From: Customer <${customer.address}>`,
        `To: Support <${support}>`,
        "Subject: Moved after failed loads",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body that only the archived copy can provide",
      ].join("\r\n"),
    );
    const fields = {
      messageId,
      subject: "Moved after failed loads",
      from: customer,
      to: [supportAddress],
      date: new Date("2026-08-04T09:00:00.000Z"),
      sizeBytes: source.byteLength,
    };
    const inInbox = envelope({ folder: "inbox", ...fields });
    const originalId = await ingest("inbox", inInbox);
    // Every attempt found the Inbox copy gone, as recordMissingMessageSources records it.
    await sql`
      UPDATE mail.message_contents
      SET hydration_status = 'failed', hydration_attempt = 5, hydration_error_code = 'MESSAGE_SOURCE_MISSING'
      WHERE id = ${originalId}::uuid
    `;
    await leaveFolder("inbox", inInbox);
    expect(await ingest("archive", envelope({ folder: "archive", ...fields }))).toBe(originalId);
    expect(await hydrateMessageFromSource({ messageId: originalId, source: Readable.from([source]) })).toMatchObject({
      status: "hydrated",
    });
  });

  test("the copy in Sent and the delivered copy of one's own mail are one message", async () => {
    const messageId = `<own-copy-${suffix}@example.test>`;
    const date = new Date("2026-08-03T09:00:00.000Z");
    const team: Address = { name: "Team", address: "team@example.test" };
    const fields = { messageId, subject: "Team update", from: supportAddress, to: [team], date };
    // The delivered copy carries extra Received headers and arrives a little later.
    const sentId = await ingest("sent", envelope({ folder: "sent", ...fields, sizeBytes: 900 }));
    const deliveredId = await ingest(
      "inbox",
      envelope({ folder: "inbox", ...fields, sizeBytes: 1_400, internalDate: new Date("2026-08-03T09:00:04.000Z") }),
      true,
    );
    expect(deliveredId).toBe(sentId);
    expect(await projection(messageId)).toEqual({ contents: 1, links: 1, live_placements: 2 });
  });

  test("unrelated mail with the same subject from different senders stays apart", async () => {
    const shopA: Address = { name: "Shop A", address: "billing@shop-a.example.test" };
    const shopB: Address = { name: "Shop B", address: "billing@shop-b.example.test" };
    const fromA = await ingest(
      "inbox",
      envelope({
        folder: "inbox",
        messageId: `<invoice-a-${suffix}@shop-a.example.test>`,
        subject: "Invoice",
        from: shopA,
        to: [supportAddress],
        date: new Date("2026-08-10T09:00:00.000Z"),
      }),
    );
    const fromB = await ingest(
      "inbox",
      envelope({
        folder: "inbox",
        messageId: `<invoice-b-${suffix}@shop-b.example.test>`,
        subject: "Invoice",
        from: shopB,
        to: [supportAddress],
        date: new Date("2026-08-19T09:00:00.000Z"),
      }),
    );
    expect(await conversationOf(fromB)).not.toBe(await conversationOf(fromA));

    // A later "Invoice" from the same sender without reply headers is a new invoice, not a reply.
    const nextFromA = await ingest(
      "inbox",
      envelope({
        folder: "inbox",
        messageId: `<invoice-a2-${suffix}@shop-a.example.test>`,
        subject: "Invoice",
        from: shopA,
        to: [supportAddress],
        date: new Date("2026-08-20T09:00:00.000Z"),
      }),
    );
    expect(await conversationOf(nextFromA)).not.toBe(await conversationOf(fromA));

    // A reply whose client dropped the reply headers still joins its counterparty's conversation.
    const replyToA = await ingest(
      "sent",
      envelope({
        folder: "sent",
        messageId: `<invoice-reply-${suffix}@example.test>`,
        subject: "Re: Invoice",
        from: supportAddress,
        to: [shopA],
        date: new Date("2026-08-20T10:00:00.000Z"),
      }),
    );
    expect(await conversationOf(replyToA)).toBe(await conversationOf(nextFromA));
  });

  test("a reply without reply headers joins its original when the initial sync imports it first", async () => {
    const reply = await ingest(
      "inbox",
      envelope({
        folder: "inbox",
        messageId: `<headerless-reply-${suffix}@example.test>`,
        subject: "Re: Offer",
        from: customer,
        to: [supportAddress],
        date: new Date("2026-08-21T10:00:00.000Z"),
      }),
    );
    const original = await ingest(
      "sent",
      envelope({
        folder: "sent",
        messageId: `<headerless-original-${suffix}@example.test>`,
        subject: "Offer",
        from: supportAddress,
        to: [customer],
        date: new Date("2026-08-21T09:00:00.000Z"),
      }),
    );
    expect(await conversationOf(original)).toBe(await conversationOf(reply));

    // Newest first, a reply that already found its message claims no earlier one with the subject.
    const shop: Address = { name: "Shop", address: "orders@shop.example.test" };
    const answer = await ingest(
      "sent",
      envelope({
        folder: "sent",
        messageId: `<order-answer-${suffix}@example.test>`,
        subject: "Re: Order",
        from: supportAddress,
        to: [shop],
        date: new Date("2026-08-25T10:00:00.000Z"),
      }),
    );
    const secondOrder = await ingest(
      "inbox",
      envelope({
        folder: "inbox",
        messageId: `<order-2-${suffix}@shop.example.test>`,
        subject: "Order",
        from: shop,
        to: [supportAddress],
        date: new Date("2026-08-25T09:00:00.000Z"),
      }),
    );
    const firstOrder = await ingest(
      "inbox",
      envelope({
        folder: "inbox",
        messageId: `<order-1-${suffix}@shop.example.test>`,
        subject: "Order",
        from: shop,
        to: [supportAddress],
        date: new Date("2026-08-15T09:00:00.000Z"),
      }),
    );
    expect(await conversationOf(secondOrder)).toBe(await conversationOf(answer));
    expect(await conversationOf(firstOrder)).not.toBe(await conversationOf(answer));
  });

  test("a sender that reuses its Message-ID does not continue an old conversation", async () => {
    const notices: Address = { name: "Notices", address: "notices@example.test" };
    const fixedId = `<fixed-notice-${suffix}@example.test>`;
    const firstNotice = await ingest(
      "inbox",
      envelope({
        folder: "inbox",
        messageId: fixedId,
        subject: "Quarterly notice",
        from: notices,
        to: [supportAddress],
        date: new Date("2026-01-05T09:00:00.000Z"),
      }),
    );
    await ingest(
      "sent",
      envelope({
        folder: "sent",
        messageId: `<fixed-notice-reply-${suffix}@example.test>`,
        subject: "Re: Quarterly notice",
        from: supportAddress,
        to: [notices],
        date: new Date("2026-01-06T09:00:00.000Z"),
        inReplyTo: fixedId,
        references: [fixedId],
      }),
    );
    const nextNotice = await ingest(
      "inbox",
      envelope({
        folder: "inbox",
        messageId: fixedId,
        subject: "Quarterly notice",
        from: notices,
        to: [supportAddress],
        date: new Date("2026-04-05T09:00:00.000Z"),
      }),
    );
    expect(nextNotice).not.toBe(firstNotice);
    expect(await conversationOf(nextNotice)).not.toBe(await conversationOf(firstNotice));
  });

  test("a thread synchronized out of order becomes one conversation", async () => {
    const thread = (key: string) => {
      const original = `<thread-${key}-original-${suffix}@example.test>`;
      const ownReply = `<thread-${key}-own-reply-${suffix}@example.test>`;
      const theirReply = `<thread-${key}-their-reply-${suffix}@example.test>`;
      return {
        original: envelope({
          folder: "inbox",
          messageId: original,
          subject: `Contract ${key}`,
          from: customer,
          to: [supportAddress],
          date: new Date("2026-08-01T09:00:00.000Z"),
        }),
        ownReply: envelope({
          folder: "sent",
          messageId: ownReply,
          subject: `Re: Contract ${key}`,
          from: supportAddress,
          to: [customer],
          date: new Date("2026-08-03T09:00:00.000Z"),
          inReplyTo: original,
          references: [original],
        }),
        theirReply: envelope({
          folder: "inbox",
          messageId: theirReply,
          subject: `Re: Contract ${key}`,
          from: customer,
          to: [supportAddress],
          date: new Date("2026-08-06T09:00:00.000Z"),
          inReplyTo: ownReply,
          references: [original, ownReply],
        }),
      };
    };

    // Newest first across both folders: their reply, then the original, then the own reply.
    const first = thread("a");
    const theirReplyA = await ingest("inbox", first.theirReply);
    const originalA = await ingest("inbox", first.original);
    const ownReplyA = await ingest("sent", first.ownReply);
    const conversationA = await conversationOf(theirReplyA);
    expect(await conversationOf(originalA)).toBe(conversationA);
    expect(await conversationOf(ownReplyA)).toBe(conversationA);

    // Inbox first, then Sent: the original arrives last.
    const second = thread("b");
    const theirReplyB = await ingest("inbox", second.theirReply);
    const ownReplyB = await ingest("sent", second.ownReply);
    const originalB = await ingest("inbox", second.original);
    const conversationB = await conversationOf(theirReplyB);
    expect(await conversationOf(ownReplyB)).toBe(conversationB);
    expect(await conversationOf(originalB)).toBe(conversationB);
    expect(conversationB).not.toBe(conversationA);
  });

  test("separate replies to one message stay together when the message arrives last or never", async () => {
    const alice: Address = { name: "Alice", address: "alice@example.test" };
    const bob: Address = { name: "Bob", address: "bob@example.test" };
    const thread = (key: string) => {
      const original = `<branches-${key}-original-${suffix}@example.test>`;
      return {
        original: envelope({
          folder: "sent",
          messageId: original,
          subject: `Planning ${key}`,
          from: supportAddress,
          to: [alice, bob],
          date: new Date("2026-08-11T09:00:00.000Z"),
        }),
        // Each answers only the sender, so the two replies share no outside address.
        fromAlice: envelope({
          folder: "inbox",
          messageId: `<branches-${key}-alice-${suffix}@example.test>`,
          subject: `Re: Planning ${key}`,
          from: alice,
          to: [supportAddress],
          date: new Date("2026-08-12T09:00:00.000Z"),
          inReplyTo: original,
          references: [original],
        }),
        fromBob: envelope({
          folder: "inbox",
          messageId: `<branches-${key}-bob-${suffix}@example.test>`,
          subject: `Re: Planning ${key}`,
          from: bob,
          to: [supportAddress],
          date: new Date("2026-08-13T09:00:00.000Z"),
          inReplyTo: original,
          references: [original],
        }),
      };
    };

    // The Inbox synchronizes newest first before Sent.
    const first = thread("a");
    const fromBobA = await ingest("inbox", first.fromBob);
    const fromAliceA = await ingest("inbox", first.fromAlice);
    const originalA = await ingest("sent", first.original);
    const conversationA = await conversationOf(fromBobA);
    expect(await conversationOf(fromAliceA)).toBe(conversationA);
    expect(await conversationOf(originalA)).toBe(conversationA);

    // The mailbox never holds the original, and the replies arrive in order.
    const second = thread("b");
    const fromAliceB = await ingest("inbox", second.fromAlice, true);
    const fromBobB = await ingest("inbox", second.fromBob, true);
    expect(await conversationOf(fromBobB)).toBe(await conversationOf(fromAliceB));
    expect(await conversationOf(fromBobB)).not.toBe(conversationA);
  });
});
