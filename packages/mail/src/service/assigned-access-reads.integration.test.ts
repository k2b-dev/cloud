import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { type Result, unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import api from "../api";
import { mailCapabilities } from "../capabilities";
import { ConversationSearchInputSchema, MailboxListInputSchema } from "../capability-contracts";
import { app } from "../config";
import { conversationViewSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { createMailNotificationService, type MailNotificationSendInput } from "../notifications";
import { grantMailboxAccess, updateMailboxAccess } from "./access";
import { resolveMailAddress } from "./addresses";
import { MAIL_ATTACHMENT_EXTRACTOR_VERSION } from "./attachment-extraction-contract";
import type { MailRequestContext } from "./auth";
import * as collaboration from "./collaboration";
import { getConversationPreview } from "./conversation-preview";
import { findConversationByReference, listConversationReferences } from "./conversation-reference";
import { getConversationSummary } from "./conversation-summary";
import * as drafts from "./drafts";
import * as focus from "./focus";
import * as localTags from "./local-tags";
import * as mailboxes from "./mailboxes";
import { storeReadableBlob } from "./message-blobs";
import * as inspector from "./message-inspector";
import * as messages from "./messages";
import { enqueueCollaborationNotifications } from "./notification-outbox";
import { resolveMailNotificationTarget } from "./notification-targets";
import { getConversationPresence } from "./presence";
import { getConversationReminder } from "./reminders";
import * as remoteContent from "./remote-content";
import * as savedViews from "./saved-views";
import * as scheduledSends from "./scheduled-sends";
import { searchMessages } from "./search";
import { listSenderIdentities } from "./sender-identities";
import { loadMailboxConversationDetail, loadMailboxPageData } from "./workspace";

const suite = suiteFor("database", "nats", "valkey");
const notFound = (result: Result<unknown>) => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(404);
};
const forbidden = (result: Result<unknown>) => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
};
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: `assigned-reads-${user.id}`,
});

suite("assigned-only Mail reads fail closed across services, HTTP and capabilities", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const blobIds: string[] = [];
  let owner: User;
  let readerA: User;
  let writerB: User;
  let readerR: User;
  let groupId = "";
  let mailboxId = "";
  let mailboxShortId = "";
  let identityId = "";
  let resourceId = "";
  let inboxId = "";
  let hiddenFolderId = "";
  let draftsFolderId = "";
  let tokenA = "";
  let tokenB = "";
  let tokenR = "";
  type Conversation = {
    id: string;
    shortId: string;
    messageId: string;
    messageShortId: string;
    attachmentId: string;
    attachmentShortId: string;
    imageId: string;
    commentId: string;
    commentShortId: string;
    reference: string;
  };
  let c1: Conversation;
  let c2: Conversation;
  let c3: Conversation;
  let draft1 = "";
  let draft3 = "";
  let reminder1 = "";
  let scheduled1 = "";
  let scheduled3 = "";
  let bindingId = "";
  let tagId = "";
  let readerGrantId = "";

  const createUser = async (role: string): Promise<User> => {
    const uid = `mail-assigned-reads-${role}-${suffix}`;
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

  const createConversation = async (label: string, folderId: string, position: number): Promise<Conversation> => {
    const shortId = newShortId();
    const messageShortId = newShortId();
    const subject = `${label} ${suffix}`;
    const bytes = Buffer.from(`Subject: ${subject}\r\nFrom: customer@example.test\r\n\r\n${subject} body`);
    const blob = await storeReadableBlob(Readable.from([bytes]), bytes.length);
    blobIds.push(blob.id);
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, summary)
      VALUES (${shortId}, ${mailboxId}::uuid, ${subject}, 'Customer', now() - make_interval(mins => ${position}), ${subject}) RETURNING id
    `;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date,
        size_bytes, content_hash, hydration_status, plain_text, source_blob_id)
      VALUES (${messageShortId}, ${mailboxId}::uuid, ${`<${label}-${suffix}@example.test>`}, ${subject}, ${subject.toLowerCase()},
        now() - make_interval(mins => ${position}), ${bytes.length}, ${blob.contentHash}, 'complete', ${`${subject} body`}, ${blob.id}::uuid) RETURNING id
    `;
    if (!conversation || !message) throw new Error("Conversation fixture was not created");
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position) VALUES (${conversation.id}::uuid, ${message.id}::uuid, 0)`;
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
      VALUES (${message.id}::uuid, 'from', 0, 'customer@example.test', 'customer@example.test')`;
    const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${message.id}::uuid, 1, ${position + 1}) RETURNING id`;
    if (!ref) throw new Error("Placement fixture was not created");
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${ref.id}::uuid, ${folderId}::uuid, ${message.id}::uuid, ARRAY[]::text[])`;
    const [part] = await sql<{ id: string }[]>`INSERT INTO mail.message_parts
      (message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status)
      VALUES (${message.id}::uuid, '2', 'text/plain', 'attachment', ${`${label}.txt`}, ${bytes.length}, ${blob.id}::uuid, 'complete') RETURNING id`;
    if (!part) throw new Error("Part fixture was not created");
    const attachmentShortId = newShortId();
    const [attachment] = await sql<{ id: string }[]>`INSERT INTO mail.attachments
      (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
      VALUES (${attachmentShortId}, ${message.id}::uuid, ${part.id}::uuid, ${`${label}.txt`}, 'text/plain', 'attachment', ${bytes.length}, ${blob.id}::uuid) RETURNING id`;
    if (!attachment) throw new Error("Attachment fixture was not created");
    const imageId = crypto.randomUUID();
    await sql`INSERT INTO mail.message_remote_images (id, message_id, position, source_url, source_host)
      VALUES (${imageId}::uuid, ${message.id}::uuid, 0, 'https://example.test/image.png', 'example.test')`;
    const commentShortId = newShortId();
    const [comment] = await sql<{ id: string }[]>`INSERT INTO mail.conversation_comments
      (short_id, conversation_id, body_markdown, author_kind, author_id)
      VALUES (${commentShortId}, ${conversation.id}::uuid, ${subject}, 'user', ${owner.id}::uuid) RETURNING id`;
    if (!comment) throw new Error("Comment fixture was not created");
    const reference = `REF-${label}-${suffix}`;
    await sql`INSERT INTO mail.conversation_references
      (mailbox_id, conversation_id, origin_conversation_id, value, normalized_value, sequence, role,
       allocated_by_actor_kind, allocated_by_actor_id, idempotency_key, configuration_revision, pattern_snapshot)
      VALUES (${mailboxId}::uuid, ${conversation.id}::uuid, ${conversation.id}::uuid, ${reference}, ${reference.toLowerCase()}, ${position + 1}, 'primary',
       'user', ${owner.id}::uuid, ${reference}, 1, '{{ sequence }}')`;
    await sql`INSERT INTO mail.activity_events (mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, metadata)
      VALUES (${mailboxId}::uuid, ${conversation.id}::uuid, 'user', ${owner.id}::uuid, 'conversation.summary_changed', 'confirmed', '{}'::jsonb)`;
    const extracted = `${label}attachmentsecret`;
    await sql`INSERT INTO mail.attachment_extractions
      (blob_id, extractor_version, status, format, markdown, input_bytes, output_bytes, completed_at)
      VALUES (${blob.id}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}, 'complete', 'text', ${extracted}, ${bytes.length}, ${extracted.length}, now())`;
    await sql`INSERT INTO mail.message_search_chunks
      (message_id, mailbox_id, position, source_kind, attachment_id, blob_id, extractor_version, search_document)
      VALUES (${message.id}::uuid, ${mailboxId}::uuid, 0, 'attachment', ${attachment.id}::uuid, ${blob.id}::uuid,
        ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}, to_tsvector('simple', ${extracted}))`;
    await sql`INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
      VALUES (${message.id}::uuid, ${mailboxId}::uuid, 0, to_tsvector('simple', ${`${subject} body`}))`;
    return {
      id: conversation.id,
      shortId,
      messageId: message.id,
      messageShortId,
      attachmentId: attachment.id,
      attachmentShortId,
      imageId,
      commentId: comment.id,
      commentShortId,
      reference,
    };
  };
  const createDraft = async (conversation: Conversation | null): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id, author_kind, author_id,
       last_editor_kind, last_editor_id, subject, body_markdown)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${conversation?.id ?? null}::uuid, ${conversation?.messageId ?? null}::uuid,
        ${conversation ? "reply" : "new"}, ${identityId}::uuid, 'user', ${owner.id}::uuid, 'user', ${owner.id}::uuid, 'Private draft', 'Draft body') RETURNING id`;
    if (!row) throw new Error("Draft fixture was not created");
    return row.id;
  };
  const createSubmission = async (draftId: string, state: "scheduled" | "failed", messageId: string | null = null): Promise<string> => {
    const key = crypto.randomUUID();
    const [command] = await sql<{ id: string }[]>`INSERT INTO mail.commands
      (mailbox_id, kind, actor_kind, actor_id, idempotency_key, request_hash, target, payload,
       access_subject_kind, access_subject_id, credential_scopes)
      VALUES (${mailboxId}::uuid, 'send', 'user', ${owner.id}::uuid, ${key}, ${"f".repeat(64)}, '{}'::jsonb,
        ${{ scheduledAt: new Date(Date.now() + 3600000).toISOString() }}::jsonb, 'user', ${owner.id}::uuid, ARRAY[]::text[]) RETURNING id`;
    if (!command) throw new Error("Command fixture was not created");
    const snapshot = {
      to: [],
      cc: [],
      bcc: [],
      subject: "Scheduled private subject",
      body: "Scheduled body",
      renderedText: "Scheduled body",
    };
    const [submission] = await sql<{ id: string }[]>`INSERT INTO mail.outbox_submissions
      (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id,
       state, scheduled_at, requested_at, mime_date, draft_snapshot, message_id)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${draftId}::uuid, ${command.id}::uuid, ${identityId}::uuid, ${bindingId}::uuid,
        ${`<${key}@example.test>`}, ${state}, now() + interval '1 hour', now(), now(), ${snapshot}::jsonb, ${messageId}::uuid) RETURNING id`;
    if (!submission) throw new Error("Submission fixture was not created");
    return submission.id;
  };
  const call = (token: string, path: string, body?: unknown) =>
    api.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-for": uniqueCallerAddress(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const base = () => `/mailboxes/${mailboxShortId}`;
  const paramsFor = (user: User, conversation: Conversation) => ({ context: contextFor(user), mailboxId, conversationId: conversation.id });
  const capContext = (user: User): CapabilityExecutionContext => ({
    ...contextFor(user),
    user,
    locale: "en",
    requestId: `assigned-cap-${suffix}`,
    origin: "assistant",
    signal: AbortSignal.timeout(30_000),
  });

  beforeAll(async () => {
    await migrate();
    owner = await createUser("owner");
    readerA = await createUser("A");
    writerB = await createUser("B");
    readerR = await createUser("R");
    const ownerContext = contextFor(owner);
    const mailbox = unwrap(await mailboxes.createMailbox(ownerContext, { name: `Assigned reads ${suffix}` }));
    mailboxId = mailbox.id;
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (!mailboxRow) throw new Error("Mailbox fixture was not created");
    mailboxShortId = mailboxRow.short_id;
    const [group] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`assigned-reads-${suffix}`}, 'local', 'Assigned readers') RETURNING id`;
    if (!group) throw new Error("Group fixture was not created");
    groupId = group.id;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${writerB.id}::uuid, ${groupId}::uuid)`;
    readerGrantId = unwrap(
      await grantMailboxAccess({
        context: ownerContext,
        mailboxId,
        principal: { type: "user", userId: readerA.id },
        permission: "read",
        scope: "assigned",
      }),
    ).id;
    unwrap(
      await grantMailboxAccess({
        context: ownerContext,
        mailboxId,
        principal: { type: "group", groupId },
        permission: "write",
        scope: "assigned",
      }),
    );
    unwrap(
      await grantMailboxAccess({ context: ownerContext, mailboxId, principal: { type: "user", userId: readerR.id }, permission: "read" }),
    );
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}, 'active') RETURNING id`;
    if (!resource) throw new Error("Remote resource fixture was not created");
    resourceId = resource.id;
    const folderIds: string[] = [];
    for (const [name, role] of [
      ["Inbox", "inbox"],
      ["Private", "other"],
      ["Drafts", "drafts"],
    ]) {
      const [folder] = await sql<
        { id: string }[]
      >`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${newShortId()}, ${resourceId}::uuid, ${name}, ${name}, ${role}, 'current') RETURNING id`;
      if (!folder) throw new Error("Folder fixture was not created");
      folderIds.push(folder.id);
    }
    [inboxId, hiddenFolderId, draftsFolderId] = [folderIds[0]!, folderIds[1]!, folderIds[2]!];
    const [identity] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'team@example.test', 'Team') RETURNING id`;
    if (!identity) throw new Error("Sender fixture was not created");
    identityId = identity.id;
    const [connection] = await sql<{ id: string }[]>`INSERT INTO mail.provider_connections
      (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, status)
      VALUES (${mailboxId}::uuid, 'Test', 'team@example.test', 'team@example.test', 'imap.example.test', 993, 'implicit',
        'smtp.example.test', 587, 'starttls', 'password', 'revoked') RETURNING id`;
    if (!connection) throw new Error("Connection fixture was not created");
    const [binding] = await sql<{ id: string }[]>`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, remote_locator)
      VALUES (${resourceId}::uuid, ${connection.id}::uuid, '{}'::jsonb) RETURNING id`;
    if (!binding) throw new Error("Binding fixture was not created");
    bindingId = binding.id;
    c1 = await createConversation("visiblelighthouse", inboxId, 1);
    c2 = await createConversation("groupwriter", hiddenFolderId, 2);
    // A hidden message shares Inbox, so even a listed folder must not count it.
    c3 = await createConversation("hiddenquasar", inboxId, 3);
    unwrap(
      await collaboration.applyConversationAssignments({
        context: ownerContext,
        mailboxId,
        conversationIds: [c1.shortId],
        assigneeUserIds: [readerA.id],
        mode: "replace",
      }),
    );
    unwrap(
      await collaboration.applyConversationAssignments({
        context: ownerContext,
        mailboxId,
        conversationIds: [c2.shortId],
        assigneeUserIds: [writerB.id],
        mode: "replace",
      }),
    );
    draft1 = await createDraft(c1);
    draft3 = await createDraft(c3);
    await createDraft(null);
    scheduled1 = await createSubmission(draft1, "scheduled");
    scheduled3 = await createSubmission(draft3, "scheduled");
    await createSubmission(draft3, "failed", c3.messageId);
    const tag = unwrap(
      await localTags.createLocalTag({ context: ownerContext, mailboxId, input: { name: "Private tags", color: "#336699" } }),
    );
    tagId = tag.id;
    await sql`INSERT INTO mail.conversation_local_tags (mailbox_id, conversation_id, tag_id, assigned_by_actor_kind, assigned_by_actor_id)
      VALUES (${mailboxId}::uuid, ${c1.id}::uuid, ${tagId}::uuid, 'user', ${owner.id}::uuid),
        (${mailboxId}::uuid, ${c3.id}::uuid, ${tagId}::uuid, 'user', ${owner.id}::uuid)`;
    // Thread-change events contain other conversations' ids and counts, even when filed on a visible conversation.
    await sql`INSERT INTO mail.activity_events (mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, metadata)
      VALUES (${mailboxId}::uuid, ${c1.id}::uuid, 'user', ${owner.id}::uuid, 'conversation.merged', 'confirmed',
        ${{ sourceConversationId: c3.id, movedMessageCount: 42 }}::jsonb)`;
    await sql`INSERT INTO mail.activity_events (mailbox_id, conversation_id, actor_kind, action, outcome, target_type, target_id, metadata)
      VALUES (${mailboxId}::uuid, ${c1.id}::uuid, 'system', 'message.receipt', 'confirmed', 'message', ${c3.messageId}::uuid, '{}'::jsonb),
        (${mailboxId}::uuid, ${c1.id}::uuid, 'system', 'draft.created', 'confirmed', 'draft', ${draft1}::uuid,
          ${{ sourceMessageId: c3.messageId }}::jsonb),
        (${mailboxId}::uuid, ${c1.id}::uuid, 'system', 'message.marked', 'confirmed', 'conversation', ${c1.id}::uuid,
          ${{ messageIds: [c1.messageId, c3.messageId] }}::jsonb)`;
    const [reminder] = await sql<
      { id: string }[]
    >`INSERT INTO mail.conversation_reminders (short_id, mailbox_id, conversation_id, user_id, due_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${c1.id}::uuid, ${readerA.id}::uuid, now() + interval '1 day') RETURNING id`;
    if (!reminder) throw new Error("Reminder fixture was not created");
    reminder1 = reminder.id;
    tokenA = unwrap(await serviceAccountCredentials.createUserApiToken({ user: readerA, name: `A ${suffix}` })).token;
    tokenB = unwrap(await serviceAccountCredentials.createUserApiToken({ user: writerB, name: `B ${suffix}` })).token;
    tokenR = unwrap(await serviceAccountCredentials.createUserApiToken({ user: readerR, name: `R ${suffix}` })).token;
  });

  afterAll(async () => {
    if (mailboxId) {
      await sql`DELETE FROM mail.outbox_submissions WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${blobIds}::jsonb))`;
    const accounts = await sql<
      { id: string }[]
    >`SELECT id FROM auth.service_accounts WHERE delegated_user_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    for (const account of accounts) {
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${account.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
    }
    await sql`DELETE FROM auth.access WHERE user_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb)) OR group_id = ${groupId || null}::uuid`;
    if (groupId) await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  });

  const checkLists = async (visible: boolean) => {
    const context = contextFor(readerA);
    const params = { context, mailboxId };
    expect(unwrap(await messages.listConversations(params)).items.map((item) => item.id)).toEqual(visible ? [c1.id] : []);
    for (const view of conversationViewSchema.options) {
      const page = unwrap(await messages.listConversations({ ...params, view, limit: 1 }));
      expect(page.items.every((item) => visible && item.id === c1.id)).toBe(true);
      expect(page.nextCursor).toBeNull();
    }
    expect(unwrap(await messages.getConversationViewCounts(params))).toEqual({
      needs_action: visible ? 1 : 0,
      mine: visible ? 1 : 0,
      unassigned: 0,
      waiting: 0,
      done: 0,
      snoozed: 0,
      send_problems: 0,
      recently_active: visible ? 1 : 0,
    });
    for (const view of ["mine", "waiting", "unassigned", "all"] as const) {
      const page = unwrap(await focus.listFocusConversations({ context, view }));
      expect(page.items.every((item) => visible && item.id === c1.id)).toBe(true);
      expect(page.counts).toEqual({ mine: visible ? 1 : 0, waiting: 0, unassigned: 0, all: visible ? 1 : 0 });
    }
    expect(unwrap(await focus.listMailboxCounts(context))).toEqual(visible ? [{ mailboxId, unread: 1, needsAction: 1 }] : []);
    const folderList = unwrap(await messages.listFolders(context, mailboxId));
    expect(folderList.map((item) => item.id).sort()).toEqual(visible ? [inboxId, draftsFolderId].sort() : []);
    if (visible) {
      expect(folderList.find((item) => item.id === inboxId)).toMatchObject({ total: 1, unread: 1 });
      expect(folderList.find((item) => item.id === draftsFolderId)).toMatchObject({ total: 1, unread: 0 });
    }
    expect(unwrap(await drafts.listDrafts(context, mailboxId)).map((item) => item.id)).toEqual(visible ? [draft1] : []);
    const draftPage = unwrap(await drafts.listDraftFolder(params));
    expect(draftPage.total).toBe(visible ? 1 : 0);
    expect(draftPage.items.map((item) => item.id)).toEqual(visible ? [draft1] : []);
    for (const groupByConversation of [true, false])
      for (const sort of ["newest", "relevance"] as const) {
        for (const [field, query, expected] of [
          ["subject", "hiddenquasar", false],
          ["body", "hiddenquasar", false],
          ["any", "hiddenquasarattachmentsecret", false],
          ["subject", "visiblelighthouse", visible],
          ["body", "visiblelighthouse", visible],
          ["any", "visiblelighthouseattachmentsecret", visible],
        ] as const) {
          const result = unwrap(
            await searchMessages({
              ...params,
              groupByConversation,
              request: { expression: { type: "text", field, query, match: "words" }, sort, limit: 1 },
            }),
          );
          expect(result.items.map((item) => item.id)).toEqual(expected ? [c1.messageId] : []);
          expect(result.nextCursor).toBeNull();
        }
        const sendProblems = unwrap(
          await searchMessages({
            ...params,
            groupByConversation,
            sendProblems: true,
            request: { expression: { type: "all" }, sort, limit: 50 },
          }),
        );
        expect(sendProblems.items).toEqual([]);
      }
    const tags = unwrap(await localTags.listConversationLocalTags({ ...params, conversationIds: [c1.id, c2.id, c3.id] }));
    expect([...tags.keys()]).toEqual(visible ? [c1.id] : []);
    const scheduled = unwrap(await scheduledSends.listScheduledSends(params));
    expect(scheduled.items.map((item) => item.id)).toEqual(visible ? [scheduled1] : []);
    expect(scheduled.total).toBe(visible ? 1 : 0);
    expect(unwrap(await scheduledSends.countScheduledSends(params))).toBe(visible ? 1 : 0);
    notFound(await scheduledSends.getScheduledSend({ ...params, scheduledSendId: scheduled3 }));
    if (visible) expect(unwrap(await scheduledSends.getScheduledSend({ ...params, scheduledSendId: scheduled1 })).draftId).toBe(draft1);
    else notFound(await scheduledSends.getScheduledSend({ ...params, scheduledSendId: scheduled1 }));
    notFound(await scheduledSends.getScheduledSend({ ...params, scheduledSendId: crypto.randomUUID() }));
    const scheduledResponse = await call(tokenA, `${base()}/scheduled-sends`);
    expect(scheduledResponse.status).toBe(200);
    expect(await scheduledResponse.json()).toMatchObject({
      items: visible ? [{ conversationId: c1.shortId }] : [],
      total: visible ? 1 : 0,
    });
    const draftResponse = await call(tokenA, `${base()}/drafts`);
    expect(draftResponse.status).toBe(200);
    expect(await draftResponse.json()).toHaveLength(visible ? 1 : 0);
    const httpList = await call(tokenA, `${base()}/conversations`);
    expect(httpList.status).toBe(200);
    expect(await httpList.json()).toMatchObject({ items: visible ? [{ id: c1.shortId }] : [], nextCursor: null });
    for (const view of conversationViewSchema.options) {
      const response = await call(tokenA, `${base()}/conversations?view=${view}`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(JSON.stringify(body)).not.toContain(c3.shortId);
      expect(JSON.stringify(body)).not.toContain(c2.shortId);
      if (!visible) expect(body).toMatchObject({ items: [] });
    }
    const counts = await call(tokenA, `${base()}/conversation-view-counts`);
    expect(counts.status).toBe(200);
    expect(await counts.json()).toMatchObject({ needs_action: visible ? 1 : 0, mine: visible ? 1 : 0, recently_active: visible ? 1 : 0 });
    const folders = await call(tokenA, `${base()}/folders`);
    expect(folders.status).toBe(200);
    expect(await folders.json()).toHaveLength(visible ? 2 : 0);
    const overview = await call(tokenA, "/overview/conversations?view=all");
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ items: visible ? [{ id: c1.shortId }] : [], counts: { all: visible ? 1 : 0 } });
    for (const query of ["hiddenquasar", "visiblelighthouse"]) {
      const response = await call(tokenA, `${base()}/search`, {
        expression: { type: "text", field: "any", query, match: "words" },
        sort: "newest",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: visible && query === "visiblelighthouse" ? [{ id: c1.messageShortId }] : [],
      });
      const href = `/app/mail/${mailboxShortId}?q=${query}`;
      const workspaceResponse = await call(tokenA, `${base()}/workspace-route?listMode=messages&href=${encodeURIComponent(href)}`);
      expect(workspaceResponse.status).toBe(200);
      expect(await workspaceResponse.json()).toMatchObject({
        access: { scope: "assigned", permission: "read" },
        listItems: visible && query === "visiblelighthouse" ? [{ id: c1.messageShortId }] : [],
      });
    }
  };

  const checkHidden = async (conversation: Conversation) => {
    const params = paramsFor(readerA, conversation);
    const messageParams = { context: params.context, mailboxId, messageId: conversation.messageId };
    notFound(await messages.listConversationMessages(params));
    notFound(await messages.listConversationMessageDetails(params));
    notFound(await collaboration.getConversationCollaboration(params));
    notFound(await collaboration.listConversationComments(params));
    notFound(await collaboration.getConversationComment({ ...params, commentId: conversation.commentId }));
    notFound(await collaboration.listActivity(params));
    notFound(await getConversationSummary(params));
    notFound(await getConversationPreview(params));
    notFound(await listConversationReferences(params));
    notFound(await findConversationByReference({ context: params.context, mailboxId, value: conversation.reference }));
    notFound(await drafts.listConversationDrafts(params));
    notFound(await getConversationReminder(params));
    notFound(await getConversationPresence(params));
    notFound(await localTags.getConversationLocalTags(params));
    expect(await loadMailboxConversationDetail(params)).toBeNull();
    notFound(await messages.getMessage(messageParams));
    notFound(await messages.openAttachment({ ...messageParams, attachmentId: conversation.attachmentId }));
    notFound(await inspector.inspectMessage(messageParams));
    notFound(await inspector.previewMessageSource(messageParams));
    notFound(await inspector.openMessageSource(messageParams));
    notFound(await remoteContent.loadRemoteImage({ ...messageParams, imageId: conversation.imageId }));
    notFound(
      await remoteContent.resolveMessagesRemoteContent({
        context: params.context,
        mailboxId,
        messages: [{ id: conversation.messageId, from: [] }],
      }),
    );
    for (const suffixPath of [
      "messages",
      "collaboration",
      "comments",
      `comments/${conversation.commentShortId}`,
      "summary",
      "preview",
      "references",
      "drafts",
      "reminder",
      "presence",
    ]) {
      expect((await call(tokenA, `${base()}/conversations/${conversation.shortId}/${suffixPath}`)).status).toBe(404);
    }
    for (const suffixPath of [
      "",
      "/inspector",
      "/source-preview",
      "/source",
      `/attachments/${conversation.attachmentShortId}`,
      `/remote-images/${conversation.imageId}`,
      "/calendar-invitation",
    ]) {
      expect((await call(tokenA, `${base()}/messages/${conversation.messageShortId}${suffixPath}`)).status).toBe(404);
    }
    expect((await call(tokenA, `${base()}/activity?conversationId=${conversation.shortId}`)).status).toBe(404);
    expect((await call(tokenA, `${base()}/conversations/by-reference?value=${conversation.reference}`)).status).toBe(404);
    expect((await call(tokenA, `${base()}/workspace-detail/${conversation.shortId}`)).status).toBe(404);
  };

  test("mailboxes expose assigned scope, including group write grants, without broadening write authority", async () => {
    const context = contextFor(readerA);
    expect(unwrap(await mailboxes.listMailboxes(context))).toEqual([
      expect.objectContaining({ id: mailboxId, accessScope: "assigned", permission: "read" }),
    ]);
    expect(unwrap(await mailboxes.getMailbox(context, mailboxId)).accessScope).toBe("assigned");
    expect(unwrap(await mailboxes.listMailboxes(context, 100, undefined, undefined, "write"))).toEqual([]);
    expect(unwrap(await mailboxes.listMailboxes(contextFor(writerB), 100, undefined, undefined, "write"))).toEqual([
      expect.objectContaining({ id: mailboxId, accessScope: "assigned", permission: "write" }),
    ]);
    expect(unwrap(await messages.listConversations({ context: contextFor(writerB), mailboxId })).items.map((item) => item.id)).toEqual([
      c2.id,
    ]);
    const response = await call(tokenA, "/mailboxes");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ id: mailboxShortId, accessScope: "assigned", permission: "read" })]);
    const groupList = await call(tokenB, `${base()}/conversations`);
    expect(groupList.status).toBe(200);
    expect(await groupList.json()).toMatchObject({ items: [{ id: c2.shortId }] });
    expect(unwrap(await listSenderIdentities(context, mailboxId))).toHaveLength(1);
    expect(unwrap(await localTags.listLocalTags(context, mailboxId)).map((tag) => tag.id)).toEqual([tagId]);
  });

  test("all lists, counts and search modes filter before paging, and hidden IDs look absent", async () => {
    await checkLists(true);
    await checkHidden(c3);
    await checkHidden(c2);
    const params = paramsFor(readerA, c1);
    expect(unwrap(await messages.listConversationMessageDetails(params))).toHaveLength(1);
    expect(unwrap(await collaboration.getConversationCollaboration(params)).assignees.map((user) => user.id)).toEqual([readerA.id]);
    expect(unwrap(await drafts.listConversationDrafts(params)).map((item) => item.id)).toEqual([draft1]);
    expect(unwrap(await getConversationReminder(params))?.id).toBe(reminder1);
    expect(unwrap(await collaboration.listActivity(params)).items.some((event) => event.action === "conversation.merged")).toBe(false);
    const download = unwrap(
      await messages.openAttachment({ context: params.context, mailboxId, messageId: c1.messageId, attachmentId: c1.attachmentId }),
    );
    expect(download.total).toBeGreaterThan(0);
    for (const path of [
      `/conversations/${c1.shortId}/messages`,
      `/messages/${c1.messageShortId}`,
      `/messages/${c1.messageShortId}/inspector`,
      `/messages/${c1.messageShortId}/source-preview`,
      `/messages/${c1.messageShortId}/source`,
      `/messages/${c1.messageShortId}/attachments/${c1.attachmentShortId}`,
      `/workspace-detail/${c1.shortId}`,
    ]) {
      const response = await call(tokenA, `${base()}${path}`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect((await resolveMailNotificationTarget({ context: params.context, mailboxId, kind: "reminder", sourceId: reminder1 })).ok).toBe(
      true,
    );
  });

  test("native and available ranked search backends, and mailbox-wide cursors, cannot reveal hidden rows", async () => {
    const context = contextFor(readerA);
    for (const backend of ["postgres", "auto"] as const) {
      await sql`UPDATE mail.mailboxes SET search_backend = ${backend} WHERE id = ${mailboxId}::uuid`;
      for (const groupByConversation of [true, false]) {
        const result = unwrap(
          await searchMessages({
            context,
            mailboxId,
            groupByConversation,
            request: { expression: { type: "all" }, sort: "relevance", limit: 1 },
          }),
        );
        expect(result.items.map((item) => item.id)).toEqual([c1.messageId]);
        expect(result.nextCursor).toBeNull();
      }
    }
    const mailboxPage = unwrap(await messages.listConversations({ context: contextFor(readerR), mailboxId, limit: 1 }));
    expect(mailboxPage.nextCursor).not.toBeNull();
    // Another reader's cursor belongs to that reader's list and is refused.
    const assignedPage = await messages.listConversations({ context, mailboxId, cursor: mailboxPage.nextCursor ?? undefined });
    expect(assignedPage.ok ? null : assignedPage.error.status).toBe(400);
    const request = { expression: { type: "all" } as const, sort: "newest" as const, limit: 1 };
    const grant = { context: contextFor(owner), mailboxId, accessId: readerGrantId, permission: "read" as const };
    unwrap(await updateMailboxAccess({ ...grant, scope: "mailbox" }));
    let searchCursor: string | null = null;
    try {
      const mailboxSearch = unwrap(await searchMessages({ context, mailboxId, request }));
      searchCursor = mailboxSearch.nextCursor;
      expect(searchCursor).not.toBeNull();
    } finally {
      unwrap(await updateMailboxAccess({ ...grant, scope: "assigned" }));
    }
    const assignedSearch = unwrap(await searchMessages({ context, mailboxId, request: { ...request, cursor: searchCursor ?? undefined } }));
    expect(assignedSearch.items).toEqual([]);
    expect(assignedSearch.nextCursor).toBeNull();
  });

  test("draft and activity references do not reveal messages that have left a visible conversation", async () => {
    const params = paramsFor(readerA, c1);
    const activity = unwrap(await collaboration.listActivity(params));
    expect(JSON.stringify(activity)).not.toContain(c3.messageShortId);
    expect(JSON.stringify(activity)).not.toContain(c3.messageId);
    expect(activity.items.some((item) => item.action === "message.receipt")).toBe(false);
    const allActivity = unwrap(await collaboration.listActivity({ ...params, context: contextFor(readerR) }));
    expect(allActivity.items.some((item) => item.action === "message.receipt")).toBe(true);
    await sql`UPDATE mail.drafts SET source_message_id = ${c3.messageId}::uuid WHERE id = ${draft1}::uuid`;
    try {
      const listed = unwrap(await drafts.listDrafts(contextFor(readerA), mailboxId));
      expect(listed).toHaveLength(1);
      expect(listed[0]?.sourceMessageId).toBeNull();
      expect(unwrap(await drafts.listDrafts(contextFor(readerR), mailboxId)).find((item) => item.id === draft1)?.sourceMessageId).toBe(
        c3.messageId,
      );
      const response = await call(tokenA, `${base()}/drafts`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([{ sourceMessageId: null }]);
    } finally {
      await sql`UPDATE mail.drafts SET source_message_id = ${c1.messageId}::uuid WHERE id = ${draft1}::uuid`;
    }
  });

  test("mailbox-wide services keep refusing assigned readers, including assigned writers", async () => {
    forbidden(await savedViews.listSavedConversationViews({ context: contextFor(readerA), mailboxId }));
    forbidden(await collaboration.listAssignableUsers({ context: contextFor(readerA), mailboxId }));
    forbidden(await collaboration.listActivity({ context: contextFor(readerA), mailboxId }));
    forbidden(await drafts.getDraft(contextFor(readerA), mailboxId, draft3));
    forbidden(await resolveMailAddress({ context: contextFor(readerA), mailbox: mailboxShortId }));
    for (const token of [tokenA, tokenB])
      for (const path of [
        "saved-views",
        "details",
        "health",
        "assignable-users",
        "activity",
        "settings-context",
        "remote-content-rules",
        `conversations/${c1.shortId}/related`,
        `conversations/${c1.shortId}/context`,
      ]) {
        expect((await call(token, `${base()}/${path}`)).status).toBe(403);
      }
  });

  test("capability mailbox list, search and conversation read use the same current visibility", async () => {
    const context = capContext(readerA);
    const listed = await mailCapabilities.queries["mailbox.list"].run(MailboxListInputSchema.parse({}), context);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.data.data.map((item) => item.ref.id)).toEqual([mailboxShortId]);
    const search = mailCapabilities.queries["conversation.search"];
    const hidden = unwrap(
      await search.run(
        ConversationSearchInputSchema.parse({
          mailboxId: mailboxShortId,
          expression: { type: "text", field: "any", query: "hiddenquasar", match: "words" },
        }),
        context,
      ),
    );
    expect(hidden.data).toEqual([]);
    const visible = unwrap(
      await search.run(
        ConversationSearchInputSchema.parse({
          mailboxId: mailboxShortId,
          expression: { type: "text", field: "any", query: "visiblelighthouse", match: "words" },
        }),
        context,
      ),
    );
    expect(visible.data.map((item) => item.ref.id)).toEqual([c1.shortId]);
    notFound(await mailCapabilities.queries["conversation.read"].run({ id: c3.shortId }, context));
    expect((await mailCapabilities.queries["conversation.read"].run({ id: c1.shortId }, context)).ok).toBe(true);
  });

  test("mailbox-wide readers and the owner still see all conversations, folders and drafts", async () => {
    for (const user of [readerR, owner]) {
      const context = contextFor(user);
      expect(unwrap(await messages.listConversations({ context, mailboxId })).items).toHaveLength(3);
      expect(unwrap(await messages.listFolders(context, mailboxId))).toHaveLength(3);
      expect(unwrap(await drafts.listDrafts(context, mailboxId))).toHaveLength(3);
      expect(unwrap(await messages.getConversationViewCounts({ context, mailboxId })).recently_active).toBe(3);
      expect(unwrap(await messages.getMessage({ context, mailboxId, messageId: c3.messageId })).subject).toContain("hiddenquasar");
    }
    const response = await call(tokenR, `${base()}/conversations`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: c1.shortId }, { id: c2.shortId }, { id: c3.shortId }] });
  });

  test("removing an assignment immediately revokes every read, including transfer rechecks and capabilities", async () => {
    const context = contextFor(readerA);
    const before = unwrap(await messages.openAttachment({ context, mailboxId, messageId: c1.messageId, attachmentId: c1.attachmentId }));
    unwrap(
      await collaboration.applyConversationAssignments({
        context: contextFor(owner),
        mailboxId,
        conversationIds: [c1.shortId],
        assigneeUserIds: [readerA.id],
        mode: "remove",
      }),
    );
    await checkLists(false);
    await checkHidden(c1);
    const stream = messages.createAttachmentStream({
      blobId: before.blobId,
      start: 0,
      endExclusive: before.total,
      chunkSize: before.chunkSize,
      chunkCount: before.chunkCount,
      assertCurrentAccess: async () => {
        unwrap(await messages.openAttachment({ context, mailboxId, messageId: c1.messageId, attachmentId: c1.attachmentId }));
      },
    });
    await expect(new Response(stream).arrayBuffer()).rejects.toBeDefined();
    notFound(await resolveMailNotificationTarget({ context, mailboxId, kind: "reminder", sourceId: reminder1 }));
    await sql`UPDATE mail.conversation_reminders SET due_at = now() - interval '1 second' WHERE id = ${reminder1}::uuid`;
    await enqueueCollaborationNotifications({
      db: sql,
      kind: "reminder",
      mailboxId,
      conversationId: c1.id,
      recipientUserIds: [readerA.id],
      sourceId: reminder1,
      sourceRevision: 1,
    });
    const sent: MailNotificationSendInput[] = [];
    const notifications = createMailNotificationService(app.notifications, {
      sender: async (input) => {
        sent.push(input);
      },
    });
    const recovery = await notifications.recover();
    expect(recovery.failed).toBe(0);
    expect(recovery.skipped).toBeGreaterThan(0);
    expect(sent.some((input) => input.recipientUserId === readerA.id)).toBe(false);
    notFound(await mailCapabilities.queries["conversation.read"].run({ id: c1.shortId }, capContext(readerA)));
    const searched = unwrap(
      await mailCapabilities.queries["conversation.search"].run(
        ConversationSearchInputSchema.parse({ mailboxId: mailboxShortId, expression: { type: "all" } }),
        capContext(readerA),
      ),
    );
    expect(searched.data).toEqual([]);
    const page = unwrap(
      await loadMailboxPageData({
        context,
        mailboxId,
        requestUrl: new URL(`http://localhost/app/mail/${mailboxShortId}?conversation=${c1.id}`),
        search: { query: "", expression: null, sort: "newest", error: null },
      }),
    );
    expect(page.access).toEqual({ scope: "assigned", permission: "read" });
    expect(page.selectedConversationId).toBeNull();
    expect(page.detailMessages).toEqual([]);
    expect(page.savedViews).toEqual([]);
    expect(unwrap(await messages.listConversations({ context: contextFor(readerR), mailboxId })).items).toHaveLength(3);
  });
});
