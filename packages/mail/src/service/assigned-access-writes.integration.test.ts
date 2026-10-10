import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { notifications } from "@k2b/cloud/services";
import { type Result, unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import { mailConversationContextQuerySchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import * as collaboration from "./collaboration";
import { currentMailboxUserIds, hasCurrentMailboxUserPermission } from "./collaborators";
import { commandStillAuthorized, type StoredCommandAuthorization } from "./command-authorization";
import { executeMutationCommand } from "./command-runtime";
import * as commands from "./commands";
import { reviewDraftComposeSafety } from "./compose-safety";
import * as compose from "./compose-templates";
import { getConversationContext } from "./conversation-context";
import { updateConversationSummary } from "./conversation-summary";
import * as conversations from "./conversations";
import * as leases from "./draft-leases";
import * as uploads from "./draft-uploads";
import * as drafts from "./drafts";
import * as tags from "./local-tags";
import { createMailbox } from "./mailboxes";
import * as presence from "./presence";
import * as reminders from "./reminders";
import * as scheduled from "./scheduled-sends";
import { notifySendWaitingForLogin } from "./send-login-notifications";
import { createConversationTriageCommands } from "./triage";

const suite = suiteFor("database", "nats", "valkey");
const denied = (result: Result<unknown>, status: 403 | 404 | 409) => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(status);
};
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: `assigned-writes-${user.id}`,
});

suite("assigned-only Mail actions authorize every target and queued effect", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let owner: User;
  let writer: User;
  let reader: User;
  let groupId = "";
  let grantId = "";
  let mailboxId = "";
  let mailboxShortId = "";
  let resourceId = "";
  let bindingId = "";
  let inboxId = "";
  let archiveId = "";
  let identityId = "";
  let tagId = "";
  type Conversation = { id: string; shortId: string; messageId: string; refId: string };
  let c1: Conversation;
  let c2: Conversation;
  let hiddenDraftId = "";
  let hiddenAttachmentId = "";
  let hiddenUploadId = "";
  const params = (user: User, conversation = c1) => ({ context: contextFor(user), mailboxId, conversationId: conversation.id });
  const draftInput = (conversation = c1) => ({
    senderIdentityId: identityId,
    conversationId: conversation.id,
    sourceMessageId: conversation.messageId,
    intent: "reply" as const,
    to: [],
    cc: [],
    bcc: [],
    subject: "Re: Test",
    body: "A reply",
    format: "plain" as const,
  });
  const editableInput = (body = "A reply") => ({
    senderIdentityId: identityId,
    to: [{ address: "customer@example.test", name: null }],
    cc: [],
    bcc: [],
    subject: "Re: Test",
    body,
    format: "plain" as const,
  });
  const createReply = (user = writer, conversation = c1) =>
    drafts.createDraft({ context: contextFor(user), mailboxId, input: draftInput(conversation) });
  const stored = async (id: string): Promise<StoredCommandAuthorization> => {
    const [row] = await sql<StoredCommandAuthorization[]>`SELECT * FROM mail.commands WHERE id = ${id}::uuid`;
    if (!row) throw new Error("Command fixture missing");
    return row;
  };
  const queueState = (user = writer, conversation = c1) =>
    commands.createActorCommand({
      context: contextFor(user),
      mailboxId,
      enqueue: false,
      input: {
        kind: "set_flags",
        messageId: conversation.messageId,
        folderId: inboxId,
        flags: ["\\Seen"],
        idempotencyKey: crypto.randomUUID(),
      },
    });
  const queueSend = (user: User, draft: { id: string; revision: number; senderIdentityId: string }) =>
    commands.createActorCommand({
      context: contextFor(user),
      mailboxId,
      enqueue: false,
      input: {
        kind: "send",
        draftId: draft.id,
        expectedDraftRevision: draft.revision,
        senderIdentityId: draft.senderIdentityId,
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
        undoSeconds: 0,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  const capContext = (user: User): CapabilityExecutionContext => ({
    ...contextFor(user),
    user,
    locale: "en",
    requestId: `assigned-cap-${suffix}`,
    origin: "assistant",
    signal: AbortSignal.timeout(30000),
  });
  const createUser = async (role: string): Promise<User> => {
    const uid = `mail-assigned-writes-${role}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${role}, false) RETURNING id
    `;
    if (!row) throw new Error("User fixture was not created");
    userIds.push(row.id);
    return {
      id: row.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: role,
      sn: "Test",
      displayName: role,
      mail: `${uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
  };

  const createConversation = async (position: number): Promise<Conversation> => {
    const shortId = newShortId();
    const [conversation] = await sql<
      { id: string }[]
    >`INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at) VALUES (${shortId}, ${mailboxId}::uuid, 'Test', 'Customer', now()) RETURNING id`;
    const [message] = await sql<
      { id: string }[]
    >`INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text) VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<assigned-${suffix}-${position}@example.test>`}, 'Test', 'test', now(), 4, ${String(position).repeat(64)}, 'complete', 'Body') RETURNING id`;
    if (!conversation || !message) throw new Error("Conversation fixture missing");
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position) VALUES (${conversation.id}::uuid, ${message.id}::uuid, 0)`;
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email) VALUES (${message.id}::uuid, 'from', 0, 'customer@example.test', 'customer@example.test')`;
    const [ref] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid) VALUES (${inboxId}::uuid, ${message.id}::uuid, 1, ${position}) RETURNING id`;
    if (!ref) throw new Error("Message fixture missing");
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id) VALUES (${ref.id}::uuid, ${inboxId}::uuid, ${message.id}::uuid)`;
    return { id: conversation.id, shortId, messageId: message.id, refId: ref.id };
  };
  const assignWriter = (mode: "add" | "remove") =>
    collaboration.applyConversationAssignments({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [c1.shortId],
      assigneeUserIds: [writer.id],
      mode,
    });
  const grantWriter = () =>
    grantMailboxAccess({
      context: contextFor(owner),
      mailboxId,
      principal: { type: "group", groupId },
      permission: "write",
      scope: "assigned",
    });

  beforeAll(async () => {
    await migrate();
    owner = await createUser("owner");
    writer = await createUser("W");
    reader = await createUser("A");
    mailboxId = unwrap(await createMailbox(contextFor(owner), { name: `Assigned writes ${suffix}` })).id;
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (!mailbox) throw new Error("Mailbox fixture missing");
    mailboxShortId = mailbox.short_id;
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups (cn, provider, name) VALUES (${`assigned-writes-${suffix}`}, 'local', 'Assigned writers') RETURNING id`;
    if (!group) throw new Error("Group fixture missing");
    groupId = group.id;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${writer.id}::uuid, ${groupId}::uuid)`;
    grantId = unwrap(await grantWriter()).id;
    unwrap(
      await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: reader.id },
        permission: "read",
        scope: "assigned",
      }),
    );
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status) VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}, 'active') RETURNING id`;
    if (!resource) throw new Error("Resource fixture missing");
    resourceId = resource.id;
    const [connection] = await sql<
      { id: string }[]
    >`INSERT INTO mail.provider_connections (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, status) VALUES (${mailboxId}::uuid, 'Authorization only', 'team@example.test', 'team@example.test', 'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls', 'password', 'not-a-provider-credential', 'active') RETURNING id`;
    if (!connection) throw new Error("Connection fixture missing");
    const [binding] = await sql<
      { id: string }[]
    >`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator, verified_scope_fingerprint, verified_secret_revision, last_verified_at) VALUES (${resourceId}::uuid, ${connection.id}::uuid, 'active', '{}'::jsonb, ${"f".repeat(64)}, 1, now()) RETURNING id`;
    if (!binding) throw new Error("Binding fixture missing");
    bindingId = binding.id;
    const folders: string[] = [];
    for (const [name, role] of [
      ["Inbox", "inbox"],
      ["Archive", "archive"],
    ]) {
      const [folder] = await sql<
        { id: string }[]
      >`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status) VALUES (${newShortId()}, ${resourceId}::uuid, ${name}, ${name}, ${role}, 'current') RETURNING id`;
      if (!folder) throw new Error("Folder fixture missing");
      folders.push(folder.id);
      await sql`INSERT INTO mail.binding_folder_refs (binding_id, folder_id, remote_path, uid_validity, effective_rights, rights_source, last_verified_at) VALUES (${bindingId}::uuid, ${folder.id}::uuid, ${name}, 1, ARRAY['read','write_flags','insert','move','delete_messages']::text[], 'acl', now())`;
    }
    [inboxId, archiveId] = [folders[0]!, folders[1]!];
    const [identity] = await sql<
      { id: string }[]
    >`INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label, status) VALUES (${newShortId()}, ${mailboxId}::uuid, 'team@example.test', 'Team', 'verified') RETURNING id`;
    if (!identity) throw new Error("Identity fixture missing");
    identityId = identity.id;
    await sql`INSERT INTO mail.sender_identity_bindings (sender_identity_id, binding_id, provider_principal, verified_at, saves_sent_automatically, verified_secret_revision) VALUES (${identityId}::uuid, ${bindingId}::uuid, 'team@example.test', now(), true, 1)`;
    await sql`UPDATE mail.mailboxes SET health = 'active', sync_enabled = true WHERE id = ${mailboxId}::uuid`;
    c1 = await createConversation(1);
    c2 = await createConversation(2);
    unwrap(
      await collaboration.applyConversationAssignments({
        context: contextFor(owner),
        mailboxId,
        conversationIds: [c1.shortId],
        assigneeUserIds: [writer.id, reader.id],
        mode: "replace",
      }),
    );
    tagId = unwrap(await tags.createLocalTag({ context: contextFor(owner), mailboxId, input: { name: "Priority", color: "#336699" } })).id;
    let draft = unwrap(await createReply(owner, c2));
    hiddenDraftId = draft.id;
    const unfinished = unwrap(
      await uploads.createDraftAttachmentUpload({
        context: contextFor(owner),
        mailboxId,
        draftId: draft.id,
        input: { filename: "unfinished.txt", contentType: "text/plain", byteLength: 1 },
      }),
    );
    hiddenUploadId = unfinished.id;
    unwrap(
      await uploads.cancelDraftAttachmentUpload({ context: contextFor(owner), mailboxId, draftId: draft.id, uploadId: unfinished.id }),
    );
    draft = unwrap(
      await uploads.uploadDraftAttachmentStream({
        context: contextFor(owner),
        mailboxId,
        draftId: draft.id,
        expectedRevision: draft.revision,
        filename: "hidden.txt",
        contentType: "text/plain",
        byteLength: 1,
        stream: Readable.from([Buffer.from("x")]),
      }),
    );
    hiddenAttachmentId = draft.attachments[0]!.id;
  });

  afterAll(async () => {
    if (mailboxId) {
      await sql`DELETE FROM mail.outbox_submissions WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    await sql`DELETE FROM auth.access WHERE user_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb)) OR group_id = ${groupId || null}::uuid`;
    if (groupId) await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  });

  test("assigned group writers queue read, flag, move, copy and delete only for visible messages", async () => {
    const common = { context: contextFor(writer), mailboxId, enqueue: false };
    for (const conversation of [c1, c2]) {
      const inputs = [
        { kind: "set_flags" as const, messageId: conversation.messageId, folderId: inboxId, flags: ["\\Seen"] },
        {
          kind: "change_message_state" as const,
          messageId: conversation.messageId,
          folderId: inboxId,
          change: { addFlags: ["flagged" as const], removeFlags: [], addKeywords: [], removeKeywords: [] },
        },
        { kind: "move" as const, messageId: conversation.messageId, sourceFolderId: inboxId, destinationFolderId: archiveId },
        { kind: "copy" as const, messageId: conversation.messageId, sourceFolderId: inboxId, destinationFolderId: archiveId },
        { kind: "delete" as const, messageId: conversation.messageId, folderId: inboxId },
      ];
      for (const input of inputs) {
        const result = await commands.createActorCommand({ ...common, input: { ...input, idempotencyKey: crypto.randomUUID() } });
        if (conversation === c2) denied(result, 404);
        else expect(await commandStillAuthorized(await stored(unwrap(result).id), "write")).toBe(true);
      }
    }
    denied(await queueState(reader), 403);
    const triage = {
      kind: "change_state" as const,
      sourceFolderId: inboxId,
      change: { addFlags: ["seen" as const], removeFlags: [], addKeywords: [], removeKeywords: [] },
      idempotencyKey: crypto.randomUUID(),
    };
    expect((await createConversationTriageCommands({ ...params(writer), input: triage })).ok).toBe(true);
    denied(
      await createConversationTriageCommands({ ...params(writer, c2), input: { ...triage, idempotencyKey: crypto.randomUUID() } }),
      404,
    );
    denied(
      await createConversationTriageCommands({
        ...params(writer),
        input: { ...triage, messageIds: [c2.messageId], idempotencyKey: crypto.randomUUID() },
      }),
      404,
    );
  });

  test("completion, snooze, comments, existing tags, reminders, presence and summary follow visibility", async () => {
    let current = unwrap(await collaboration.getConversationCollaboration(params(writer)));
    current = unwrap(
      await collaboration.applyConversationCollaboration({
        ...params(writer),
        input: { expectedRevision: current.revision, completion: "done" },
      }),
    ).collaboration;
    // A done conversation cannot be snoozed; reopening is completion too.
    current = unwrap(
      await collaboration.applyConversationCollaboration({
        ...params(writer),
        input: { expectedRevision: current.revision, completion: "open" },
      }),
    ).collaboration;
    current = unwrap(
      await collaboration.applyConversationCollaboration({
        ...params(writer),
        input: { expectedRevision: current.revision, snoozedUntil: new Date(Date.now() + 3600000).toISOString() },
      }),
    ).collaboration;
    denied(
      await collaboration.applyConversationCollaboration({
        ...params(writer),
        input: { expectedRevision: current.revision, assigneeUserIds: [writer.id, reader.id] },
      }),
      403,
    );
    denied(await assignAsWriter(), 403);
    denied(
      await collaboration.applyConversationCollaboration({ ...params(writer, c2), input: { expectedRevision: 1, completion: "done" } }),
      404,
    );
    denied(
      await collaboration.applyConversationCollaboration({
        ...params(reader),
        input: { expectedRevision: current.revision, completion: "done" },
      }),
      403,
    );
    const tagged = unwrap(
      await tags.setConversationLocalTags({ ...params(writer), input: { expectedRevision: current.revision, tagIds: [tagId] } }),
    );
    expect(tagged.tags.map((tag) => tag.id)).toEqual([tagId]);
    denied(
      await tags.addConversationLocalTags({ context: contextFor(writer), mailboxId, input: { conversationIds: [c1.id], tagIds: [tagId] } }),
      403,
    );
    denied(await tags.setConversationLocalTags({ ...params(writer, c2), input: { expectedRevision: 1, tagIds: [tagId] } }), 404);
    denied(await tags.setConversationLocalTags({ ...params(reader), input: { expectedRevision: current.revision, tagIds: [tagId] } }), 403);
    const comment = unwrap(
      await collaboration.createConversationComment({ ...params(writer), input: { body: "Internal", referencedMessageId: c1.messageId } }),
    );
    const edited = unwrap(
      await collaboration.updateConversationComment({
        ...params(writer),
        commentId: comment.id,
        input: { expectedRevision: comment.revision, body: "Edited" },
      }),
    );
    expect(
      (
        await collaboration.deleteConversationComment({
          ...params(writer),
          commentId: comment.id,
          input: { expectedRevision: edited.revision },
        })
      ).ok,
    ).toBe(true);
    denied(await collaboration.createConversationComment({ ...params(writer, c2), input: { body: "Hidden" } }), 404);
    const hiddenComment = unwrap(await collaboration.createConversationComment({ ...params(owner, c2), input: { body: "Private" } }));
    denied(
      await collaboration.updateConversationComment({
        ...params(writer, c2),
        commentId: hiddenComment.id,
        input: { expectedRevision: hiddenComment.revision, body: "Changed" },
      }),
      404,
    );
    denied(
      await collaboration.deleteConversationComment({
        ...params(writer, c2),
        commentId: hiddenComment.id,
        input: { expectedRevision: hiddenComment.revision },
      }),
      404,
    );
    denied(
      await collaboration.createConversationComment({
        ...params(writer),
        input: { body: "Hidden reference", referencedMessageId: c2.messageId },
      }),
      404,
    );
    // Comments have always required read; assigned readers retain the same personal collaboration right.
    expect((await collaboration.createConversationComment({ ...params(reader), input: { body: "Reader comment" } })).ok).toBe(true);
    const reminder = unwrap(
      await reminders.setConversationReminder({
        ...params(reader),
        input: { expectedRevision: null, dueAt: new Date(Date.now() + 86400000).toISOString() },
      }),
    );
    expect((await reminders.cancelConversationReminder({ ...params(reader), input: { expectedRevision: reminder.revision } })).ok).toBe(
      true,
    );
    denied(
      await reminders.setConversationReminder({
        ...params(reader, c2),
        input: { expectedRevision: null, dueAt: new Date(Date.now() + 86400000).toISOString() },
      }),
      404,
    );
    const peerId = crypto.randomUUID();
    const present = unwrap(await presence.heartbeatConversationPresence({ ...params(reader), input: { peerId, mode: "viewing" } }));
    expect(present.participants.some((person) => person.userId === reader.id)).toBe(true);
    expect((await presence.leaveConversationPresence({ ...params(reader), peerId })).ok).toBe(true);
    denied(await presence.heartbeatConversationPresence({ ...params(reader, c2), input: { peerId, mode: "viewing" } }), 404);
    denied(await presence.heartbeatConversationPresence({ ...params(reader), input: { peerId, mode: "composing" } }), 403);
    expect(
      (await updateConversationSummary({ ...params(writer), input: { expectedSummaryRevision: 1, summary: "Shared summary" } })).ok,
    ).toBe(true);
    denied(await updateConversationSummary({ ...params(writer, c2), input: { expectedSummaryRevision: 1, summary: "Hidden" } }), 404);
    denied(await updateConversationSummary({ ...params(reader), input: { expectedSummaryRevision: 2, summary: "Reader write" } }), 403);
  });
  const assignAsWriter = () =>
    collaboration.applyConversationAssignments({
      context: contextFor(writer),
      mailboxId,
      conversationIds: [c1.shortId],
      assigneeUserIds: [writer.id],
      mode: "replace",
    });

  test("visible reply drafts support updates, leases, recovery, attachments and scheduled send", async () => {
    expect(
      unwrap(await drafts.createDraft({ context: contextFor(writer), mailboxId, input: { ...draftInput(), intent: undefined } })).intent,
    ).toBe("reply");
    for (const intent of ["reply_all", "forward"] as const) {
      const created = unwrap(await drafts.createDraft({ context: contextFor(writer), mailboxId, input: { ...draftInput(), intent } }));
      expect(created.conversationId).toBe(c1.id);
      expect(created.intent).toBe(intent);
    }
    let draft = unwrap(await createReply());
    expect(unwrap(await drafts.getDraft(contextFor(writer), mailboxId, draft.id)).conversationId).toBe(c1.id);
    const lease = unwrap(await leases.acquireDraftLease({ context: contextFor(writer), mailboxId, draftId: draft.id }));
    expect((await leases.heartbeatDraftLease({ context: contextFor(writer), mailboxId, draftId: draft.id, token: lease.token })).ok).toBe(
      true,
    );
    expect((await leases.releaseDraftLease({ context: contextFor(writer), mailboxId, draftId: draft.id, token: lease.token })).ok).toBe(
      true,
    );
    draft = unwrap(
      await drafts.updateDraft({
        context: contextFor(writer),
        mailboxId,
        draftId: draft.id,
        expectedRevision: draft.revision,
        input: editableInput("Updated"),
      }),
    );
    denied(
      await drafts.updateDraft({
        context: contextFor(writer),
        mailboxId,
        draftId: draft.id,
        expectedRevision: 1,
        input: editableInput("Recovery"),
      }),
      409,
    );
    const copies = unwrap(await drafts.listDraftRecoveryCopies({ context: contextFor(writer), mailboxId, draftId: draft.id }));
    expect(copies).toHaveLength(1);
    const recoveryLease = unwrap(await leases.acquireDraftLease({ context: contextFor(writer), mailboxId, draftId: draft.id }));
    draft = unwrap(
      await drafts.restoreDraftRecoveryCopy({
        context: contextFor(writer),
        mailboxId,
        draftId: draft.id,
        recoveryCopyId: copies[0]!.id,
        expectedRevision: draft.revision,
        leaseToken: recoveryLease.token,
      }),
    );
    unwrap(await leases.releaseDraftLease({ context: contextFor(writer), mailboxId, draftId: draft.id, token: recoveryLease.token }));
    draft = unwrap(
      await uploads.uploadDraftAttachmentStream({
        context: contextFor(writer),
        mailboxId,
        draftId: draft.id,
        expectedRevision: draft.revision,
        filename: "reply.txt",
        contentType: "text/plain",
        byteLength: 5,
        stream: Readable.from([Buffer.from("hello")]),
      }),
    );
    const attachment = draft.attachments[0]!;
    expect(
      unwrap(await drafts.openDraftAttachment({ context: contextFor(writer), mailboxId, draftId: draft.id, attachmentId: attachment.id }))
        .total,
    ).toBe(5);
    expect(
      (await reviewDraftComposeSafety({ context: contextFor(writer), mailboxId, draftId: draft.id, expectedRevision: draft.revision })).ok,
    ).toBe(true);
    denied(await queueSend(reader, draft), 403);
    const command = unwrap(await queueSend(writer, draft));
    expect(await commandStillAuthorized(await stored(command.id), "write")).toBe(true);
    expect(unwrap(await commands.getCommand(contextFor(writer), mailboxId, command.id)).id).toBe(command.id);
    expect((await scheduled.cancelSendCommand({ context: contextFor(writer), mailboxId, commandId: command.id })).ok).toBe(true);
    draft = unwrap(await drafts.getDraft(contextFor(writer), mailboxId, draft.id));
    draft = unwrap(
      await drafts.removeDraftAttachment({
        context: contextFor(writer),
        mailboxId,
        draftId: draft.id,
        attachmentId: attachment.id,
        expectedRevision: draft.revision,
      }),
    );
    expect(
      (await drafts.discardDraft({ context: contextFor(writer), mailboxId, draftId: draft.id, expectedRevision: draft.revision })).ok,
    ).toBe(true);
    const seed = unwrap(
      await drafts.prepareDraftSeed({ context: contextFor(writer), mailboxId, origin: { kind: "compose", input: draftInput() } }),
    );
    const input = { idempotencyKey: crypto.randomUUID(), origin: seed.origin, draft: seed.content };
    const materialized = unwrap(await drafts.materializeDraftSeed({ context: contextFor(writer), mailboxId, input }));
    unwrap(await assignWriter("remove"));
    try {
      denied(await drafts.materializeDraftSeed({ context: contextFor(writer), mailboxId, input }), 404);
      denied(await leases.acquireDraftLease({ context: contextFor(writer), mailboxId, draftId: materialized.id }), 404);
    } finally {
      unwrap(await assignWriter("add"));
    }
  });

  test("hidden drafts and all their subresources look absent; new and derived drafts remain forbidden", async () => {
    const base = { context: contextFor(writer), mailboxId, draftId: hiddenDraftId };
    denied(await createReply(writer, c2), 404);
    denied(await createReply(reader), 403);
    denied(
      await drafts.createDraft({
        context: contextFor(writer),
        mailboxId,
        input: { ...draftInput(), intent: "new", conversationId: null, sourceMessageId: null },
      }),
      403,
    );
    denied(
      await drafts.deriveDraftFromMessage({
        context: contextFor(writer),
        mailboxId,
        messageId: c1.messageId,
        input: { kind: "resend", senderIdentityId: identityId, includeAttachments: false, idempotencyKey: crypto.randomUUID() },
      }),
      403,
    );
    denied(
      await drafts.prepareDraftSeed({
        context: contextFor(writer),
        mailboxId,
        origin: {
          kind: "derive",
          messageId: c1.messageId,
          input: { kind: "edit_as_new", senderIdentityId: identityId, includeAttachments: false },
        },
      }),
      403,
    );
    denied(await drafts.getDraft(base.context, mailboxId, hiddenDraftId), 404);
    denied(await drafts.updateDraft({ ...base, expectedRevision: 1, input: editableInput() }), 404);
    denied(await drafts.discardDraft({ ...base, expectedRevision: 1 }), 404);
    denied(await drafts.listDraftRecoveryCopies(base), 404);
    denied(await leases.getDraftLease(base), 404);
    denied(await leases.acquireDraftLease(base), 404);
    denied(await reviewDraftComposeSafety({ ...base, expectedRevision: 1 }), 404);
    denied(await uploads.createDraftAttachmentUpload({ ...base, input: { filename: "x", contentType: "text/plain", byteLength: 1 } }), 404);
    denied(await uploads.listDraftAttachmentUploads(base), 404);
    denied(await uploads.listUnfinishedDraftAttachmentUploads(base), 404);
    denied(await uploads.getDraftAttachmentUpload({ ...base, uploadId: hiddenUploadId }), 404);
    denied(await uploads.appendDraftAttachmentUpload({ ...base, uploadId: hiddenUploadId, offset: 0, bytes: Buffer.from("x") }), 404);
    denied(await uploads.finalizeDraftAttachmentUpload({ ...base, uploadId: hiddenUploadId, expectedRevision: 1 }), 404);
    denied(await uploads.cancelDraftAttachmentUpload({ ...base, uploadId: hiddenUploadId }), 404);
    denied(await drafts.openDraftAttachment({ ...base, attachmentId: hiddenAttachmentId }), 404);
    denied(await drafts.removeDraftAttachment({ ...base, attachmentId: hiddenAttachmentId, expectedRevision: 1 }), 404);
    const hidden = unwrap(await drafts.getDraft(contextFor(owner), mailboxId, hiddenDraftId));
    denied(await queueSend(writer, hidden), 404);
  });

  test("compose configuration helpers allow writers; catalog, address and thread management stay mailbox-wide", async () => {
    const context = contextFor(writer);
    expect((await compose.listComposeTemplates(context, mailboxId)).ok).toBe(true);
    expect((await compose.listComposeSignatureDefaults(context, mailboxId)).ok).toBe(true);
    expect((await compose.getMailboxComposeStyle(context, mailboxId)).ok).toBe(true);
    const draft = {
      senderIdentityId: identityId,
      to: [{ address: "customer@example.test", name: null }],
      cc: [],
      bcc: [],
      subject: "Reply",
      body: "Body",
      format: "plain" as const,
      priority: "normal" as const,
      requestDeliveryReceipt: false,
      requestReadReceipt: false,
    };
    expect((await compose.previewComposeDraft({ context, mailboxId, input: { draft } })).ok).toBe(true);
    const template = unwrap(
      await compose.createComposeTemplate({
        context: contextFor(owner),
        mailboxId,
        input: { name: "Reply helper", shortcut: "reply", kind: "snippet", scope: "mailbox", body: "Hello {{ sender.email }}" },
      }),
    );
    expect(
      (await compose.renderComposeSnippet({ context, mailboxId, input: { templateId: template.id, draft, conversationId: c2.id } })).ok,
    ).toBe(true);
    expect((await compose.renderComposeSuggestions({ context, mailboxId, input: { query: "", draft, conversationId: c2.id } })).ok).toBe(
      true,
    ); // conversationId is metadata; the helper reads no conversation/message.
    denied(await compose.listComposeTemplates(contextFor(reader), mailboxId), 403);
    denied(await tags.createLocalTag({ context, mailboxId, input: { name: "Forbidden", color: "#336699" } }), 403);
    denied(
      await commands.createActorCommand({
        context,
        mailboxId,
        enqueue: false,
        input: { kind: "create_folder", name: "Forbidden", subscribe: true, showInSidebar: true, idempotencyKey: crypto.randomUUID() },
      }),
      403,
    );
    denied(
      await compose.createComposeTemplate({
        context,
        mailboxId,
        input: { name: "Forbidden", shortcut: "forbidden", kind: "snippet", scope: "mailbox", body: "Body" },
      }),
      403,
    );
    denied(
      await getConversationContext({
        ...params(writer),
        request: {},
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
        query: mailConversationContextQuerySchema.parse({}),
      }),
      403,
    );
    denied(
      await conversations.mergeConversations({
        context,
        mailboxId,
        targetConversationId: c1.id,
        input: { sourceConversationId: c2.id, expectedTargetRevision: 1, expectedSourceRevision: 1, confirm: true },
      }),
      403,
    );
    denied(
      await conversations.splitConversation({
        ...params(writer),
        input: { messageIds: [c1.messageId], expectedRevision: 1, confirm: true },
      }),
      403,
    );
  });

  test("command list, outcomes and cancellation reveal only the person's visible commands", async () => {
    const own = unwrap(await queueState());
    const foreign = unwrap(await queueState(owner));
    const hidden = unwrap(await queueState(owner, c2));
    const list = unwrap(await commands.listCommands(contextFor(writer), mailboxId, 100));
    expect(list.some((command) => command.id === own.id)).toBe(true);
    expect(list.some((command) => command.id === foreign.id || command.id === hidden.id)).toBe(false);
    expect(
      unwrap(await commands.getCommandOutcomes(contextFor(writer), mailboxId, [own.id, foreign.id, hidden.id])).map(
        (command) => command.id,
      ),
    ).toEqual([own.id]);
    denied(await commands.getCommand(contextFor(writer), mailboxId, foreign.id), 404);
    const send = unwrap(await queueSend(owner, unwrap(await createReply(owner))));
    denied(await scheduled.cancelSendCommand({ context: contextFor(writer), mailboxId, commandId: send.id }), 404);
    expect((await scheduled.cancelSendCommand({ context: contextFor(owner), mailboxId, commandId: send.id })).ok).toBe(true);
    unwrap(await assignWriter("remove"));
    try {
      denied(await commands.getCommand(contextFor(writer), mailboxId, own.id), 404);
      expect(unwrap(await commands.getCommandOutcomes(contextFor(writer), mailboxId, [own.id]))).toEqual([]);
    } finally {
      unwrap(await assignWriter("add"));
    }
  });

  test("delivery recovery, which starts a new conversation, stays with mailbox-wide writers", async () => {
    const visibleSend = unwrap(await queueSend(writer, unwrap(await createReply())));
    const deliveryId = visibleSend.result.outboxSubmissionId;
    if (typeof deliveryId !== "string") throw new Error("Send has no outbox");
    await sql`UPDATE mail.outbox_submissions SET state = 'unknown', last_error_code = 'AMBIGUOUS_SMTP_OUTCOME'
      WHERE id = ${deliveryId}::uuid`;
    await sql`UPDATE mail.commands SET state = 'ambiguous' WHERE id = ${visibleSend.id}::uuid`;
    const input = { recipientMode: "all" as const, includeAttachments: false, idempotencyKey: crypto.randomUUID() };
    denied(await drafts.createDeliveryRecoveryDraft({ context: contextFor(writer), mailboxId, deliveryId, input }), 403);
    denied(await drafts.createDeliveryRecoveryDraft({ context: contextFor(reader), mailboxId, deliveryId, input }), 403);
    const recovery = unwrap(await drafts.createDeliveryRecoveryDraft({ context: contextFor(owner), mailboxId, deliveryId, input }));
    expect([recovery.intent, recovery.conversationId]).toEqual(["new", null]);
  });

  test("platform administrators with assigned-only grants are not mailbox-wide notification recipients", async () => {
    await sql`UPDATE auth.users SET admin = true WHERE id = ${writer.id}::uuid`;
    try {
      expect(await hasCurrentMailboxUserPermission({ mailboxId, userId: writer.id, minimumPermission: "read" })).toBe(false);
      expect(await hasCurrentMailboxUserPermission({ mailboxId, userId: writer.id, minimumPermission: "write" })).toBe(false);
      expect(await hasCurrentMailboxUserPermission({ mailboxId, userId: owner.id, minimumPermission: "read" })).toBe(true);
      expect(
        (await currentMailboxUserIds({ mailboxId, conversationId: c1.id, userIds: [writer.id], minimumPermission: "read" })).has(writer.id),
      ).toBe(true);
      expect(
        (await currentMailboxUserIds({ mailboxId, conversationId: c2.id, userIds: [writer.id], minimumPermission: "read" })).has(writer.id),
      ).toBe(false);
    } finally {
      await sql`UPDATE auth.users SET admin = false WHERE id = ${writer.id}::uuid`;
    }
  });

  test("queued commands and scheduled sends fail authorization as soon as an assignment or grant ends", async () => {
    // Earlier acceptance tests intentionally left commands queued; remove their ordering barrier.
    await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE mailbox_id = ${mailboxId}::uuid AND kind <> 'send'`;
    for (const revoke of ["assignment", "grant"] as const) {
      const command = unwrap(await queueState());
      const send = unwrap(await queueSend(writer, unwrap(await createReply())));
      expect(await commandStillAuthorized(await stored(command.id), "write")).toBe(true);
      expect(await commandStillAuthorized(await stored(send.id), "write")).toBe(true);
      if (revoke === "assignment") unwrap(await assignWriter("remove"));
      else unwrap(await revokeMailboxAccess({ context: contextFor(owner), mailboxId, accessId: grantId }));
      try {
        expect(await commandStillAuthorized(await stored(command.id), "write")).toBe(false);
        expect(await commandStillAuthorized(await stored(send.id), "write")).toBe(false);
        const notice = spyOn(notifications, "send").mockRejectedValue(new Error("Unexpected hidden notification"));
        try {
          const outboxId = send.result.outboxSubmissionId;
          if (typeof outboxId !== "string") throw new Error("Send has no outbox");
          await notifySendWaitingForLogin({ outboxId, notice: "waiting" });
          expect(notice).not.toHaveBeenCalled();
          denied(
            await scheduled.cancelSendCommand({ context: contextFor(writer), mailboxId, commandId: send.id }),
            revoke === "assignment" ? 404 : 403,
          );
        } finally {
          notice.mockRestore();
        }

        expect(await executeMutationCommand(command.id)).toBe("failed");
        const [failed] = await sql<{ last_error_code: string }[]>`SELECT last_error_code FROM mail.commands WHERE id = ${command.id}::uuid`;
        expect(failed?.last_error_code).toBe("ACCESS_REVOKED");
        // The placeholder secret cannot be used by a provider: failure must precede any provider effect.
        const [effect] = await sql<
          { provider_effect_started_at: Date | null }[]
        >`SELECT provider_effect_started_at FROM mail.commands WHERE id = ${command.id}::uuid`;
        expect(effect?.provider_effect_started_at).toBeNull();
      } finally {
        if (revoke === "assignment") unwrap(await assignWriter("add"));
        else grantId = unwrap(await grantWriter()).id;
      }
    }
    const full = unwrap(await queueState(owner, c2));
    expect(await commandStillAuthorized(await stored(full.id), "write")).toBe(true);
  });

  test("a mailbox-wide read grant beside assigned write access stops queued writes, as it refuses new ones", async () => {
    await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE mailbox_id = ${mailboxId}::uuid AND kind <> 'send'`;
    const command = unwrap(await queueState());
    const send = unwrap(await queueSend(writer, unwrap(await createReply())));
    const readGrant = unwrap(
      await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: writer.id },
        permission: "read",
      }),
    );
    try {
      denied(await queueState(), 403);
      expect(await commandStillAuthorized(await stored(command.id), "write")).toBe(false);
      expect(await commandStillAuthorized(await stored(send.id), "write")).toBe(false);
    } finally {
      unwrap(await revokeMailboxAccess({ context: contextFor(owner), mailboxId, accessId: readGrant.id }));
    }
    expect(await commandStillAuthorized(await stored(command.id), "write")).toBe(true);
    expect((await scheduled.cancelSendCommand({ context: contextFor(writer), mailboxId, commandId: send.id })).ok).toBe(true);
  });

  test("a scheduled reply stops, like its cancellation, once its source or outgoing message leaves the conversation", async () => {
    const draft = unwrap(await createReply());
    const send = unwrap(await queueSend(writer, draft));
    const [outbox] = await sql<
      { id: string; message_id: string | null }[]
    >`SELECT id, message_id FROM mail.outbox_submissions WHERE command_id = ${send.id}::uuid`;
    if (!outbox?.message_id) throw new Error("Send has no outgoing message");
    const listed = async () =>
      unwrap(await scheduled.listScheduledSends({ context: contextFor(writer), mailboxId })).items.some((item) => item.id === outbox.id);
    expect(await commandStillAuthorized(await stored(send.id), "write")).toBe(true);
    expect(await listed()).toBe(true);
    for (const messageId of [c1.messageId, outbox.message_id]) {
      await sql`UPDATE mail.conversation_messages SET conversation_id = ${c2.id}::uuid WHERE message_id = ${messageId}::uuid`;
      try {
        expect(await commandStillAuthorized(await stored(send.id), "write")).toBe(false);
        expect(await listed()).toBe(false);
        denied(await scheduled.cancelSendCommand({ context: contextFor(writer), mailboxId, commandId: send.id }), 404);
      } finally {
        await sql`UPDATE mail.conversation_messages SET conversation_id = ${c1.id}::uuid WHERE message_id = ${messageId}::uuid`;
      }
    }
    expect(await commandStillAuthorized(await stored(send.id), "write")).toBe(true);
    expect((await scheduled.cancelSendCommand({ context: contextFor(writer), mailboxId, commandId: send.id })).ok).toBe(true);
  });

  test("capability reviews use scoped services, while assignment reviews still refuse", async () => {
    const context = capContext(writer);
    const input = { mailboxId: mailboxShortId, conversationId: c1.shortId, status: "done" as const, expectedRevision: 1 };
    expect((await mailCapabilities.actions["conversation.status.update"].review(input, context)).ok).toBe(true);
    denied(await mailCapabilities.actions["conversation.status.update"].review({ ...input, conversationId: c2.shortId }, context), 404);
    denied(
      await mailCapabilities.actions["conversation.assign"].review(
        { mailboxId: mailboxShortId, conversationId: c1.shortId, assigneeUserIds: [writer.id], mode: "replace" },
        context,
      ),
      403,
    );
  });
});
