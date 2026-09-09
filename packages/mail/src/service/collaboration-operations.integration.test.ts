import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encryptSecret } from "@k2b/cloud/services";
import { sql } from "bun";
import { app } from "../config";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { createMailNotificationService, type MailNotificationSendInput } from "../notifications";
import { grantMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { getConversationCollaboration, listActivity, listConversationComments } from "./collaboration";
import { createMailbox } from "./mailboxes";
import { getConversationPresence, heartbeatConversationPresence, leaveConversationPresence } from "./presence";
import { cancelConversationReminder, getConversationReminder, setConversationReminder } from "./reminders";
import {
  createSavedConversationView,
  deleteSavedConversationView,
  listSavedConversationViews,
  listSavedViewConversations,
  updateSavedConversationView,
} from "./saved-views";

const enabled = process.env.MAIL_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;

type TestUser = { id: string; uid: string; displayName: string };

const contextFor = (user: TestUser): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.displayName,
      givenName: user.displayName,
      sn: "Test",
      mail: `${user.uid}@example.com`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-collaboration-operations-${user.uid}`,
});

suite("mail collaboration operations", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const accessIds: string[] = [];
  let mailboxId = "";
  let remoteResourceId = "";
  let conversationId = "";
  let writerAccessId = "";
  let readerAccessId = "";
  let owner: TestUser;
  let writer: TestUser;
  let reader: TestUser;
  let ownerContext: MailRequestContext;
  let writerContext: MailRequestContext;
  let readerContext: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const createUser = async (role: string): Promise<TestUser> => {
      const uid = `mail-ops-${role}-${suffix}`;
      const displayName = `${role[0]!.toUpperCase()}${role.slice(1)} Mail Operations`;
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${displayName}, false)
        RETURNING id
      `;
      if (!row) throw new Error(`Failed to create ${role} user`);
      userIds.push(row.id);
      return { id: row.id, uid, displayName };
    };

    owner = await createUser("owner");
    writer = await createUser("writer");
    reader = await createUser("reader");
    ownerContext = contextFor(owner);
    writerContext = contextFor(writer);
    readerContext = contextFor(reader);

    const mailbox = await createMailbox(ownerContext, {
      name: `Collaboration operations ${suffix}`,
      description: "Disposable collaboration operations fixture",
    });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const writerAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: writer.id },
      permission: "write",
    });
    if (!writerAccess.ok) throw new Error(writerAccess.error.message);
    writerAccessId = writerAccess.data.id;
    accessIds.push(writerAccessId);
    const readerAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: reader.id },
      permission: "read",
    });
    if (!readerAccess.ok) throw new Error(readerAccess.error.message);
    readerAccessId = readerAccess.data.id;
    accessIds.push(readerAccessId);

    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"d".repeat(64)}, 'active')
      RETURNING id
    `;
    remoteResourceId = resource!.id;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'operations-inbox', 'Inbox', 'inbox', 'current')
      RETURNING id
    `;
    const messageDate = new Date(Date.now() - 60_000);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<mail-ops-${suffix}@example.com>`},
        'Collaboration operations',
        'collaboration operations',
        ${messageDate},
        128,
        ${"e".repeat(64)},
        'complete',
        'Collaboration operations body'
      )
      RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder!.id}::uuid, ${message!.id}::uuid, 1, 1)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${remoteRef!.id}::uuid, ${folder!.id}::uuid, ${message!.id}::uuid, ARRAY[]::text[], ARRAY[]::text[])
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id,
        mailbox_id, subject, participant_summary, latest_message_at, assignee_user_id, work_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        'Collaboration operations',
        'customer@example.com',
        ${messageDate},
        ${writer.id}::uuid,
        'needs_action'
      )
      RETURNING id
    `;
    conversationId = conversation!.id;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversationId}::uuid, ${message!.id}::uuid, ${messageDate.getTime()}, 'headers')
    `;
  });

  afterAll(async () => {
    if (mailboxId) {
      const mailboxAccess = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      accessIds.push(...mailboxAccess.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    const uniqueAccessIds = [...new Set(accessIds)];
    if (uniqueAccessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${uniqueAccessIds}::jsonb))`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("recovers reminders and enforces view, presence, and lease invariants", async () => {
    const sent: MailNotificationSendInput[] = [];
    const notificationService = createMailNotificationService(app.notifications, {
      sender: async (input) => {
        sent.push(input);
      },
    });

    const dueAt = new Date(Date.now() - 1_000).toISOString();
    const reminder = await setConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { dueAt, expectedRevision: null },
    });
    expect(reminder.ok && reminder.data.revision).toBe(1);
    const duplicateCreate = await setConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { dueAt, expectedRevision: null },
    });
    expect(duplicateCreate.ok).toBe(false);
    if (!duplicateCreate.ok) expect(duplicateCreate.error.status).toBe(409);
    const rescheduled = await setConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { dueAt, expectedRevision: 1 },
    });
    expect(rescheduled.ok && rescheduled.data.revision).toBe(2);
    const reminderRecovery = await notificationService.recover();
    expect(reminderRecovery).toMatchObject({ scanned: 1, sent: 1, skipped: 0, failed: 0 });
    expect(sent.filter((item) => item.kind === "reminder")).toHaveLength(1);
    const deliveredReminder = await getConversationReminder({ context: writerContext, mailboxId, conversationId });
    expect(deliveredReminder.ok && deliveredReminder.data).toMatchObject({ state: "sent", revision: 2 });
    const resetReminder = await setConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { dueAt: new Date(Date.now() + 60_000).toISOString(), expectedRevision: 2 },
    });
    expect(resetReminder.ok && resetReminder.data.revision).toBe(3);
    const canceledReminder = await cancelConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { expectedRevision: 3 },
    });
    expect(canceledReminder.ok && canceledReminder.data).toMatchObject({ state: "canceled", revision: 4 });
    const dispatchReminder = await setConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { dueAt, expectedRevision: 4 },
    });
    expect(dispatchReminder.ok && dispatchReminder.data.revision).toBe(5);
    let markDispatchStarted: () => void = () => undefined;
    let releaseDispatch: () => void = () => undefined;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const dispatchReleased = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const blockingNotificationService = createMailNotificationService(app.notifications, {
      sender: async () => {
        markDispatchStarted();
        await dispatchReleased;
      },
    });
    const dispatchRecovery = blockingNotificationService.recover();
    await dispatchStarted;
    const cancelDuringDispatch = await cancelConversationReminder({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { expectedRevision: 5 },
    });
    expect(cancelDuringDispatch.ok).toBe(false);
    if (!cancelDuringDispatch.ok) expect(cancelDuringDispatch.error.status).toBe(409);
    releaseDispatch();
    expect(await dispatchRecovery).toMatchObject({ scanned: 1, sent: 1, skipped: 0, failed: 0 });
    if (reminder.ok) {
      const [activity] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM mail.activity_events
        WHERE target_type = 'reminder' AND target_id = ${reminder.data.id}::uuid
      `;
      expect(activity?.count).toBe(0);
    }

    const privateView = await createSavedConversationView({
      context: readerContext,
      mailboxId,
      input: {
        scope: "private",
        name: "My action queue",
        filter: { expression: { type: "work_status", value: "needs_action" }, sort: "newest" },
      },
    });
    expect(privateView.ok).toBe(true);
    if (!privateView.ok) return;
    const [privateViewActivity] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.activity_events
      WHERE target_type = 'saved_conversation_view' AND target_id = ${privateView.data.id}::uuid
    `;
    expect(privateViewActivity?.count).toBe(0);
    const deniedMailboxView = await createSavedConversationView({
      context: readerContext,
      mailboxId,
      input: { scope: "mailbox", name: "Reader team view", filter: { expression: { type: "all" }, sort: "newest" } },
    });
    expect(deniedMailboxView.ok).toBe(false);
    const invalidAssigneeView = await createSavedConversationView({
      context: writerContext,
      mailboxId,
      input: {
        scope: "mailbox",
        name: "Invalid assignee",
        filter: { expression: { type: "assignee", userId: reader.id }, sort: "newest" },
      },
    });
    expect(invalidAssigneeView.ok).toBe(false);
    const mailboxView = await createSavedConversationView({
      context: writerContext,
      mailboxId,
      input: {
        scope: "mailbox",
        name: "Assigned to me",
        filter: {
          expression: {
            type: "and",
            expressions: [{ type: "assigned_to_me" }, { type: "work_status", value: "needs_action" }],
          },
          sort: "newest",
        },
      },
    });
    expect(mailboxView.ok).toBe(true);
    if (!mailboxView.ok) return;
    const [mailboxViewActivity] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.activity_events
      WHERE target_type = 'saved_conversation_view' AND target_id = ${mailboxView.data.id}::uuid
    `;
    expect(mailboxViewActivity?.count).toBe(1);
    const writerViews = await listSavedConversationViews({ context: writerContext, mailboxId });
    expect(writerViews.ok && writerViews.data.map((view) => view.id)).toContain(mailboxView.data.id);
    expect(writerViews.ok && writerViews.data.map((view) => view.id)).not.toContain(privateView.data.id);
    const readerViews = await listSavedConversationViews({ context: readerContext, mailboxId });
    expect(readerViews.ok && readerViews.data.map((view) => view.id).sort()).toEqual([privateView.data.id, mailboxView.data.id].sort());
    const writerQueue = await listSavedViewConversations({
      context: writerContext,
      mailboxId,
      viewId: mailboxView.data.id,
    });
    expect(writerQueue.ok && writerQueue.data.items.map((item) => item.id)).toContain(conversationId);
    const ownerQueue = await listSavedViewConversations({ context: ownerContext, mailboxId, viewId: mailboxView.data.id });
    expect(ownerQueue.ok && ownerQueue.data.items.map((item) => item.id)).not.toContain(conversationId);
    const staleViewUpdate = await updateSavedConversationView({
      context: writerContext,
      mailboxId,
      viewId: mailboxView.data.id,
      input: { expectedRevision: 2, name: "Stale" },
    });
    expect(staleViewUpdate.ok).toBe(false);
    if (!staleViewUpdate.ok) expect(staleViewUpdate.error.status).toBe(409);
    const updatedView = await updateSavedConversationView({
      context: writerContext,
      mailboxId,
      viewId: mailboxView.data.id,
      input: { expectedRevision: 1, name: "My active assignments" },
    });
    expect(updatedView.ok && updatedView.data.revision).toBe(2);
    const deletedPrivateView = await deleteSavedConversationView({
      context: readerContext,
      mailboxId,
      viewId: privateView.data.id,
      expectedRevision: 1,
    });
    expect(deletedPrivateView.ok).toBe(true);

    const readerPeerId = crypto.randomUUID();
    const writerPeerId = crypto.randomUUID();
    const readerPresence = await heartbeatConversationPresence({
      context: readerContext,
      mailboxId,
      conversationId,
      input: { peerId: readerPeerId, mode: "viewing" },
    });
    expect(readerPresence.ok).toBe(true);
    const deniedComposing = await heartbeatConversationPresence({
      context: readerContext,
      mailboxId,
      conversationId,
      input: { peerId: readerPeerId, mode: "composing" },
    });
    expect(deniedComposing.ok).toBe(false);
    const writerPresence = await heartbeatConversationPresence({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { peerId: writerPeerId, mode: "composing" },
    });
    expect(writerPresence.ok && writerPresence.data.participants).toHaveLength(2);
    const snapshot = await getConversationPresence({ context: ownerContext, mailboxId, conversationId });
    expect(snapshot.ok && snapshot.data.participants.find((participant) => participant.userId === writer.id)?.mode).toBe("composing");

    await leaveConversationPresence({ context: writerContext, mailboxId, conversationId, peerId: writerPeerId });
    await leaveConversationPresence({ context: readerContext, mailboxId, conversationId, peerId: readerPeerId });

    const staleReaderPresence = await heartbeatConversationPresence({
      context: readerContext,
      mailboxId,
      conversationId,
      input: { peerId: readerPeerId, mode: "viewing" },
    });
    expect(staleReaderPresence.ok).toBe(true);
    const revoked = await revokeMailboxAccess({ context: ownerContext, mailboxId, accessId: readerAccessId });
    expect(revoked.ok).toBe(true);
    const snapshotAfterReaderRevocation = await getConversationPresence({ context: ownerContext, mailboxId, conversationId });
    expect(
      snapshotAfterReaderRevocation.ok &&
        snapshotAfterReaderRevocation.data.participants.some((participant) => participant.userId === reader.id),
    ).toBe(false);
    const deniedAfterRevocation = await heartbeatConversationPresence({
      context: readerContext,
      mailboxId,
      conversationId,
      input: { peerId: readerPeerId, mode: "viewing" },
    });
    expect(deniedAfterRevocation.ok).toBe(false);

    const staleWriterPresence = await heartbeatConversationPresence({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { peerId: writerPeerId, mode: "composing" },
    });
    expect(staleWriterPresence.ok).toBe(true);
    const revokedWriter = await revokeMailboxAccess({ context: ownerContext, mailboxId, accessId: writerAccessId });
    expect(revokedWriter.ok).toBe(true);
    const snapshotAfterWriterRevocation = await getConversationPresence({ context: ownerContext, mailboxId, conversationId });
    expect(
      snapshotAfterWriterRevocation.ok &&
        snapshotAfterWriterRevocation.data.participants.some((participant) => participant.userId === writer.id),
    ).toBe(false);

    const restoredWriterAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: writer.id },
      permission: "write",
    });
    expect(restoredWriterAccess.ok).toBe(true);
    if (!restoredWriterAccess.ok) return;
    accessIds.push(restoredWriterAccess.data.id);
    const encryptedSecret = await encryptSecret({ kind: "password", password: "collaboration-fixture-secret" });
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username,
        imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode,
        secret_kind, encrypted_secret, status
      ) VALUES (
        ${mailboxId}::uuid,
        'Mailbox provider',
        'mailbox@example.com',
        'mailbox@example.com',
        'imap.example.com', 993, 'implicit',
        'smtp.example.com', 465, 'implicit',
        'password', ${encryptedSecret}, 'active'
      )
      RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator,
        verified_scope_fingerprint, verified_secret_revision
      ) VALUES (
        ${remoteResourceId}::uuid,
        ${connection!.id}::uuid,
        'active',
        '{}'::jsonb,
        ${"d".repeat(64)},
        1
      )
      RETURNING id
    `;
    const personalPeerId = crypto.randomUUID();
    const personalPresence = await heartbeatConversationPresence({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { peerId: personalPeerId, mode: "composing" },
    });
    expect(personalPresence.ok).toBe(true);
    await sql`
      UPDATE mail.provider_bindings
      SET state = 'revoked'
      WHERE id = ${binding!.id}::uuid
    `;
    const snapshotAfterBindingRevocation = await getConversationPresence({ context: ownerContext, mailboxId, conversationId });
    expect(
      snapshotAfterBindingRevocation.ok &&
        snapshotAfterBindingRevocation.data.participants.some((participant) => participant.userId === writer.id),
    ).toBe(true);
    const presenceAfterBindingRevocation = await heartbeatConversationPresence({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { peerId: personalPeerId, mode: "viewing" },
    });
    expect(presenceAfterBindingRevocation.ok).toBe(true);
    expect((await getConversationCollaboration({ context: writerContext, mailboxId, conversationId })).ok).toBe(true);
    expect((await listConversationComments({ context: writerContext, mailboxId, conversationId })).ok).toBe(true);
    expect((await listActivity({ context: writerContext, mailboxId, conversationId })).ok).toBe(true);
  }, 30_000);
});
