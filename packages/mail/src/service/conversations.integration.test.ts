import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { notifications } from "@k2b/cloud/services";
import { sql } from "bun";
import { app } from "../config";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { createConversationComment } from "./collaboration";
import { mergeConversations, reassignConversationMessage, splitConversation } from "./conversations";
import { createLocalTag } from "./local-tags";
import { createMailbox } from "./mailboxes";
import { hydrateMessageFromSource } from "./message-hydration";
import { mailNotificationTargetHref, resolveMailNotificationTarget } from "./notification-targets";
import { publicIds, requirePublicId } from "./public-resources";
import { setConversationReminder } from "./reminders";
import { ingestEnvelope } from "./sync-runtime";
import { loadMailboxConversationDetail } from "./workspace";

const enabled = process.env.MAIL_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;

const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: user.uid,
      sn: "Test",
      mail: `${user.uid}@example.com`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-threading-${user.uid}`,
});

suite("mail manual conversation threading", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const accessIds: string[] = [];
  const mailboxIds: string[] = [];
  let mailboxId = "";
  let remoteResourceId = "";
  let folderId = "";
  let targetConversationId = "";
  let sourceConversationId = "";
  let targetMessageId = "";
  let sourceMessageId = "";
  let sourceMessageEnvelopeId = "";
  let sourceCommentId = "";
  let otherConversationId = "";
  let owner: { id: string; uid: string };
  let writer: { id: string; uid: string };
  let reader: { id: string; uid: string };
  let ownerContext: MailRequestContext;
  let writerContext: MailRequestContext;
  let readerContext: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    await migrate();
    const [createdOwner] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-thread-owner-${suffix}`}, 'local', 'user', 'Thread Owner', false)
      RETURNING id, uid
    `;
    const [createdWriter] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-thread-writer-${suffix}`}, 'local', 'user', 'Thread Writer', false)
      RETURNING id, uid
    `;
    const [createdReader] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-thread-reader-${suffix}`}, 'local', 'user', 'Thread Reader', false)
      RETURNING id, uid
    `;
    if (!createdOwner || !createdWriter || !createdReader) throw new Error("Failed to create conversation threading users");
    owner = createdOwner;
    writer = createdWriter;
    reader = createdReader;
    userIds.push(owner.id, writer.id, reader.id);
    ownerContext = contextFor(owner);
    writerContext = contextFor(writer);
    readerContext = contextFor(reader);

    const mailbox = await createMailbox(ownerContext, {
      name: `Threading ${suffix}`,
    });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    mailboxIds.push(mailboxId);
    const writerAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: writer.id },
      permission: "write",
    });
    const readerAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: reader.id },
      permission: "read",
    });
    if (!writerAccess.ok || !readerAccess.ok) throw new Error("Failed to grant conversation threading access");
    accessIds.push(writerAccess.data.id, readerAccess.data.id);

    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)}, 'active')
      RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`threading-${suffix}`}, 'Inbox', 'inbox', 'current')
      RETURNING id
    `;
    remoteResourceId = resource!.id;
    folderId = folder!.id;

    const createMessage = async (params: { uid: number; messageId: string; subject: string; date: Date }) => {
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash,
          hydration_status, plain_text, sanitized_html
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${params.messageId},
          ${params.subject},
          ${params.subject.toLowerCase()},
          ${params.date},
          128,
          ${params.uid.toString(16).padStart(64, "0")},
          'complete',
          NULL,
          '<p>HTML-only fixture body</p>'
        ) RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
        VALUES
          (${message!.id}::uuid, 'from', 0, 'Customer', 'customer@example.com', 'customer@example.com'),
          (${message!.id}::uuid, 'reply_to', 0, 'Customer queue', 'queue@example.com', 'queue@example.com'),
          (${message!.id}::uuid, 'to', 0, 'Support', 'support@example.com', 'support@example.com'),
          (${message!.id}::uuid, 'cc', 0, 'Manager', 'manager@example.com', 'manager@example.com')
      `;
      const [remoteRef] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${folderId}::uuid, ${message!.id}::uuid, 1, ${params.uid})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${remoteRef!.id}::uuid, ${folderId}::uuid, ${message!.id}::uuid)
      `;
      const [conversation] = await sql<{ id: string }[]>`
        INSERT INTO mail.conversations (short_id,
          mailbox_id, subject, participant_summary, latest_inbound_at, latest_message_at
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid, ${params.subject}, 'Customer', ${params.date}, ${params.date}
        ) RETURNING id
      `;
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, ${params.date.getTime()}, 'headers')
      `;
      return { messageId: message!.id, conversationId: conversation!.id };
    };

    const target = await createMessage({
      uid: 101,
      messageId: `<thread-target-${suffix}@example.com>`,
      subject: "Thread target",
      date: new Date("2026-07-13T10:00:00.000Z"),
    });
    const source = await createMessage({
      uid: 102,
      messageId: `<thread-source-${suffix}@example.com>`,
      subject: "Thread source",
      date: new Date("2026-07-13T11:00:00.000Z"),
    });
    targetConversationId = target.conversationId;
    sourceConversationId = source.conversationId;
    targetMessageId = target.messageId;
    sourceMessageId = source.messageId;
    sourceMessageEnvelopeId = `<thread-source-${suffix}@example.com>`;
    await sql`
      UPDATE mail.remote_message_refs
      SET connector_ref = ${{ providerMessageId: `thread-source-provider-${suffix}` }}::jsonb
      WHERE message_id = ${sourceMessageId}::uuid
    `;

    const comment = await createConversationComment({
      context: readerContext,
      mailboxId,
      conversationId: sourceConversationId,
      input: { body: "Context for the source message", referencedMessageId: sourceMessageId },
    });
    if (!comment.ok) throw new Error(comment.error.message);
    sourceCommentId = comment.data.id;
    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, is_default, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Thread Sender', 'Thread Sender', 'support@example.com', true, 'verified')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.drafts (short_id,
        mailbox_id, conversation_id, intent, source_message_id, sender_identity_id,
        author_kind, author_id, last_editor_kind, last_editor_id, subject, body_markdown
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${sourceConversationId}::uuid,
        'reply',
        ${sourceMessageId}::uuid,
        ${identity!.id}::uuid,
        'user',
        ${writer.id}::uuid,
        'user',
        ${writer.id}::uuid,
        'Merged draft',
        'Draft body'
      )
    `;

    const otherMailbox = await createMailbox(ownerContext, {
      name: `Other threading ${suffix}`,
    });
    if (!otherMailbox.ok) throw new Error(otherMailbox.error.message);
    mailboxIds.push(otherMailbox.data.id);
    const [otherConversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${otherMailbox.data.id}::uuid, 'Other mailbox', '', now())
      RETURNING id
    `;
    otherConversationId = otherConversation!.id;
  });

  afterAll(async () => {
    for (const id of mailboxIds) {
      const rows = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
      accessIds.push(...rows.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
    }
    const uniqueAccessIds = [...new Set(accessIds)];
    if (uniqueAccessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${uniqueAccessIds}::jsonb))`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("loads focused conversation details only within the authorized mailbox", async () => {
    const detail = await loadMailboxConversationDetail({
      context: readerContext,
      mailboxId,
      conversationId: targetConversationId,
    });
    expect(detail?.conversationId).toBe(targetConversationId);
    expect(detail?.detailMessages.length).toBeGreaterThan(0);
    expect(detail?.detailMessages[0]).toMatchObject({
      replyTo: [{ name: "Customer queue", address: "queue@example.com" }],
      cc: [{ name: "Manager", address: "manager@example.com" }],
      forwardText: "HTML-only fixture body",
    });

    const sourceDetail = await loadMailboxConversationDetail({
      context: readerContext,
      mailboxId,
      conversationId: sourceConversationId,
    });
    expect(sourceDetail?.detailErrors.drafts).toBeNull();
    expect(sourceDetail?.conversationDrafts).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f-]{36}$/i), subject: "Merged draft", bodyPreview: "Draft body" }),
    ]);

    const crossMailbox = await loadMailboxConversationDetail({
      context: readerContext,
      mailboxId,
      conversationId: otherConversationId,
    });
    expect(crossMailbox).toBeNull();

    const denied = await loadMailboxConversationDetail({
      context: contextFor({ id: crypto.randomUUID(), uid: `mail-thread-outsider-${suffix}` }),
      mailboxId,
      conversationId: targetConversationId,
    });
    expect(denied).toBeNull();
  });

  test("merges and splits with durable overrides, revisions, related state, and permission checks", async () => {
    const denied = await mergeConversations({
      context: readerContext,
      mailboxId,
      targetConversationId,
      input: {
        sourceConversationId,
        expectedTargetRevision: 1,
        expectedSourceRevision: 1,
        confirm: true,
      },
    });

    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.status).toBe(403);

    const stale = await mergeConversations({
      context: writerContext,
      mailboxId,
      targetConversationId,
      input: {
        sourceConversationId,
        expectedTargetRevision: 2,
        expectedSourceRevision: 1,
        confirm: true,
      },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.status).toBe(409);

    const crossMailbox = await mergeConversations({
      context: writerContext,
      mailboxId,
      targetConversationId,
      input: {
        sourceConversationId: otherConversationId,
        expectedTargetRevision: 1,
        expectedSourceRevision: 1,
        confirm: true,
      },
    });
    expect(crossMailbox.ok).toBe(false);
    if (!crossMailbox.ok) expect(crossMailbox.error.status).toBe(404);

    const targetReminderDueAt = new Date(Date.now() + 120_000).toISOString();
    const sourceReminderDueAt = new Date(Date.now() + 60_000).toISOString();
    const movedReminderDueAt = new Date(Date.now() + 180_000).toISOString();
    const targetReminder = await setConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId: targetConversationId,
      input: { dueAt: targetReminderDueAt, expectedRevision: null },
    });
    const conflictingSourceReminder = await setConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId: sourceConversationId,
      input: { dueAt: sourceReminderDueAt, expectedRevision: null },
    });
    const movedSourceReminder = await setConversationReminder({
      context: ownerContext,
      mailboxId,
      conversationId: sourceConversationId,
      input: { dueAt: movedReminderDueAt, expectedRevision: null },
    });
    expect(targetReminder.ok && conflictingSourceReminder.ok && movedSourceReminder.ok).toBe(true);
    if (!targetReminder.ok || !conflictingSourceReminder.ok || !movedSourceReminder.ok) return;

    const [mailboxPublicIds, conversationPublicIds, reminderPublicIds] = await Promise.all([
      publicIds("mailboxes", [mailboxId]),
      publicIds("conversations", [sourceConversationId, targetConversationId]),
      publicIds("reminders", [conflictingSourceReminder.data.id, movedSourceReminder.data.id]),
    ]);
    const publicMailboxId = requirePublicId(mailboxPublicIds, mailboxId);
    const publicSourceConversationId = requirePublicId(conversationPublicIds, sourceConversationId);
    const publicTargetConversationId = requirePublicId(conversationPublicIds, targetConversationId);
    const publicConflictingReminderId = requirePublicId(reminderPublicIds, conflictingSourceReminder.data.id);
    const publicMovedReminderId = requirePublicId(reminderPublicIds, movedSourceReminder.data.id);

    const conflictingReminderIdempotencyKey = `mail:reminder:${conflictingSourceReminder.data.id}:${conflictingSourceReminder.data.revision}:${writer.id}`;
    await notifications.send(app.notifications.conversationReminder, {
      recipient: { userId: writer.id },
      data: {
        mailboxId: publicMailboxId,
        conversationId: publicSourceConversationId,
        sourceId: publicConflictingReminderId,
        subject: "Thread source",
      },
      idempotencyKey: conflictingReminderIdempotencyKey,
    });
    await sql`
      UPDATE mail.collaboration_notification_deliveries
      SET state = 'sent', sent_at = now()
      WHERE kind = 'reminder'
        AND source_id = ${conflictingSourceReminder.data.id}::uuid
        AND source_revision = ${conflictingSourceReminder.data.revision}
        AND recipient_user_id = ${writer.id}::uuid
    `;
    const rescheduledConflictingSourceReminder = await setConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId: sourceConversationId,
      input: {
        dueAt: new Date(Date.now() + 240_000).toISOString(),
        expectedRevision: conflictingSourceReminder.data.revision,
      },
    });
    expect(rescheduledConflictingSourceReminder.ok).toBe(true);
    if (!rescheduledConflictingSourceReminder.ok) return;
    const stableConflictingReminderTarget = mailNotificationTargetHref({
      mailboxId: publicMailboxId,
      kind: "reminder",
      sourceId: publicConflictingReminderId,
    });
    const resolvedConflictingReminderBeforeMerge = await resolveMailNotificationTarget({
      context: writerContext,
      mailboxId,
      kind: "reminder",
      sourceId: conflictingSourceReminder.data.id,
    });
    expect(resolvedConflictingReminderBeforeMerge.ok && resolvedConflictingReminderBeforeMerge.data.href).toContain(
      `conversation=${publicSourceConversationId}`,
    );

    const mergeDeliveryClaimId = crypto.randomUUID();
    await sql`
      UPDATE mail.collaboration_notification_deliveries
      SET state = 'sending', claim_id = ${mergeDeliveryClaimId}::uuid, claimed_at = now()
      WHERE kind = 'reminder' AND source_id = ${movedSourceReminder.data.id}::uuid
    `;
    const mergeDuringDelivery = await mergeConversations({
      context: writerContext,
      mailboxId,
      targetConversationId,
      input: {
        sourceConversationId,
        expectedTargetRevision: 1,
        expectedSourceRevision: 1,
        confirm: true,
      },
    });
    expect(mergeDuringDelivery.ok).toBe(false);
    if (!mergeDuringDelivery.ok) expect(mergeDuringDelivery.error.status).toBe(409);
    await sql`
      UPDATE mail.collaboration_notification_deliveries
      SET state = 'pending', claim_id = NULL, claimed_at = NULL
      WHERE kind = 'reminder' AND source_id = ${movedSourceReminder.data.id}::uuid
    `;
    const movedReminderIdempotencyKey = `mail:reminder:${movedSourceReminder.data.id}:${movedSourceReminder.data.revision}:${owner.id}`;
    await notifications.send(app.notifications.conversationReminder, {
      recipient: { userId: owner.id },
      data: {
        mailboxId: publicMailboxId,
        conversationId: publicSourceConversationId,
        sourceId: publicMovedReminderId,
        subject: "Thread source",
      },
      idempotencyKey: movedReminderIdempotencyKey,
    });
    await sql`
      UPDATE mail.collaboration_notification_deliveries
      SET state = 'sent', sent_at = now()
      WHERE kind = 'reminder'
        AND source_id = ${movedSourceReminder.data.id}::uuid
        AND source_revision = ${movedSourceReminder.data.revision}
        AND recipient_user_id = ${owner.id}::uuid
    `;
    const [notificationBeforeMerge] = await sql<{ target_href: string | null }[]>`
      SELECT target_href
      FROM notifications.events
      WHERE definition_id = ${app.notifications.conversationReminder.id}
        AND recipient_user_id = ${owner.id}::uuid
        AND idempotency_key = ${movedReminderIdempotencyKey}
    `;
    const stableMovedReminderTarget = mailNotificationTargetHref({
      mailboxId: publicMailboxId,
      kind: "reminder",
      sourceId: publicMovedReminderId,
    });
    expect(notificationBeforeMerge?.target_href).toBe(stableMovedReminderTarget);
    const resolvedBeforeMerge = await resolveMailNotificationTarget({
      context: ownerContext,
      mailboxId,
      kind: "reminder",
      sourceId: movedSourceReminder.data.id,
    });
    expect(resolvedBeforeMerge.ok && resolvedBeforeMerge.data.href).toContain(`conversation=${publicSourceConversationId}`);

    const sourceOnlyTag = await createLocalTag({
      context: writerContext,
      mailboxId,
      input: { name: "Source only", color: "#6b7280" },
    });
    const sharedTag = await createLocalTag({
      context: writerContext,
      mailboxId,
      input: { name: "Shared", color: "#2563eb" },
    });
    if (!sourceOnlyTag.ok || !sharedTag.ok) throw new Error("Failed to create merge tag fixtures");
    const sourceOnlyTagId = sourceOnlyTag.data.id;
    const sharedTagId = sharedTag.data.id;
    await sql`
      INSERT INTO mail.conversation_local_tags (
        mailbox_id, conversation_id, tag_id, assigned_by_actor_kind, assigned_by_actor_id
      ) VALUES
        (${mailboxId}::uuid, ${sourceConversationId}::uuid, ${sourceOnlyTagId}::uuid, 'user', ${writer.id}::uuid),
        (${mailboxId}::uuid, ${sourceConversationId}::uuid, ${sharedTagId}::uuid, 'user', ${writer.id}::uuid),
        (${mailboxId}::uuid, ${targetConversationId}::uuid, ${sharedTagId}::uuid, 'user', ${owner.id}::uuid)
    `;

    const merged = await mergeConversations({
      context: writerContext,
      mailboxId,
      targetConversationId,
      input: {
        sourceConversationId,
        expectedTargetRevision: 1,
        expectedSourceRevision: 1,
        reason: "Provider separated one customer thread",
        confirm: true,
      },
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.data).toMatchObject({
      removedConversationId: sourceConversationId,
      movedMessageCount: 1,
      target: { id: targetConversationId, revision: 2, messageCount: 2 },
    });
    const [sourceCommentActivityAfterMerge] = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id::text
      FROM mail.activity_events
      WHERE target_type = 'comment' AND target_id = ${sourceCommentId}::uuid
    `;
    expect(sourceCommentActivityAfterMerge?.conversation_id).toBe(sourceConversationId);
    const [mergeProjection] = await sql<
      {
        source_exists: boolean;
        messages: number;
        overrides: number;
        comments: number;
        drafts: number;
        participant_summary: string;
      }[]
    >`
      SELECT
        EXISTS (SELECT 1 FROM mail.conversations WHERE id = ${sourceConversationId}::uuid) AS source_exists,
        (SELECT COUNT(*)::int FROM mail.conversation_messages WHERE conversation_id = ${targetConversationId}::uuid) AS messages,
        (SELECT COUNT(*)::int FROM mail.conversation_thread_overrides WHERE conversation_id = ${targetConversationId}::uuid) AS overrides,
        (SELECT COUNT(*)::int FROM mail.conversation_comments WHERE conversation_id = ${targetConversationId}::uuid) AS comments,
        (SELECT COUNT(*)::int FROM mail.drafts WHERE conversation_id = ${targetConversationId}::uuid) AS drafts,
        (SELECT participant_summary FROM mail.conversations WHERE id = ${targetConversationId}::uuid) AS participant_summary
    `;
    expect(mergeProjection).toEqual({
      source_exists: false,
      messages: 2,
      overrides: 2,
      comments: 1,
      drafts: 1,
      participant_summary: "Customer",
    });
    const mergedTags = await sql<{ tag_id: string }[]>`
      SELECT tag_id
      FROM mail.conversation_local_tags
      WHERE conversation_id = ${targetConversationId}::uuid
      ORDER BY tag_id
    `;
    expect(mergedTags.map((tag) => tag.tag_id)).toEqual([sourceOnlyTagId, sharedTagId].sort());
    const mergedReminders = await sql<{ user_id: string; due_at: Date | string }[]>`
      SELECT user_id, due_at
      FROM mail.conversation_reminders
      WHERE conversation_id = ${targetConversationId}::uuid
      ORDER BY user_id
    `;
    expect(new Map(mergedReminders.map((reminder) => [reminder.user_id, new Date(reminder.due_at).toISOString()]))).toEqual(
      new Map([
        [writer.id, targetReminderDueAt],
        [owner.id, movedReminderDueAt],
      ]),
    );
    const [mergedDeliveries] = await sql<
      {
        conflicting_reminder_state: string;
        sent_conflicting_reminder_state: string;
        moved_reminder_conversation_id: string;
      }[]
    >`
      SELECT
        (
          SELECT state
          FROM mail.collaboration_notification_deliveries
          WHERE kind = 'reminder' AND source_id = ${conflictingSourceReminder.data.id}::uuid
            AND source_revision = ${rescheduledConflictingSourceReminder.data.revision}
        ) AS conflicting_reminder_state,
        (
          SELECT state
          FROM mail.collaboration_notification_deliveries
          WHERE kind = 'reminder' AND source_id = ${conflictingSourceReminder.data.id}::uuid
            AND source_revision = ${conflictingSourceReminder.data.revision}
        ) AS sent_conflicting_reminder_state,
        (
          SELECT conversation_id::text
          FROM mail.collaboration_notification_deliveries
          WHERE kind = 'reminder' AND source_id = ${movedSourceReminder.data.id}::uuid
        ) AS moved_reminder_conversation_id
    `;
    expect(mergedDeliveries).toEqual({
      conflicting_reminder_state: "skipped",
      sent_conflicting_reminder_state: "sent",
      moved_reminder_conversation_id: targetConversationId,
    });
    const [conflictingReminderNotificationAfterMerge] = await sql<{ target_href: string | null }[]>`
      SELECT target_href
      FROM notifications.events
      WHERE definition_id = ${app.notifications.conversationReminder.id}
        AND recipient_user_id = ${writer.id}::uuid
        AND idempotency_key = ${conflictingReminderIdempotencyKey}
    `;
    expect(conflictingReminderNotificationAfterMerge?.target_href).toBe(stableConflictingReminderTarget);
    const resolvedConflictingReminderAfterMerge = await resolveMailNotificationTarget({
      context: writerContext,
      mailboxId,
      kind: "reminder",
      sourceId: conflictingSourceReminder.data.id,
    });
    expect(resolvedConflictingReminderAfterMerge.ok && resolvedConflictingReminderAfterMerge.data.href).toContain(
      `conversation=${publicTargetConversationId}`,
    );
    const [notificationAfterMerge] = await sql<{ target_href: string | null }[]>`
      SELECT target_href
      FROM notifications.events
      WHERE definition_id = ${app.notifications.conversationReminder.id}
        AND recipient_user_id = ${owner.id}::uuid
        AND idempotency_key = ${movedReminderIdempotencyKey}
    `;
    expect(notificationAfterMerge?.target_href).toBe(stableMovedReminderTarget);
    const resolvedAfterMerge = await resolveMailNotificationTarget({
      context: ownerContext,
      mailboxId,
      kind: "reminder",
      sourceId: movedSourceReminder.data.id,
    });
    expect(resolvedAfterMerge.ok && resolvedAfterMerge.data.href).toContain(`conversation=${publicTargetConversationId}`);

    const rejectWholeSplit = await splitConversation({
      context: writerContext,
      mailboxId,
      conversationId: targetConversationId,
      input: { messageIds: [targetMessageId, sourceMessageId], expectedRevision: 2, confirm: true },
    });
    expect(rejectWholeSplit.ok).toBe(false);
    if (!rejectWholeSplit.ok) expect(rejectWholeSplit.error.code).toBe("BAD_INPUT");

    const splitDeliveryClaimId = crypto.randomUUID();
    await sql`
      UPDATE mail.collaboration_notification_deliveries
      SET state = 'sending', claim_id = ${splitDeliveryClaimId}::uuid, claimed_at = now()
      WHERE kind = 'reminder' AND source_id = ${movedSourceReminder.data.id}::uuid
    `;
    const splitDuringDelivery = await splitConversation({
      context: writerContext,
      mailboxId,
      conversationId: targetConversationId,
      input: { messageIds: [sourceMessageId], expectedRevision: 2, confirm: true },
    });
    expect(splitDuringDelivery.ok).toBe(false);
    if (!splitDuringDelivery.ok) expect(splitDuringDelivery.error.status).toBe(409);
    await sql`
      UPDATE mail.collaboration_notification_deliveries
      SET state = 'pending', claim_id = NULL, claimed_at = NULL
      WHERE kind = 'reminder' AND source_id = ${movedSourceReminder.data.id}::uuid
    `;

    const split = await splitConversation({
      context: writerContext,
      mailboxId,
      conversationId: targetConversationId,
      input: {
        messageIds: [sourceMessageId],
        expectedRevision: 2,
        reason: "Replies belong to a separate request",
        confirm: true,
      },
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.data).toMatchObject({
      movedMessageCount: 1,
      source: { id: targetConversationId, revision: 3, messageCount: 1 },
      created: { revision: 1, messageCount: 1 },
    });
    const [splitProjection] = await sql<
      {
        target_override: string;
        moved_override: string;
        moved_comments: number;
        source_drafts: number;
        source_reminders: number;
      }[]
    >`
      SELECT
        (SELECT conversation_id::text FROM mail.conversation_thread_overrides WHERE message_id = ${targetMessageId}::uuid) AS target_override,
        (SELECT conversation_id::text FROM mail.conversation_thread_overrides WHERE message_id = ${sourceMessageId}::uuid) AS moved_override,
        (SELECT COUNT(*)::int FROM mail.conversation_comments WHERE conversation_id = ${split.data.created.id}::uuid) AS moved_comments,
        (SELECT COUNT(*)::int FROM mail.drafts WHERE conversation_id = ${targetConversationId}::uuid) AS source_drafts,
        (SELECT COUNT(*)::int FROM mail.conversation_reminders WHERE conversation_id = ${targetConversationId}::uuid) AS source_reminders
    `;
    expect(splitProjection).toEqual({
      target_override: targetConversationId,
      moved_override: split.data.created.id,
      moved_comments: 1,
      source_drafts: 1,
      source_reminders: 2,
    });
    const [sourceCommentActivityAfterSplit] = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id::text
      FROM mail.activity_events
      WHERE target_type = 'comment' AND target_id = ${sourceCommentId}::uuid
    `;
    expect(sourceCommentActivityAfterSplit?.conversation_id).toBe(sourceConversationId);
    const [splitActivity] = await sql<{ metadata: { createdConversationId?: string } }[]>`
      SELECT metadata
      FROM mail.activity_events
      WHERE action = 'conversation.split' AND conversation_id = ${targetConversationId}::uuid
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(splitActivity?.metadata.createdConversationId).toBe(split.data.created.id);

    await sql`DELETE FROM mail.conversation_messages WHERE message_id = ${sourceMessageId}::uuid`;
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: {
        remoteRef: { folderStableKey: folderId, uidValidity: "2", uid: "1", modseq: "2" },
        providerMessageId: `thread-source-provider-${suffix}`,
        providerThreadId: "provider-would-merge",
        messageId: sourceMessageEnvelopeId,
        inReplyTo: `<thread-target-${suffix}@example.com>`,
        references: [`<thread-target-${suffix}@example.com>`],
        subject: "Re: Thread target",
        sentAt: new Date("2026-07-13T11:00:00.000Z"),
        internalDate: new Date("2026-07-13T11:00:00.000Z"),
        sizeBytes: 128,
        flags: [],
        labels: [],
        addresses: {
          from: [{ name: "Customer", address: "customer@example.com" }],
          replyTo: [],
          to: [{ name: "Support", address: "support@example.com" }],
          cc: [],
          bcc: [],
        },
        mimeStructure: {},
      },
    });
    const [reindexed] = await sql<{ conversation_id: string; added_by: string }[]>`
      SELECT conversation_id, added_by
      FROM mail.conversation_messages
      WHERE message_id = ${sourceMessageId}::uuid
    `;
    expect(reindexed).toEqual({ conversation_id: split.data.created.id, added_by: "manual" });
    const [uidValidityProjection] = await sql<{ contents: number; refs: number; canonical_refs: number }[]>`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM mail.message_contents
          WHERE mailbox_id = ${mailboxId}::uuid AND lower(message_id) = lower(${sourceMessageEnvelopeId})
        ) AS contents,
        (
          SELECT COUNT(*)::int
          FROM mail.remote_message_refs remote_ref
          WHERE remote_ref.folder_id = ${folderId}::uuid
            AND remote_ref.message_id = ${sourceMessageId}::uuid
        ) AS refs,
        (
          SELECT COUNT(*)::int
          FROM mail.remote_message_refs remote_ref
          WHERE remote_ref.folder_id = ${folderId}::uuid
            AND remote_ref.uid_validity = 2
            AND remote_ref.uid = 1
            AND remote_ref.message_id = ${sourceMessageId}::uuid
        ) AS canonical_refs
    `;
    expect(uidValidityProjection).toEqual({ contents: 1, refs: 2, canonical_refs: 1 });
  }, 30_000);

  test("reassigns one message atomically with permission and revision fencing", async () => {
    const conversations = await sql<{ id: string; subject: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES
        (${newShortId()}, ${mailboxId}::uuid, 'Reassign source', 'Customer', '2026-07-13T12:20:00.000Z'),
        (${newShortId()}, ${mailboxId}::uuid, 'Reassign target', 'Customer', '2026-07-13T12:30:00.000Z')
      RETURNING id, subject
    `;
    const source = conversations.find((conversation) => conversation.subject === "Reassign source")!;
    const target = conversations.find((conversation) => conversation.subject === "Reassign target")!;
    const contents = await sql<{ id: string; subject: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status,
        in_reply_to, reference_ids, selected_headers
      ) VALUES
        (${newShortId()},
          ${mailboxId}::uuid, ${`<reassign-source-a-${suffix}@example.com>`}, 'Reassign source', 'reassign source',
          '2026-07-13T12:10:00.000Z', 128, ${"1".repeat(64)}, 'complete', NULL, '{}'::text[], '{}'::jsonb
        ),
        (
          ${newShortId()},${mailboxId}::uuid, ${`<reassign-source-b-${suffix}@example.com>`}, 'Reassign source', 'reassign source',
          '2026-07-13T12:20:00.000Z', 128, ${"2".repeat(64)}, 'complete', NULL, '{}'::text[], '{}'::jsonb
        ),
        (
          ${newShortId()},${mailboxId}::uuid, ${`<reassign-target-${suffix}@example.com>`}, 'Reassign target', 'reassign target',
          '2026-07-13T12:30:00.000Z', 128, ${"3".repeat(64)}, 'complete',
          ${`<reassign-source-a-${suffix}@example.com>`},
          ARRAY[${`<reassign-source-a-${suffix}@example.com>`}]::text[],
          ${{ autoSubmitted: "no" }}::jsonb
        )
      RETURNING id, subject
    `;
    const sourceMessages = contents.filter((message) => message.subject === "Reassign source");
    const targetMessage = contents.find((message) => message.subject === "Reassign target")!;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES
        (${source.id}::uuid, ${sourceMessages[0]!.id}::uuid, 1, 'headers'),
        (${source.id}::uuid, ${sourceMessages[1]!.id}::uuid, 2, 'headers'),
        (${target.id}::uuid, ${targetMessage.id}::uuid, 1, 'headers')
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${targetMessage.id}::uuid, 'from', 0, 'Support', 'support@example.com', 'support@example.com')
    `;

    const denied = await reassignConversationMessage({
      context: readerContext,
      mailboxId,
      sourceConversationId: source.id,
      messageId: sourceMessages[1]!.id,
      input: { targetConversationId: target.id, expectedSourceRevision: 1, expectedTargetRevision: 1, confirm: true },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.status).toBe(403);

    const stale = await reassignConversationMessage({
      context: writerContext,
      mailboxId,
      sourceConversationId: source.id,
      messageId: sourceMessages[1]!.id,
      input: { targetConversationId: target.id, expectedSourceRevision: 2, expectedTargetRevision: 1, confirm: true },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.status).toBe(409);

    const moved = await reassignConversationMessage({
      context: writerContext,
      mailboxId,
      sourceConversationId: source.id,
      messageId: sourceMessages[1]!.id,
      input: {
        targetConversationId: target.id,
        expectedSourceRevision: 1,
        expectedTargetRevision: 1,
        reason: "Correct a provider thread",
        confirm: true,
      },
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.data).toMatchObject({
      messageId: sourceMessages[1]!.id,
      source: { id: source.id, revision: 2, messageCount: 1 },
      target: { id: target.id, revision: 2, messageCount: 2 },
    });
    const [projection] = await sql<{ conversation_id: string; reason: string; work_status: string }[]>`
      SELECT link.conversation_id::text, override.reason, conversation.work_status
      FROM mail.conversation_messages link
      JOIN mail.conversation_thread_overrides override ON override.message_id = link.message_id
      JOIN mail.conversations conversation ON conversation.id = link.conversation_id
      WHERE link.message_id = ${sourceMessages[1]!.id}::uuid
    `;
    expect(projection).toEqual({ conversation_id: target.id, reason: "merge", work_status: "waiting" });
  });

  test("rolls back a split when a selected message disappears after validation", async () => {
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Concurrent split', '', '2026-07-13T12:10:00.000Z')
      RETURNING id
    `;
    const keepInternetMessageId = `<split-keep-${suffix}@example.com>`;
    const disappearingInternetMessageId = `<split-disappears-${suffix}@example.com>`;
    const messages = await sql<{ id: string; message_id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES
        (${newShortId()},
          ${mailboxId}::uuid,
          ${keepInternetMessageId},
          'Concurrent split',
          'concurrent split',
          '2026-07-13T12:00:00.000Z',
          128,
          ${"c".repeat(64)},
          'complete'
        ),
        (
          ${newShortId()},${mailboxId}::uuid,
          ${disappearingInternetMessageId},
          'Concurrent split',
          'concurrent split',
          '2026-07-13T12:10:00.000Z',
          128,
          ${"d".repeat(64)},
          'complete'
        )
      RETURNING id, message_id
    `;
    const keepMessageId = messages.find((message) => message.message_id === keepInternetMessageId)!.id;
    const disappearingMessageId = messages.find((message) => message.message_id === disappearingInternetMessageId)!.id;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES
        (${conversation!.id}::uuid, ${keepMessageId}::uuid, 1, 'headers'),
        (${conversation!.id}::uuid, ${disappearingMessageId}::uuid, 2, 'headers')
    `;
    const [before] = await sql<{ conversations: number }[]>`
      SELECT COUNT(*)::int AS conversations FROM mail.conversations WHERE mailbox_id = ${mailboxId}::uuid
    `;

    let releaseDelete: () => void = () => undefined;
    let markLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deletion = sql.begin(async (tx) => {
      await tx`
        SELECT message_id
        FROM mail.conversation_messages
        WHERE message_id = ${disappearingMessageId}::uuid
        FOR UPDATE
      `;
      markLocked();
      await released;
      await tx`DELETE FROM mail.message_contents WHERE id = ${disappearingMessageId}::uuid`;
    });
    await locked;
    const split = splitConversation({
      context: writerContext,
      mailboxId,
      conversationId: conversation!.id,
      input: { messageIds: [disappearingMessageId], expectedRevision: 1, confirm: true },
    });
    let splitWaitingOnMessage = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [waiting] = await sql<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%UPDATE mail.conversation_messages%'
        ) AS waiting
      `;
      if (waiting?.waiting) {
        splitWaitingOnMessage = true;
        break;
      }
      await Bun.sleep(10);
    }
    releaseDelete();
    await deletion;
    const result = await split;
    expect(splitWaitingOnMessage).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(409);
    const [after] = await sql<{ conversations: number; source_messages: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.conversations WHERE mailbox_id = ${mailboxId}::uuid) AS conversations,
        (
          SELECT COUNT(*)::int
          FROM mail.conversation_messages
          WHERE conversation_id = ${conversation!.id}::uuid
        ) AS source_messages
    `;
    expect(after).toEqual({ conversations: before!.conversations, source_messages: 1 });
  }, 30_000);

  test("projects the latest verified message when a newer envelope fails hydration", async () => {
    const olderDate = new Date("2026-07-13T11:30:00.000Z");
    const newerDate = new Date("2026-07-13T11:45:00.000Z");
    const olderMessageId = `<verified-before-failure-${suffix}@example.com>`;
    const newerMessageId = `<failed-after-verified-${suffix}@example.com>`;
    const envelope = (params: { uid: string; messageId: string; date: Date; inReplyTo: string | null }) => ({
      remoteRef: { folderStableKey: folderId, uidValidity: "8", uid: params.uid, modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId: params.messageId,
      inReplyTo: params.inReplyTo,
      references: params.inReplyTo ? [params.inReplyTo] : [],
      subject: params.inReplyTo ? "Re: Verified projection" : "Verified projection",
      sentAt: params.date,
      internalDate: params.date,
      sizeBytes: 128,
      flags: [],
      labels: [],
      addresses: {
        from: [{ name: "Customer", address: "projection@example.com" }],
        replyTo: [],
        to: [{ name: "Support", address: "support@example.com" }],
        cc: [],
        bcc: [],
      },
      mimeStructure: {},
    });
    const olderEnvelope = envelope({ uid: "1", messageId: olderMessageId, date: olderDate, inReplyTo: null });
    const olderId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: olderEnvelope });
    const [link] = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id FROM mail.conversation_messages WHERE message_id = ${olderId}::uuid
    `;
    if (!link) throw new Error("Verified projection fixture was not threaded");
    await sql`
      UPDATE mail.conversations
      SET work_status = 'done', revision = revision + 1
      WHERE id = ${link.conversation_id}::uuid
    `;

    const newerEnvelope = envelope({ uid: "2", messageId: newerMessageId, date: newerDate, inReplyTo: olderMessageId });
    const newerId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message: newerEnvelope });
    const newerSource = Buffer.from(
      [
        `Message-ID: ${newerMessageId}`,
        `In-Reply-To: ${olderMessageId}`,
        "From: Customer <projection@example.com>",
        "To: Support <support@example.com>",
        "Subject: Re: Verified projection",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "This source intentionally fails its advertised size.",
      ].join("\r\n"),
    );
    await expect(
      hydrateMessageFromSource({
        messageId: newerId,
        source: Readable.from([newerSource]),
        expectedSize: newerSource.byteLength + 1,
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_SIZE_MISMATCH" });
    const [pendingProjection] = await sql<{ work_status: string; revision: number }[]>`
      SELECT work_status, revision::int AS revision
      FROM mail.conversations
      WHERE id = ${link.conversation_id}::uuid
    `;
    expect(pendingProjection).toEqual({ work_status: "done", revision: 2 });

    const olderSource = Buffer.from(
      [
        `Message-ID: ${olderMessageId}`,
        "From: Customer <projection@example.com>",
        "To: Support <support@example.com>",
        "Subject: Verified projection",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "This older source is verified.",
      ].join("\r\n"),
    );
    await hydrateMessageFromSource({ messageId: olderId, source: Readable.from([olderSource]), expectedSize: olderSource.byteLength });
    const [verifiedProjection] = await sql<
      {
        work_status: string;
        revision: number;
        latest_message_at: Date | string;
        newer_hydration_status: string;
        state_events: number;
      }[]
    >`
      SELECT
        conversation.work_status,
        conversation.revision::int AS revision,
        conversation.latest_message_at,
        newer.hydration_status AS newer_hydration_status,
        (
          SELECT COUNT(*)::int
          FROM mail.activity_events activity
          WHERE activity.action = 'conversation.work_state_changed'
            AND activity.metadata ->> 'messageId' = ${olderId}
        ) AS state_events
      FROM mail.conversations conversation
      JOIN mail.message_contents newer ON newer.id = ${newerId}::uuid
      WHERE conversation.id = ${link.conversation_id}::uuid
    `;
    expect(verifiedProjection).toMatchObject({
      work_status: "needs_action",
      revision: 3,
      newer_hydration_status: "failed",
      state_events: 1,
    });
    expect(new Date(verifiedProjection!.latest_message_at).toISOString()).toBe(olderDate.toISOString());
  }, 30_000);

  test("does not collapse distinct generic IMAP messages with matching envelope metadata", async () => {
    const messageId = `<generic-collision-${suffix}@example.com>`;
    const date = new Date("2026-07-13T12:00:00.000Z");
    const rawMessage = (body: string) =>
      Buffer.from(
        [
          `Message-ID: ${messageId}`,
          "Date: Mon, 13 Jul 2026 12:00:00 +0000",
          "From: Customer <collision@example.com>",
          "To: Support <support@example.com>",
          "Subject: Generic IMAP collision guard",
          "Content-Type: text/plain; charset=utf-8",
          "",
          body,
        ].join("\r\n"),
      );
    const firstSource = rawMessage("Body A");
    const secondSource = rawMessage("Body B");
    const envelope = (uidValidity: string) => ({
      remoteRef: { folderStableKey: folderId, uidValidity, uid: "1", modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId,
      inReplyTo: null,
      references: [],
      subject: "Generic IMAP collision guard",
      sentAt: date,
      internalDate: date,
      sizeBytes: firstSource.byteLength,
      flags: [],
      labels: [],
      addresses: {
        from: [{ name: "Customer", address: "collision@example.com" }],
        replyTo: [],
        to: [{ name: "Support", address: "support@example.com" }],
        cc: [],
        bcc: [],
      },
      mimeStructure: {},
    });
    const firstId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: envelope("3"),
    });
    const secondId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: envelope("4"),
    });
    expect(secondId).not.toBe(firstId);
    expect(
      await hydrateMessageFromSource({
        messageId: firstId,
        source: Readable.from([firstSource]),
        expectedSize: firstSource.byteLength,
      }),
    ).toMatchObject({ status: "hydrated" });
    expect(
      await hydrateMessageFromSource({
        messageId: secondId,
        source: Readable.from([secondSource]),
        expectedSize: secondSource.byteLength,
      }),
    ).toMatchObject({ status: "hydrated" });
    const [projection] = await sql<{ contents: number; refs: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid AND message_id = ${messageId}) AS contents,
        (
          SELECT COUNT(*)::int
          FROM mail.remote_message_refs remote_ref
          JOIN mail.message_contents message ON message.id = remote_ref.message_id
          WHERE message.mailbox_id = ${mailboxId}::uuid AND message.message_id = ${messageId}
        ) AS refs
    `;
    expect(projection).toEqual({ contents: 2, refs: 2 });
  }, 30_000);

  test("reuses exact hydrated source identity across a generic IMAP UIDVALIDITY reset", async () => {
    const messageId = `<generic-reset-${suffix}@example.com>`;
    const date = new Date("2026-07-13T13:00:00.000Z");
    const source = Buffer.from(
      [
        `Message-ID: ${messageId}`,
        "Date: Mon, 13 Jul 2026 13:00:00 +0000",
        "From: Customer <reset@example.com>",
        "To: Support <support@example.com>",
        "Subject: Generic UIDVALIDITY reset",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Stable source body",
      ].join("\r\n"),
    );
    const envelope = (uidValidity: string) => ({
      remoteRef: { folderStableKey: folderId, uidValidity, uid: "1", modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId,
      inReplyTo: null,
      references: [],
      subject: "Generic UIDVALIDITY reset",
      sentAt: date,
      internalDate: date,
      sizeBytes: source.byteLength,
      flags: [],
      labels: [],
      addresses: {
        from: [{ name: "Customer", address: "reset@example.com" }],
        replyTo: [],
        to: [{ name: "Support", address: "support@example.com" }],
        cc: [],
        bcc: [],
      },
      mimeStructure: {},
    });
    const canonicalId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: envelope("5"),
    });
    await hydrateMessageFromSource({
      messageId: canonicalId,
      source: Readable.from([source]),
      expectedSize: source.byteLength,
    });
    await sql`UPDATE mail.message_contents SET source_blob_id = NULL WHERE id = ${canonicalId}::uuid`;
    const [canonicalLink] = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id FROM mail.conversation_messages WHERE message_id = ${canonicalId}::uuid
    `;
    if (!canonicalLink) throw new Error("Canonical reset fixture was not threaded");
    await sql`
      INSERT INTO mail.conversation_thread_overrides (
        message_id, mailbox_id, conversation_id, reason, actor_kind, actor_id
      ) VALUES (
        ${canonicalId}::uuid,
        ${mailboxId}::uuid,
        ${canonicalLink.conversation_id}::uuid,
        'split',
        'user',
        ${writer.id}::uuid
      )
    `;
    const preservedSnooze = new Date(Date.now() + 60 * 60_000).toISOString();
    await sql`
      UPDATE mail.conversations
      SET work_status = 'waiting', snoozed_until = ${preservedSnooze}::timestamptz, revision = revision + 1
      WHERE id = ${canonicalLink.conversation_id}::uuid
    `;

    const resetId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: envelope("6"),
    });
    expect(resetId).not.toBe(canonicalId);
    const [stateBeforeHydration] = await sql<{ work_status: string; snoozed_until: Date | string | null }[]>`
      SELECT work_status, snoozed_until
      FROM mail.conversations
      WHERE id = ${canonicalLink.conversation_id}::uuid
    `;
    expect(stateBeforeHydration).toMatchObject({ work_status: "waiting" });
    expect(new Date(stateBeforeHydration!.snoozed_until!).toISOString()).toBe(preservedSnooze);
    const hydrated = await hydrateMessageFromSource({
      messageId: resetId,
      source: Readable.from([source]),
      expectedSize: source.byteLength,
    });
    expect(hydrated).toMatchObject({ status: "deduplicated", canonicalMessageId: canonicalId });
    const [canonicalSource] = await sql<{ source_blob_id: string | null }[]>`
      SELECT source_blob_id FROM mail.message_contents WHERE id = ${canonicalId}::uuid
    `;
    expect(canonicalSource?.source_blob_id).not.toBeNull();
    const [projection] = await sql<
      {
        contents: number;
        refs: number;
        links: number;
        override_conversation_id: string;
        work_status: string;
        snoozed_until: Date | string | null;
        state_events: number;
      }[]
    >`
      SELECT
        (SELECT COUNT(*)::int FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid AND message_id = ${messageId}) AS contents,
        (SELECT COUNT(*)::int FROM mail.remote_message_refs WHERE message_id = ${canonicalId}::uuid) AS refs,
        (SELECT COUNT(*)::int FROM mail.conversation_messages WHERE message_id = ${canonicalId}::uuid) AS links,
        (
          SELECT conversation_id::text
          FROM mail.conversation_thread_overrides
          WHERE message_id = ${canonicalId}::uuid
        ) AS override_conversation_id,
        conversation.work_status,
        conversation.snoozed_until,
        (
          SELECT COUNT(*)::int
          FROM mail.activity_events activity
          WHERE activity.action = 'conversation.work_state_changed'
            AND activity.metadata ->> 'messageId' = ${resetId}
        ) AS state_events
      FROM mail.conversations conversation
      WHERE conversation.id = ${canonicalLink.conversation_id}::uuid
    `;
    expect(projection).toMatchObject({
      contents: 1,
      refs: 2,
      links: 1,
      override_conversation_id: canonicalLink.conversation_id,
      work_status: "waiting",
      state_events: 0,
    });
    expect(new Date(projection!.snoozed_until!).toISOString()).toBe(preservedSnooze);

    const incompatibleResetId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: envelope("7"),
    });
    const incompatibleSnooze = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const [manualConversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id,
        mailbox_id, subject, participant_summary, latest_inbound_at, latest_message_at,
        work_status, snoozed_until
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        'Manually separated exact copy',
        'Customer',
        ${date},
        ${date},
        'waiting',
        ${incompatibleSnooze}::timestamptz
      )
      RETURNING id
    `;
    await sql`
      UPDATE mail.conversation_messages
      SET conversation_id = ${manualConversation!.id}::uuid, added_by = 'manual'
      WHERE message_id = ${incompatibleResetId}::uuid
    `;
    await sql`
      INSERT INTO mail.conversation_thread_overrides (
        message_id, mailbox_id, conversation_id, reason, actor_kind, actor_id
      ) VALUES (
        ${incompatibleResetId}::uuid,
        ${mailboxId}::uuid,
        ${manualConversation!.id}::uuid,
        'split',
        'user',
        ${writer.id}::uuid
      )
    `;
    const incompatibleHydration = await hydrateMessageFromSource({
      messageId: incompatibleResetId,
      source: Readable.from([source]),
      expectedSize: source.byteLength,
    });
    expect(incompatibleHydration).toMatchObject({ status: "hydrated" });
    const [incompatibleProjection] = await sql<
      {
        contents: number;
        work_status: string;
        snoozed_until: Date | string | null;
        revision: number;
        state_events: number;
      }[]
    >`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM mail.message_contents
          WHERE mailbox_id = ${mailboxId}::uuid AND message_id = ${messageId}
        ) AS contents,
        conversation.work_status,
        conversation.snoozed_until,
        conversation.revision::int AS revision,
        (
          SELECT COUNT(*)::int
          FROM mail.activity_events activity
          WHERE activity.action = 'conversation.work_state_changed'
            AND activity.metadata ->> 'messageId' = ${incompatibleResetId}
        ) AS state_events
      FROM mail.conversations conversation
      WHERE conversation.id = ${manualConversation!.id}::uuid
    `;
    expect(incompatibleProjection).toMatchObject({
      contents: 2,
      work_status: "waiting",
      revision: 1,
      state_events: 0,
    });
    expect(new Date(incompatibleProjection!.snoozed_until!).toISOString()).toBe(incompatibleSnooze);

    const thirdResetId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId,
      message: envelope("9"),
    });
    await sql`
      UPDATE mail.conversation_messages
      SET conversation_id = ${manualConversation!.id}::uuid, added_by = 'manual'
      WHERE message_id = ${thirdResetId}::uuid
    `;
    await sql`
      INSERT INTO mail.conversation_thread_overrides (
        message_id, mailbox_id, conversation_id, reason, actor_kind, actor_id
      ) VALUES (
        ${thirdResetId}::uuid,
        ${mailboxId}::uuid,
        ${manualConversation!.id}::uuid,
        'split',
        'user',
        ${writer.id}::uuid
      )
    `;
    const thirdHydration = await hydrateMessageFromSource({
      messageId: thirdResetId,
      source: Readable.from([source]),
      expectedSize: source.byteLength,
    });
    expect(thirdHydration).toMatchObject({ status: "deduplicated", canonicalMessageId: incompatibleResetId });
    const [thirdProjection] = await sql<{ contents: number; refs: number; work_status: string; revision: number; state_events: number }[]>`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM mail.message_contents
          WHERE mailbox_id = ${mailboxId}::uuid AND message_id = ${messageId}
        ) AS contents,
        (
          SELECT COUNT(*)::int
          FROM mail.remote_message_refs
          WHERE message_id = ${incompatibleResetId}::uuid
        ) AS refs,
        conversation.work_status,
        conversation.revision::int AS revision,
        (
          SELECT COUNT(*)::int
          FROM mail.activity_events activity
          WHERE activity.action = 'conversation.work_state_changed'
            AND activity.metadata ->> 'messageId' = ${thirdResetId}
        ) AS state_events
      FROM mail.conversations conversation
      WHERE conversation.id = ${manualConversation!.id}::uuid
    `;
    expect(thirdProjection).toEqual({
      contents: 2,
      refs: 2,
      work_status: "waiting",
      revision: 1,
      state_events: 0,
    });
  }, 30_000);
});
