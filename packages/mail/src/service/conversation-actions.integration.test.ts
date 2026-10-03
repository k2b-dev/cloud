import { afterAll, beforeAll, expect, test } from "bun:test";
import { encryptSecret, toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { executeMutationCommand } from "./command-runtime";
import { getCommandOutcomes } from "./commands";
import { createMailbox } from "./mailboxes";
import { listConversations } from "./messages";
import { createConversationTriageCommands } from "./triage";

const suite = suiteFor("database", "nats");

// A question in the Inbox and the mailbox's newer reply in Sent: the conversation Archive acts on.
suite("mail conversation actions", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let userId = "";
  let context: MailRequestContext;
  let mailboxId = "";
  let bindingId = "";
  let resourceId = "";
  let inboxId = "";
  let sentId = "";
  let questionId = "";
  let conversationId = "";

  const addFolder = async (name: string, role: string) => {
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resourceId}::uuid, ${`${name}-${suffix}`}, ${name}, ${role}, 'current')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
      ) VALUES (
        ${bindingId}::uuid, ${folder!.id}::uuid, ${name}, 1, 2,
        ARRAY['read', 'write_flags', 'insert', 'move', 'delete_messages']::text[], now()
      )
    `;
    return folder!.id;
  };

  const addCopy = async (params: { messageId: string; folderId: string; uid: number; flags: string[] }) => {
    const [ref] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${params.folderId}::uuid, ${params.messageId}::uuid, 1, ${params.uid})
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${ref!.id}::uuid, ${params.folderId}::uuid, ${params.messageId}::uuid, ${toPgTextArray(params.flags)}::text[], ARRAY[]::text[])
    `;
    return ref!.id;
  };

  const addConversation = async (subject: string, messageIds: string[]) => {
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, 'customer@example.test', now(), 'needs_action')
      RETURNING id
    `;
    for (const [index, messageId] of messageIds.entries()) {
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${messageId}::uuid, ${index + 1}, 'headers')
      `;
    }
    return conversation!.id;
  };

  const commandRefs = async (correlationId: string) =>
    (
      await sql<{ ref_id: string }[]>`
        SELECT command.target ->> 'remoteMessageRefId' AS ref_id
        FROM mail.commands command
        WHERE command.correlation_id = ${correlationId}
        ORDER BY ref_id
      `
    ).map((row) => row.ref_id);

  const placementFlags = async (refId: string) =>
    (await sql<{ flags: string[] }[]>`SELECT flags FROM mail.message_placements WHERE remote_message_ref_id = ${refId}::uuid`)[0]!.flags;

  const addMessage = async (params: { folderId: string; subject: string; minutesAgo: number; uid?: number; flags?: string[] }) => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text
      ) VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.test>`}, ${params.subject},
        ${params.subject.toLowerCase()}, now() - make_interval(mins => ${params.minutesAgo}), 128,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'complete', ${params.subject})
      RETURNING id
    `;
    await addCopy({ messageId: message!.id, folderId: params.folderId, uid: params.uid ?? 1, flags: params.flags ?? ["\\Seen"] });
    return message!.id;
  };

  beforeAll(async () => {
    await migrate();
    const uid = `mail-conversation-actions-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Action Owner', false)
      RETURNING id
    `;
    userId = user!.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid,
          provider: "local",
          profile: "user",
          displayName: "Action Owner",
          givenName: "Action",
          sn: "Owner",
          mail: `${uid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId },
      requestId: `mail-conversation-actions-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Conversation actions ${suffix}`, description: null });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;

    const scope = "d".repeat(64);
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
        authenticated_principal, capabilities, server_identity, last_verified_at
      ) VALUES (
        ${mailboxId}::uuid, 'IMAP', 'team@example.test', 'team@example.test',
        'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls',
        'password', ${await encryptSecret({ kind: "password", password: "conversation-actions-secret" })},
        'team@example.test', '{}'::jsonb, '{}'::jsonb, now()
      ) RETURNING id
    `;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${scope}, 'active')
      RETURNING id
    `;
    resourceId = resource!.id;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator, capabilities, rights,
        verification_evidence, verified_scope_fingerprint, last_verified_at
      ) VALUES (
        ${resourceId}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, ${scope}, now()
      ) RETURNING id
    `;
    bindingId = binding!.id;
    inboxId = await addFolder("INBOX", "inbox");
    sentId = await addFolder("Sent", "sent");
    await addFolder("Archive", "archive");

    questionId = await addMessage({ folderId: inboxId, subject: "Delivery question", minutesAgo: 60 });
    const replyId = await addMessage({ folderId: sentId, subject: "Re: Delivery question", minutesAgo: 5 });
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Delivery question', 'customer@example.test', now(), 'needs_action')
      RETURNING id
    `;
    conversationId = conversation!.id;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversationId}::uuid, ${questionId}::uuid, 1, 'headers'), (${conversationId}::uuid, ${replyId}::uuid, 2, 'headers')
    `;
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

  test("archives from the folder in view, not from the folder of the newest reply", async () => {
    const inbox = await listConversations({ context, mailboxId, folderId: inboxId });
    if (!inbox.ok) throw new Error(inbox.error.message);
    const [row] = inbox.data.items;
    expect(row).toMatchObject({ id: conversationId, folderId: inboxId, activeFolderIds: [inboxId] });

    // A view across folders names a source only when the conversation sits in one folder.
    const all = await listConversations({ context, mailboxId });
    if (!all.ok) throw new Error(all.error.message);
    expect(all.data.items.find((item) => item.id === conversationId)).toMatchObject({
      folderId: null,
      activeFolderIds: [inboxId, sentId].sort(),
    });

    const archived = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId,
      input: { kind: "move_to_role", sourceFolderId: row!.folderId!, role: "archive", idempotencyKey: `archive-${suffix}` },
    });
    if (!archived.ok) throw new Error(archived.error.message);
    const moved = await sql<{ source: string; message_id: string }[]>`
      SELECT command.target ->> 'sourceFolderId' AS source, ref.message_id
      FROM mail.commands command
      JOIN mail.remote_message_refs ref ON ref.id = (command.target ->> 'remoteMessageRefId')::uuid
      WHERE command.correlation_id = ${archived.data.correlationId}
    `;
    expect(moved).toEqual([{ source: inboxId, message_id: questionId }]);
  });

  test("reports the state of queued commands so the workspace can tell when one failed", async () => {
    const read = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId,
      input: {
        kind: "change_state",
        sourceFolderId: inboxId,
        change: { addFlags: ["flagged"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: `flag-${suffix}`,
      },
    });
    if (!read.ok) throw new Error(read.error.message);
    const [command] = read.data.commands;
    await sql`
      UPDATE mail.commands
      SET state = 'failed', last_error_code = 'REMOTE_MESSAGE_MISSING', finished_at = now()
      WHERE id = ${command!.id}::uuid
    `;

    const unknownId = crypto.randomUUID();
    const outcomes = await getCommandOutcomes(context, mailboxId, [command!.id, unknownId, command!.id]);
    expect(outcomes).toEqual({ ok: true, data: [{ id: command!.id, state: "failed", code: "REMOTE_MESSAGE_MISSING" }] });
  });

  // A message list shows one row per message, so an action on one row must leave the other messages of its
  // conversation alone, even in the same folder and even when they are not in the list.
  test("acts only on the chosen messages of a conversation", async () => {
    const chosenId = await addMessage({ folderId: inboxId, subject: "Chosen row", minutesAgo: 30, uid: 10, flags: [] });
    const otherId = await addMessage({ folderId: inboxId, subject: "Re: Chosen row", minutesAgo: 20, uid: 11, flags: [] });
    const chosenConversationId = await addConversation("Chosen row", [chosenId, otherId]);
    const [chosenRef, otherRef] = await sql<{ id: string }[]>`
      SELECT id FROM mail.remote_message_refs WHERE folder_id = ${inboxId}::uuid AND uid IN (10, 11) ORDER BY uid
    `;

    const read = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId: chosenConversationId,
      input: {
        kind: "change_state",
        sourceFolderId: inboxId,
        messageIds: [chosenId],
        change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: `chosen-read-${suffix}`,
      },
    });
    if (!read.ok) throw new Error(read.error.message);
    expect(await commandRefs(read.data.correlationId)).toEqual([chosenRef!.id]);
    expect(await placementFlags(chosenRef!.id)).toEqual(["\\Seen"]);
    expect(await placementFlags(otherRef!.id)).toEqual([]);

    const archived = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId: chosenConversationId,
      input: {
        kind: "move_to_role",
        sourceFolderId: inboxId,
        messageIds: [chosenId],
        role: "archive",
        idempotencyKey: `chosen-archive-${suffix}`,
      },
    });
    if (!archived.ok) throw new Error(archived.error.message);
    expect(await commandRefs(archived.data.correlationId)).toEqual([chosenRef!.id]);

    // A message of another conversation is not a message of this one.
    const foreign = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId: chosenConversationId,
      input: {
        kind: "change_state",
        sourceFolderId: inboxId,
        messageIds: [questionId],
        change: { addFlags: ["flagged"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: `chosen-foreign-${suffix}`,
      },
    });
    expect(foreign.ok).toBe(false);
  });

  // The same message delivered twice into one folder is one message with two provider copies.
  test("changes every copy of a message in the folder", async () => {
    const twiceId = await addMessage({ folderId: inboxId, subject: "Delivered twice", minutesAgo: 15, uid: 20, flags: [] });
    const secondCopy = await addCopy({ messageId: twiceId, folderId: inboxId, uid: 21, flags: [] });
    const [firstCopy] = await sql<{ id: string }[]>`
      SELECT id FROM mail.remote_message_refs WHERE folder_id = ${inboxId}::uuid AND uid = 20
    `;
    const twiceConversationId = await addConversation("Delivered twice", [twiceId]);

    const read = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId: twiceConversationId,
      input: {
        kind: "change_state",
        sourceFolderId: inboxId,
        change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: `twice-read-${suffix}`,
      },
    });
    if (!read.ok) throw new Error(read.error.message);
    expect(await commandRefs(read.data.correlationId)).toEqual([firstCopy!.id, secondCopy].sort());
    expect(await placementFlags(firstCopy!.id)).toEqual(["\\Seen"]);
    expect(await placementFlags(secondCopy)).toEqual(["\\Seen"]);

    const archived = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId: twiceConversationId,
      input: { kind: "move_to_role", sourceFolderId: inboxId, role: "archive", idempotencyKey: `twice-archive-${suffix}` },
    });
    if (!archived.ok) throw new Error(archived.error.message);
    expect(await commandRefs(archived.data.correlationId)).toEqual([firstCopy!.id, secondCopy].sort());
  });

  // Mark read, then Flag, queued on an unread message; both fail before the mail server changed anything.
  test("undoes two failed changes back to the state the mail server has", async () => {
    const unreadId = await addMessage({ folderId: inboxId, subject: "Fails twice", minutesAgo: 10, uid: 30, flags: [] });
    const [ref] = await sql<{ id: string }[]>`SELECT id FROM mail.remote_message_refs WHERE folder_id = ${inboxId}::uuid AND uid = 30`;
    const unreadConversationId = await addConversation("Fails twice", [unreadId]);
    const change = async (flag: "seen" | "flagged") => {
      const result = await createConversationTriageCommands({
        context,
        mailboxId,
        conversationId: unreadConversationId,
        input: {
          kind: "change_state",
          sourceFolderId: inboxId,
          change: { addFlags: [flag], removeFlags: [], addKeywords: [], removeKeywords: [] },
          idempotencyKey: `fails-${flag}-${suffix}`,
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.data.commands[0]!.id;
    };
    const read = await change("seen");
    const flag = await change("flagged");
    expect(await placementFlags(ref!.id)).toEqual(["\\Flagged", "\\Seen"]);

    const [mailbox] = await sql<{ health: string }[]>`SELECT health FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    await sql`UPDATE mail.mailboxes SET health = 'auth_required' WHERE id = ${mailboxId}::uuid`;
    try {
      expect(await executeMutationCommand(read)).toBe("failed");
      expect(await placementFlags(ref!.id)).toEqual(["\\Flagged"]);
      expect(await executeMutationCommand(flag)).toBe("failed");
      expect(await placementFlags(ref!.id)).toEqual([]);
    } finally {
      await sql`UPDATE mail.mailboxes SET health = ${mailbox!.health} WHERE id = ${mailboxId}::uuid`;
    }
  });
});
