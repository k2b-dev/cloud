import { afterAll, beforeAll, expect, test } from "bun:test";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { searchMessages } from "./search";
import { loadMailboxPageData, resolveWorkspaceRequest } from "./workspace";

const suite = suiteFor("database", "nats");

// What a list page shows: full pages of conversations, the unread state of single messages, and Send problems.
suite("mail message lists", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let userId = "";
  let context: MailRequestContext;
  let mailboxId = "";
  let resourceId = "";
  let uid = 0;

  const addFolder = async (name: string, role: string) => {
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resourceId}::uuid, ${`${name}-${suffix}`}, ${name}, ${role}, 'current')
      RETURNING id
    `;
    return folder!.id;
  };

  const addMessage = async (params: { subject: string; minutesAgo: number; folderId?: string; flags?: string[] }) => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text
      ) VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.test>`}, ${params.subject},
        ${params.subject.toLowerCase()}, now() - make_interval(mins => ${params.minutesAgo}), 128,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'complete', ${params.subject})
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${message!.id}::uuid, 'from', 0, 'Customer', 'customer@example.test', 'customer@example.test')
    `;
    if (params.folderId) {
      uid += 1;
      const [ref] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${params.folderId}::uuid, ${message!.id}::uuid, 1, ${uid})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
        VALUES (${ref!.id}::uuid, ${params.folderId}::uuid, ${message!.id}::uuid, ${toPgTextArray(params.flags ?? ["\\Seen"])}::text[], ARRAY[]::text[])
      `;
    }
    return message!.id;
  };

  const addConversation = async (params: { subject: string; minutesAgo: number; messageIds: string[]; workStatus?: string }) => {
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${params.subject}, 'Customer',
        now() - make_interval(mins => ${params.minutesAgo}), ${params.workStatus ?? "needs_action"})
      RETURNING id
    `;
    for (const [index, messageId] of params.messageIds.entries()) {
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${messageId}::uuid, ${index + 1}, 'headers')
      `;
    }
    return conversation!.id;
  };

  beforeAll(async () => {
    await migrate();
    const userUid = `mail-message-lists-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${userUid}, 'local', 'user', 'List Owner', false)
      RETURNING id
    `;
    userId = user!.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid: userUid,
          provider: "local",
          profile: "user",
          displayName: "List Owner",
          givenName: "List",
          sn: "Owner",
          mail: `${userUid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId },
      requestId: `mail-message-lists-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Message lists ${suffix}`, description: null });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"e".repeat(64)}, 'active')
      RETURNING id
    `;
    resourceId = resource!.id;
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      const accessIds = access.map((row) => row.access_id);
      if (accessIds.length > 0)
        await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("pages grouped search timestamps with microseconds and accepts legacy millisecond cursors", async () => {
    const folderId = await addFolder("Cursor", "inbox");
    const expected: string[] = [];
    const messageIds: string[] = [];
    try {
      for (const [index, micros] of [100, 200, 200, 300, 400].entries()) {
        const subject = `Grouped cursor precision ${index}`;
        const messageId = await addMessage({ subject, minutesAgo: index + 1, folderId });
        messageIds.push(messageId);
        const id = await addConversation({ subject, minutesAgo: index + 1, messageIds: [messageId] });
        expected.push(id);
        await sql`UPDATE mail.conversations SET latest_message_at = ${`2026-01-01T00:00:00.000${micros}Z`}::timestamptz WHERE id = ${id}::uuid`;
      }
      const page = (cursor?: string) =>
        searchMessages({
          context,
          mailboxId,
          groupByConversation: true,
          request: { expression: { type: "folder_id", folderId }, sort: "newest", limit: 2, cursor },
        });
      const first = await page();
      if (!first.ok) throw new Error(first.error.message);
      expect(first.data.nextCursor).not.toBeNull();
      const legacy = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(first.data.nextCursor!, "base64url").toString("utf8")),
          internalDate: "2027-01-01T00:00:00.000Z",
          id: crypto.randomUUID(),
        }),
      ).toString("base64url");
      const seen = first.data.items.map((item) => item.conversationId);
      let cursor = first.data.nextCursor ?? undefined;
      for (let index = 0; cursor && index < expected.length; index++) {
        const result = await page(cursor);
        if (!result.ok) throw new Error(result.error.message);
        seen.push(...result.data.items.map((item) => item.conversationId));
        expect(result.data.items.every((item) => item.latestMessageAt === "2026-01-01T00:00:00.000Z")).toBe(true);
        cursor = result.data.nextCursor ?? undefined;
      }
      expect(cursor).toBeUndefined();
      expect(seen.toSorted()).toEqual(expected.toSorted());
      expect(new Set(seen).size).toBe(expected.length);
      const result = await page(legacy);
      expect(result.ok && result.data.items.length).toBe(2);
    } finally {
      for (const id of expected) await sql`DELETE FROM mail.conversations WHERE id = ${id}::uuid`;
      for (const id of messageIds) await sql`DELETE FROM mail.message_contents WHERE id = ${id}::uuid`;
      await sql`DELETE FROM mail.folders WHERE id = ${folderId}::uuid`;
    }
  });

  // A conversation-only search must not spend page places on conversations the list cannot show:
  // one whose only copy was deleted in another client, and one that sits only in an excluded folder.
  test("fills every page of a conversation search and keeps the older matches reachable", async () => {
    const inboxId = await addFolder("Waiting", "inbox");
    const trashId = await addFolder("Trash", "trash");
    const deletedMessageId = await addMessage({ subject: "Deleted elsewhere", minutesAgo: 1, folderId: inboxId });
    await sql`UPDATE mail.message_placements SET deleted_at = now() WHERE message_id = ${deletedMessageId}::uuid`;
    await addConversation({ subject: "Deleted elsewhere", minutesAgo: 1, messageIds: [deletedMessageId], workStatus: "waiting" });
    const trashedMessageId = await addMessage({ subject: "Only in Trash", minutesAgo: 2, folderId: trashId });
    await addConversation({ subject: "Only in Trash", minutesAgo: 2, messageIds: [trashedMessageId], workStatus: "waiting" });
    const visible: string[] = [];
    for (const minutesAgo of [3, 4, 5]) {
      const messageId = await addMessage({ subject: `Visible ${minutesAgo}`, minutesAgo, folderId: inboxId });
      visible.push(await addConversation({ subject: `Visible ${minutesAgo}`, minutesAgo, messageIds: [messageId], workStatus: "waiting" }));
    }

    const page = (cursor?: string) =>
      searchMessages({
        context,
        mailboxId,
        request: { expression: { type: "work_status", value: "waiting" }, sort: "newest", limit: 2, cursor },
        excludedFolderIds: [trashId],
      });
    const first = await page();
    if (!first.ok) throw new Error(first.error.message);
    expect(first.data.items.map((item) => item.conversationId)).toEqual(visible.slice(0, 2));
    expect(first.data.nextCursor).not.toBeNull();
    const second = await page(first.data.nextCursor!);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.data.items.map((item) => item.conversationId)).toEqual(visible.slice(2));
    expect(second.data.nextCursor).toBeNull();
  });

  // Message mode lists single messages, so a message that belongs to a conversation keeps its own unread state.
  test("shows a threaded unread message as unread in message mode", async () => {
    const folderId = await addFolder("Support", "other");
    const unreadId = await addMessage({ subject: "Unread question", minutesAgo: 30, folderId, flags: [] });
    const readId = await addMessage({ subject: "Read answer", minutesAgo: 20, folderId });
    await addConversation({ subject: "Unread question", minutesAgo: 20, messageIds: [unreadId, readId] });
    const standaloneId = await addMessage({ subject: "Standalone", minutesAgo: 10, folderId, flags: [] });

    const result = await searchMessages({
      context,
      mailboxId,
      request: { expression: { type: "folder_id", folderId }, sort: "newest", limit: 10 },
      groupByConversation: false,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.items.map((item) => ({ id: item.id, unread: item.unread, unreadFolderIds: item.unreadFolderIds }))).toEqual([
      { id: standaloneId, unread: true, unreadFolderIds: [folderId] },
      { id: readId, unread: false, unreadFolderIds: [] },
      { id: unreadId, unread: true, unreadFolderIds: [folderId] },
    ]);
  });

  // A failed send never reached a folder. Send problems in message mode lists it, and only it.
  test("lists the failed message, and only it, in Send problems in message mode", async () => {
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret
      ) VALUES (
        ${mailboxId}::uuid, 'IMAP', 'team@example.test', 'team@example.test',
        'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls', 'password', 'fixture'
      ) RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator)
      VALUES (${resourceId}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb)
      RETURNING id
    `;
    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'team@example.test', 'Team')
      RETURNING id
    `;
    const inboxId = await addFolder("Received", "inbox");
    const questionId = await addMessage({ subject: "Order question", minutesAgo: 50, folderId: inboxId });
    const failedId = await addMessage({ subject: "Re: Order question", minutesAgo: 40 });
    const conversationId = await addConversation({ subject: "Order question", minutesAgo: 50, messageIds: [questionId, failedId] });
    const [draft] = await sql<{ id: string }[]>`
      INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, state)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${identity!.id}::uuid, 'user', ${userId}::uuid, 'user', ${userId}::uuid, 'sent')
      RETURNING id
    `;
    const [command] = await sql<{ id: string }[]>`
      INSERT INTO mail.commands (
        mailbox_id, kind, actor_kind, actor_id, idempotency_key, request_hash, target, payload,
        access_subject_kind, access_subject_id, credential_scopes
      ) VALUES (
        ${mailboxId}::uuid, 'send', 'user', ${userId}::uuid, ${`send-${suffix}`}, ${"f".repeat(64)},
        '{}'::jsonb, '{}'::jsonb, 'user', ${userId}::uuid, ARRAY[]::text[]
      ) RETURNING id
    `;
    await sql`
      INSERT INTO mail.outbox_submissions (
        short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id,
        stable_message_id, state, last_error_code, mime_date, message_id
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, ${draft!.id}::uuid, ${command!.id}::uuid, ${identity!.id}::uuid,
        ${binding!.id}::uuid, ${`<failed-${suffix}@example.test>`}, 'failed', 'SMTP_REJECTED', now(), ${failedId}::uuid
      )
    `;

    const load = async (listMode: "conversations" | "messages") => {
      const request = await resolveWorkspaceRequest(new URL(`https://cloud.example.test/app/mail/inbox?view=send_problems`), mailboxId);
      if (!request) throw new Error("Workspace request did not resolve");
      const page = await loadMailboxPageData({ context, mailboxId, ...request, listMode });
      if (!page.ok) throw new Error(page.error.message);
      return page.data;
    };
    const conversations = await load("conversations");
    expect(conversations.viewCounts.send_problems).toBe(1);
    expect(conversations.listItems.map((item) => item.conversationId)).toEqual([conversationId]);
    const messageList = await load("messages");
    expect(messageList.listError).toBeNull();
    expect(messageList.listItems.map((item) => ({ id: item.id, kind: item.selectionKind }))).toEqual([{ id: failedId, kind: "message" }]);
    expect(messageList.nextListCursor).toBeNull();
  });
});
