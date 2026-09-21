import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailSearchExpression } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import {
  addConversationLocalTags,
  createLocalTag,
  deleteLocalTag,
  getConversationLocalTags,
  listConversationLocalTags,
  listLocalTags,
  setConversationLocalTags,
  updateLocalTag,
} from "./local-tags";
import { createMailbox } from "./mailboxes";
import { listConversations } from "./messages";
import { searchMessages } from "./search";

const suite = suiteFor("database", "nats");

const contextFor = (user: { id: string; uid: string; displayName: string }): MailRequestContext => ({
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
  requestId: `mail-local-tags-${user.uid}`,
});

suite("mail local tags and structured search", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  const accessIds: string[] = [];
  let owner: { id: string; uid: string; displayName: string };
  let writer: { id: string; uid: string; displayName: string };
  let reader: { id: string; uid: string; displayName: string };
  let ownerContext: MailRequestContext;
  let writerContext: MailRequestContext;
  let readerContext: MailRequestContext;
  let mailboxId = "";
  let otherMailboxId = "";
  let conversationId = "";
  let messageId = "";
  let folderId = "";
  let blobId = "";

  beforeAll(async () => {
    await migrate();
    const createUser = async (role: string) => {
      const uid = `mail-local-tags-${role}-${suffix}`;
      const displayName = `${role} local tag test`;
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

    const mailbox = await createMailbox(ownerContext, { name: `Local tags ${suffix}` });
    const otherMailbox = await createMailbox(ownerContext, { name: `Other local tags ${suffix}` });
    if (!mailbox.ok || !otherMailbox.ok) throw new Error("Failed to create local tag mailboxes");
    mailboxId = mailbox.data.id;
    otherMailboxId = otherMailbox.data.id;
    mailboxIds.push(mailboxId, otherMailboxId);
    for (const [userId, permission] of [
      [writer.id, "write"],
      [reader.id, "read"],
    ] as const) {
      const access = await grantMailboxAccess({
        context: ownerContext,
        mailboxId,
        principal: { type: "user", userId },
        permission,
      });
      if (!access.ok) throw new Error(access.error.message);
      accessIds.push(access.data.id);
    }

    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)}, 'active')
      RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'priority-queue', 'Priority Queue', 'inbox', 'current')
      RETURNING id
    `;
    folderId = folder!.id;
    const internalDate = new Date(Date.now() - 60_000);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, sent_at, size_bytes,
        content_hash, hydration_status, plain_text
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid, ${`<local-tags-${suffix}@example.com>`}, 'Priority customer', 'priority customer',
        ${internalDate}, ${internalDate}, 4096, ${"b".repeat(64)}, 'complete', 'Structured search fixture body'
      )
      RETURNING id
    `;
    messageId = message!.id;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES
        (${messageId}::uuid, 'from', 0, 'Customer', 'customer@example.com', 'customer@example.com'),
        (${messageId}::uuid, 'to', 0, 'Support', 'support@example.com', 'support@example.com')
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder!.id}::uuid, ${messageId}::uuid, 1, 1)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${remoteRef!.id}::uuid, ${folder!.id}::uuid, ${messageId}::uuid, ARRAY[]::text[], ARRAY['RemoteImportant']::text[])
    `;
    const [blob] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_count, complete, completed_at)
      VALUES (${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 2048, 1, true, now())
      RETURNING id
    `;
    blobId = blob!.id;
    const [part] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status
      ) VALUES (${messageId}::uuid, '2', 'application/pdf', 'attachment', 'quarterly-invoice.pdf', 2048, ${blob!.id}::uuid, 'complete')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.attachments (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
      VALUES (${newShortId()}, ${messageId}::uuid, ${part!.id}::uuid, 'quarterly-invoice.pdf', 'application/pdf', 'attachment', 2048, ${blob!.id}::uuid)
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id,
        mailbox_id, subject, participant_summary, latest_message_at, assignee_user_id,
        work_status, snoozed_until
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid, 'Priority customer', 'Customer', ${internalDate}, ${writer.id}::uuid,
        'waiting', ${new Date(Date.now() + 60 * 60_000)}
      )
      RETURNING id
    `;
    conversationId = conversation!.id;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversationId}::uuid, ${messageId}::uuid, 1, 'headers')
    `;
    await sql`
      INSERT INTO mail.conversation_comments (short_id, conversation_id, author_kind, author_id, body_markdown)
      VALUES (${newShortId()}, ${conversationId}::uuid, 'user', ${writer.id}::uuid, 'Internal context for priority customer')
    `;
  });

  afterAll(async () => {
    if (mailboxIds.length > 0) {
      const mailboxAccess = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access
        WHERE mailbox_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxIds}::jsonb))
      `;
      accessIds.push(...mailboxAccess.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxIds}::jsonb))`;
    }
    if (blobId) await sql`DELETE FROM mail.message_part_blobs WHERE id = ${blobId}::uuid`;
    if (accessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...new Set(accessIds)]}::jsonb))`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("enforces write permission, normalized uniqueness, mailbox consistency, and revision fences", async () => {
    expect((await listLocalTags(readerContext, mailboxId)).ok).toBe(true);
    expect((await createLocalTag({ context: readerContext, mailboxId, input: { name: "Denied", color: "#6b7280" } })).ok).toBe(false);

    const created = await createLocalTag({
      context: writerContext,
      mailboxId,
      input: { name: "  Customer   Care  ", color: "#0f766e" },
    });
    expect(created.ok && created.data.name).toBe("Customer Care");
    expect(created.ok && created.data.color).toBe("#0f766e");
    if (!created.ok) return;
    const duplicate = await createLocalTag({
      context: writerContext,
      mailboxId,
      input: { name: "customer care", color: "#6b7280" },
    });
    expect(duplicate.ok).toBe(false);

    const updates = await Promise.all([
      updateLocalTag({
        context: writerContext,
        mailboxId,
        tagId: created.data.id,
        input: { expectedRevision: 1, name: "Priority", color: "#dc2626" },
      }),
      updateLocalTag({
        context: writerContext,
        mailboxId,
        tagId: created.data.id,
        input: { expectedRevision: 1, name: "Urgent", color: "#ea580c" },
      }),
    ]);
    expect(updates.filter((result) => result.ok)).toHaveLength(1);
    expect(updates.filter((result) => !result.ok)).toHaveLength(1);
    const current = await listLocalTags(writerContext, mailboxId);
    if (!current.ok) throw new Error(current.error.message);
    const tag = current.data[0]!;

    const otherTag = await createLocalTag({
      context: ownerContext,
      mailboxId: otherMailboxId,
      input: { name: "Other mailbox", color: "#6b7280" },
    });
    if (!otherTag.ok) throw new Error(otherTag.error.message);
    const crossMailbox = await setConversationLocalTags({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { expectedRevision: 1, tagIds: [otherTag.data.id] },
    });
    expect(crossMailbox.ok).toBe(false);

    const assigned = await setConversationLocalTags({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { expectedRevision: 1, tagIds: [tag.id] },
    });
    expect(assigned.ok && assigned.data.conversationRevision).toBe(2);
    expect(assigned.ok && assigned.data.tags.map((item) => item.id)).toEqual([tag.id]);
    const listed = await listConversationLocalTags({ context: readerContext, mailboxId, conversationIds: [conversationId] });
    expect(listed.ok && listed.data.get(conversationId)?.map((item) => ({ id: item.id, color: item.color }))).toEqual([
      { id: tag.id, color: tag.color },
    ]);
    const stale = await setConversationLocalTags({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { expectedRevision: 1, tagIds: [] },
    });
    expect(stale.ok).toBe(false);
    expect((await getConversationLocalTags({ context: readerContext, mailboxId, conversationId })).ok).toBe(true);

    const [evidence] = await sql<{ activities: number; audits: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.activity_events WHERE mailbox_id = ${mailboxId}::uuid AND action LIKE '%local_tag%') AS activities,
        (SELECT COUNT(*)::int FROM audit.events WHERE action LIKE 'mail.%local_tag%' AND target_id IN (${tag.id}, ${conversationId})) AS audits
    `;
    expect(evidence!.activities).toBeGreaterThanOrEqual(3);
    expect(evidence!.audits).toBeGreaterThanOrEqual(3);

    const disposable = await createLocalTag({
      context: writerContext,
      mailboxId,
      input: { name: "Disposable", color: "#6b7280" },
    });
    if (!disposable.ok) throw new Error(disposable.error.message);
    const assignedDisposable = await setConversationLocalTags({
      context: writerContext,
      mailboxId,
      conversationId,
      input: { expectedRevision: 2, tagIds: [tag.id, disposable.data.id] },
    });
    expect(assignedDisposable.ok).toBe(true);
    const deleted = await deleteLocalTag({
      context: writerContext,
      mailboxId,
      tagId: disposable.data.id,
      input: { expectedRevision: disposable.data.revision },
    });
    expect(deleted.ok).toBe(true);
    const stateAfterDelete = await getConversationLocalTags({ context: readerContext, mailboxId, conversationId });
    expect(stateAfterDelete.ok && stateAfterDelete.data.tags.map((item) => item.id)).toEqual([tag.id]);
    expect(stateAfterDelete.ok && stateAfterDelete.data.conversationRevision).toBe(4);

    const [secondConversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Second tagged conversation', 'Customer', now())
      RETURNING id
    `;
    const bulkTag = await createLocalTag({
      context: writerContext,
      mailboxId,
      input: { name: "Bulk assigned", color: "#2563eb" },
    });
    if (!secondConversation || !bulkTag.ok) throw new Error("Bulk tag fixtures could not be created");
    expect(
      (
        await addConversationLocalTags({
          context: readerContext,
          mailboxId,
          input: { conversationIds: [conversationId], tagIds: [bulkTag.data.id] },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await addConversationLocalTags({
          context: writerContext,
          mailboxId,
          input: { conversationIds: [conversationId], tagIds: [otherTag.data.id] },
        })
      ).ok,
    ).toBe(false);

    const bulkAssigned = await addConversationLocalTags({
      context: writerContext,
      mailboxId,
      input: { conversationIds: [secondConversation.id, conversationId], tagIds: [bulkTag.data.id] },
    });
    expect(bulkAssigned.ok && new Set(bulkAssigned.data.updatedConversationIds)).toEqual(new Set([conversationId, secondConversation.id]));
    const firstBulkState = await getConversationLocalTags({ context: readerContext, mailboxId, conversationId });
    expect(firstBulkState.ok && new Set(firstBulkState.data.tags.map((item) => item.id))).toEqual(new Set([tag.id, bulkTag.data.id]));
    expect(firstBulkState.ok && firstBulkState.data.conversationRevision).toBe(5);
    const repeated = await addConversationLocalTags({
      context: writerContext,
      mailboxId,
      input: { conversationIds: [secondConversation.id, conversationId], tagIds: [bulkTag.data.id] },
    });
    expect(repeated.ok && repeated.data.updatedConversationIds).toEqual([]);
    expect(repeated.ok && new Set(repeated.data.unchangedConversationIds)).toEqual(new Set([conversationId, secondConversation.id]));
  });

  test("matches every structured field class with parameterized SQL and keeps references safe before their table exists", async () => {
    const tags = await listLocalTags(writerContext, mailboxId);
    if (!tags.ok || !tags.data[0]) throw new Error("Local tag fixture is unavailable");
    const expressions: MailSearchExpression[] = [
      { type: "text", field: "recipients", query: "support@example.com", match: "exact" },
      { type: "text", field: "participants", query: "Customer", match: "contains" },
      { type: "text", field: "attachment_name", query: "invoice", match: "contains" },
      { type: "text", field: "comment", query: "internal context", match: "words" },
      { type: "text", field: "folder", query: "Priority Queue", match: "phrase" },
      { type: "text", field: "tag", query: tags.data[0].name, match: "exact" },
      { type: "local_tag_id", tagId: tags.data[0].id },
      { type: "text", field: "keyword", query: "RemoteImportant", match: "exact" },
      { type: "date", field: "internal_date", operator: "after", value: "2026-01-01T00:00:00.000Z" },
      { type: "size", field: "message", operator: "at_least", bytes: 4096 },
      { type: "size", field: "attachment", operator: "greater_than", bytes: 1024 },
      { type: "work_status", value: "waiting" },
      { type: "assignee", userId: writer.id },
      { type: "snoozed", value: true },
    ];
    for (const expression of expressions) {
      const fieldResult = await searchMessages({
        context: readerContext,
        mailboxId,
        request: { expression, sort: "newest", limit: 10 },
      });
      expect(fieldResult.ok && fieldResult.data.items.map((item) => item.id), JSON.stringify(expression)).toContain(messageId);
    }
    for (const query of ["support@example.com", "invoice", "internal context", "Priority Queue", tags.data[0].name, "RemoteImportant"]) {
      const quickResult = await searchMessages({
        context: readerContext,
        mailboxId,
        request: {
          expression: { type: "text", field: "any", query, match: "words" },
          sort: "relevance",
          limit: 10,
        },
      });
      expect(quickResult.ok && quickResult.data.items.map((item) => item.id), query).toContain(messageId);
    }
    const result = await searchMessages({
      context: readerContext,
      mailboxId,
      request: { expression: { type: "and", expressions }, sort: "newest", limit: 10 },
    });
    expect(result.ok && result.data.items.map((item) => item.id)).toContain(messageId);

    const reference = await searchMessages({
      context: readerContext,
      mailboxId,
      request: {
        expression: { type: "text", field: "reference", query: "SUP-42' OR true --", match: "exact" },
        sort: "newest",
        limit: 10,
      },
    });
    expect(reference.ok && reference.data.items).toEqual([]);
  });

  test("projects provider flags and an actionable source placement into conversation lists", async () => {
    await sql`
      UPDATE mail.message_placements
      SET flags = ARRAY['\\Flagged']::text[], updated_at = now()
      WHERE message_id = ${messageId}::uuid
    `;
    const conversations = await listConversations({ context: readerContext, mailboxId, limit: 20 });
    expect(conversations.ok).toBe(true);
    const conversation = conversations.ok ? conversations.data.items.find((item) => item.id === conversationId) : null;
    expect(conversation?.flagged).toBe(true);
    expect(conversation?.activeFolderIds).toContain(folderId);
    expect(conversation?.folderId).not.toBeNull();

    const searched = await searchMessages({
      context: readerContext,
      mailboxId,
      request: {
        expression: { type: "text", field: "subject", query: "Priority customer", match: "phrase" },
        sort: "newest",
        limit: 20,
      },
    });
    expect(searched.ok).toBe(true);
    const searchHit = searched.ok ? searched.data.items.find((item) => item.conversationId === conversationId) : null;
    expect(searchHit?.flagged).toBe(true);
    expect(searchHit?.activeFolderIds).toContain(folderId);
  });
});
