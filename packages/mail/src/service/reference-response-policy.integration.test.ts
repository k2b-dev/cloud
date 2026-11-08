import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { deleteWorkflowScope } from "@k2b/cloud/workflows/store";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { listActivity } from "./collaboration";
import {
  ensureConversationReference,
  findConversationByReference,
  getConversationReferenceConfiguration,
  listConversationReferences,
  previewConversationReference,
  putConversationReferenceConfiguration,
} from "./conversation-reference";
import { mergeConversations, splitConversation } from "./conversations";
import { createDraft } from "./drafts";
import { createMailbox } from "./mailboxes";
import { searchMessages } from "./search";

const suite = suiteFor("database", "nats");

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
  requestId: `mail-reference-policy-${user.uid}`,
});

suite("conversation references and automatic reply policies", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const accessIds: string[] = [];
  let mailboxId = "";
  let folderId = "";
  let ownerContext: MailRequestContext;
  let writerContext: MailRequestContext;
  let readerContext: MailRequestContext;
  let nextUid = 1;
  const getReferenceConfiguration = async () => {
    const result = await getConversationReferenceConfiguration(ownerContext, mailboxId);
    if (!result.ok || !result.data) throw new Error(result.ok ? "Reference configuration is missing" : result.error.message);
    return result.data;
  };

  const createConversation = async (messageCount = 1) => {
    const [conversation] = await sql<{ id: string; short_id: string; revision: string | number }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`Reference ${nextUid}`}, 'Customer', now())
      RETURNING id, short_id, revision
    `;
    if (!conversation) throw new Error("Failed to create reference conversation");
    const messageIds: string[] = [];
    const messageShortIds: string[] = [];
    for (let index = 0; index < messageCount; index += 1) {
      const uid = nextUid++;
      const [message] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, normalized_subject, internal_date,
          size_bytes, content_hash, hydration_status, plain_text
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${`<reference-${suffix}-${uid}@example.com>`},
          ${`Reference ${uid}`},
          ${`reference ${uid}`},
          now(),
          128,
          ${uid.toString(16).padStart(64, "0")},
          'complete',
          'Reference search body'
        )
        RETURNING id, short_id
      `;
      const [remoteRef] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${folderId}::uuid, ${message!.id}::uuid, 1, ${uid})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${remoteRef!.id}::uuid, ${folderId}::uuid, ${message!.id}::uuid)
      `;
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation.id}::uuid, ${message!.id}::uuid, ${index + 1}, 'headers')
      `;
      await sql`
        INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
        VALUES (${message!.id}::uuid, 'from', 0, 'Customer', 'customer@example.com', 'customer@example.com')
      `;
      messageIds.push(message!.id);
      messageShortIds.push(message!.short_id);
    }
    return { id: conversation.id, shortId: conversation.short_id, revision: Number(conversation.revision), messageIds, messageShortIds };
  };

  beforeAll(async () => {
    const users = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES
        (${`mail-reference-owner-${suffix}`}, 'local', 'user', 'Reference owner', false),
        (${`mail-reference-writer-${suffix}`}, 'local', 'user', 'Reference writer', false),
        (${`mail-reference-reader-${suffix}`}, 'local', 'user', 'Reference reader', false)
      RETURNING id, uid
    `;
    const [owner, writer, reader] = users;
    if (!owner || !writer || !reader) throw new Error("Failed to create reference users");
    userIds.push(...users.map((user) => user.id));
    ownerContext = contextFor(owner);
    writerContext = contextFor(writer);
    readerContext = contextFor(reader);
    const mailbox = await createMailbox(ownerContext, { name: `References ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    for (const [userId, permission] of [
      [writer.id, "write"],
      [reader.id, "read"],
    ] as const) {
      const granted = await grantMailboxAccess({ context: ownerContext, mailboxId, principal: { type: "user", userId }, permission });
      if (!granted.ok) throw new Error(granted.error.message);
      accessIds.push(granted.data.id);
    }
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}, 'active')
      RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`references-${suffix}`}, 'Inbox', 'inbox', 'current')
      RETURNING id
    `;
    folderId = folder!.id;
  });

  afterAll(async () => {
    if (mailboxId) {
      const mailboxAccess = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      accessIds.push(...mailboxAccess.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
    }
    if (accessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...new Set(accessIds)]}::jsonb))`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("allocates immutable references idempotently and searches exact aliases", async () => {
    expect(
      (
        await putConversationReferenceConfiguration({
          context: writerContext,
          mailboxId,
          input: { expectedRevision: null, pattern: "NO-{{ sequence }}", enabled: true, includeInReplySubjects: true },
        })
      ).ok,
    ).toBe(false);
    const configuration = await putConversationReferenceConfiguration({
      context: ownerContext,
      mailboxId,
      input: {
        expectedRevision: null,
        pattern: "SUP-{{ short_id }}",
        enabled: true,
        includeInReplySubjects: true,
      },
    });
    expect(configuration.ok).toBe(true);
    if (!configuration.ok) return;
    const firstConversation = await createConversation();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        ensureConversationReference({
          context: writerContext,
          mailboxId,
          conversationId: firstConversation.id,
          input: { idempotencyKey: `parallel-${suffix}-${index}` },
        }),
      ),
    );
    expect(attempts.every((result) => result.ok)).toBe(true);
    const values = new Set(attempts.flatMap((result) => (result.ok ? [result.data.reference.value] : [])));
    expect(values.size).toBe(1);
    expect(attempts.filter((result) => result.ok && result.data.created)).toHaveLength(1);
    const first = attempts.find((result) => result.ok)?.data.reference;
    if (!first) throw new Error("Reference allocation did not return a value");
    expect(first.value).toMatch(/^SUP-[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){2}$/);

    const [storedReplay] = await sql<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM mail.conversation_references WHERE id = ${first.id}::uuid
    `;
    if (!storedReplay) throw new Error("Stored reference idempotency key is unavailable");
    const replayKey = `parallel-${suffix}-5`;
    const [requestLedger] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.conversation_reference_requests
      WHERE mailbox_id = ${mailboxId}::uuid AND reference_id = ${first.id}::uuid
    `;
    expect(requestLedger?.count).toBe(6);
    const replay = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: firstConversation.id,
      input: { idempotencyKey: replayKey },
    });
    expect(replay.ok && replay.data.created).toBe(false);
    const conflictingConversation = await createConversation();
    const conflictingReplay = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: conflictingConversation.id,
      input: { idempotencyKey: replayKey },
    });
    expect(conflictingReplay.ok).toBe(false);
    if (!conflictingReplay.ok) expect(conflictingReplay.error.code).toBe("CONFLICT");
    expect(
      (
        await ensureConversationReference({
          context: readerContext,
          mailboxId,
          conversationId: firstConversation.id,
          input: { idempotencyKey: `reader-${suffix}` },
        })
      ).ok,
    ).toBe(false);
    const found = await findConversationByReference({ context: readerContext, mailboxId, value: first.value.toLowerCase() });
    expect(found.ok && found.data.conversationId).toBe(firstConversation.id);
    const searched = await searchMessages({
      context: readerContext,
      mailboxId,
      request: { expression: { type: "text", field: "reference", query: first.value, match: "exact" }, sort: "newest", limit: 10 },
    });
    expect(searched.ok && searched.data.items.map((item) => item.id)).toEqual(firstConversation.messageIds);
    const quickSearched = await searchMessages({
      context: readerContext,
      mailboxId,
      request: { expression: { type: "text", field: "any", query: first.value, match: "words" }, sort: "relevance", limit: 10 },
    });
    expect(quickSearched.ok && quickSearched.data.items.map((item) => item.id)).toEqual(firstConversation.messageIds);

    const [evidence] = await sql<{ references: number; activities: number; next_sequence: string }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.conversation_references WHERE conversation_id = ${firstConversation.id}::uuid) AS references,
        (SELECT COUNT(*)::int FROM mail.activity_events WHERE conversation_id = ${firstConversation.id}::uuid AND action = 'conversation.reference_allocated') AS activities,
        (SELECT next_sequence::text FROM mail.reference_number_configurations WHERE mailbox_id = ${mailboxId}::uuid) AS next_sequence
    `;
    expect(evidence).toEqual({ references: 1, activities: 1, next_sequence: "2" });
    const [mailboxIdentity] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid
    `;
    const publicActivity = await listActivity({ context: readerContext, mailboxId, limit: 100 });
    if (!publicActivity.ok) throw new Error(publicActivity.error.message);
    expect(publicActivity.data.items.find((item) => item.action === "conversation.reference_allocated")?.targetId).toBe(first.value);
    expect(publicActivity.data.items.find((item) => item.targetType === "reference_configuration")?.targetId).toBe(
      mailboxIdentity?.short_id,
    );

    const missingReferenceId = crypto.randomUUID();
    await sql`
      INSERT INTO mail.activity_events (
        mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
      ) VALUES (
        ${mailboxId}::uuid,
        ${firstConversation.id}::uuid,
        'system',
        NULL,
        'conversation.reference_missing_fixture',
        'confirmed',
        'conversation_reference',
        ${missingReferenceId}::uuid,
        '{}'::jsonb
      )
    `;
    const activityWithMissingReference = await listActivity({ context: readerContext, mailboxId, limit: 100 });
    if (!activityWithMissingReference.ok) throw new Error(activityWithMissingReference.error.message);
    expect(
      activityWithMissingReference.data.items.find((item) => item.action === "conversation.reference_missing_fixture")?.targetId,
    ).toBeNull();
    let immutableError: unknown;
    try {
      await sql`UPDATE mail.conversation_references SET value = 'mutated' WHERE id = ${first.id}::uuid`;
    } catch (error) {
      immutableError = error;
    }
    expect(String(immutableError)).toContain("Conversation reference allocation fields are immutable");

    const unicodeConfiguration = await putConversationReferenceConfiguration({
      context: ownerContext,
      mailboxId,
      input: {
        expectedRevision: configuration.data.revision,
        pattern: `İ-${suffix}-{{ sequence }}`,
        enabled: true,
        includeInReplySubjects: true,
      },
    });
    if (!unicodeConfiguration.ok) throw new Error(unicodeConfiguration.error.message);
    const unicodeConversation = await createConversation();
    const unicodeReference = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: unicodeConversation.id,
      input: { idempotencyKey: `unicode-${suffix}` },
    });
    if (!unicodeReference.ok) throw new Error(unicodeReference.error.message);
    const unicodeSearch = await searchMessages({
      context: readerContext,
      mailboxId,
      request: {
        expression: { type: "text", field: "reference", query: unicodeReference.data.reference.value, match: "exact" },
        sort: "newest",
        limit: 10,
      },
    });
    expect(unicodeSearch.ok && unicodeSearch.data.items.map((item) => item.id)).toEqual(unicodeConversation.messageIds);
  }, 15_000);

  test("updates one mailbox configuration with optimistic concurrency", async () => {
    const before = await getReferenceConfiguration();
    const preview = await previewConversationReference({
      context: ownerContext,
      mailboxId,
      pattern: `PREVIEW-${suffix}-{{ sequence | pad_start: 4 }}`,
    });
    expect(preview).toMatchObject({ ok: true, data: { value: `PREVIEW-${suffix}-0042`, sequence: "42" } });
    expect(
      (
        await previewConversationReference({
          context: writerContext,
          mailboxId,
          pattern: "{{ sequence }}",
        })
      ).ok,
    ).toBe(false);
    const current = await putConversationReferenceConfiguration({
      context: ownerContext,
      mailboxId,
      input: {
        expectedRevision: before.revision,
        pattern: `A-${suffix}-{{ sequence }}`,
        enabled: true,
        includeInReplySubjects: true,
      },
    });
    if (!current.ok) throw new Error(current.error.message);
    const updated = await putConversationReferenceConfiguration({
      context: ownerContext,
      mailboxId,
      input: {
        expectedRevision: current.data.revision,
        pattern: `B-${suffix}-{{ sequence }}`,
        enabled: true,
        includeInReplySubjects: false,
      },
    });
    if (!updated.ok) throw new Error(updated.error.message);
    const [stored] = await sql<{ pattern: string; revision: string | number; include_in_reply_subjects: boolean }[]>`
      SELECT
        pattern, revision, include_in_reply_subjects
      FROM mail.reference_number_configurations
      WHERE mailbox_id = ${mailboxId}::uuid
    `;
    expect(stored).toEqual({
      pattern: `B-${suffix}-{{ sequence }}`,
      revision: String(updated.data.revision),
      include_in_reply_subjects: false,
    });
  });

  test("adds an existing reference to new reply drafts when configured", async () => {
    const before = await getReferenceConfiguration();
    const enabled = await putConversationReferenceConfiguration({
      context: ownerContext,
      mailboxId,
      input: {
        expectedRevision: before.revision,
        pattern: `DRAFT-${suffix}-{{ sequence }}`,
        enabled: true,
        includeInReplySubjects: true,
      },
    });
    if (!enabled.ok) throw new Error(enabled.error.message);
    const [identity] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.sender_identities (short_id,
        mailbox_id, label, display_name, from_address, automation_policy, is_default, status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        'Reply drafts',
        'Reply drafts',
        ${`drafts-${suffix}@example.com`},
        'disabled',
        false,
        'verified'
      )
      RETURNING id, short_id
    `;
    if (!identity) throw new Error("Failed to create reply draft sender fixture");
    const conversation = await createConversation();
    const allocated = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: conversation.id,
      input: { idempotencyKey: `reply-draft-${suffix}` },
    });
    if (!allocated.ok) throw new Error(allocated.error.message);
    const draft = await createDraft({
      context: writerContext,
      mailboxId,
      input: {
        conversationId: conversation.id,
        intent: "reply",
        sourceMessageId: conversation.messageIds[0]!,
        senderIdentityId: identity.id,
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Original request",
        body: "Reply",
        format: "plain",
      },
    });
    if (!draft.ok) throw new Error(draft.error.message);
    expect(draft.data.subject).toBe(`Re: [${allocated.data.reference.value}] Original request`);

    const disabled = await putConversationReferenceConfiguration({
      context: ownerContext,
      mailboxId,
      input: {
        expectedRevision: enabled.data.revision,
        pattern: enabled.data.pattern,
        enabled: true,
        includeInReplySubjects: false,
      },
    });
    if (!disabled.ok) throw new Error(disabled.error.message);
    const secondConversation = await createConversation();
    const secondReference = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: secondConversation.id,
      input: { idempotencyKey: `reply-draft-disabled-${suffix}` },
    });
    if (!secondReference.ok) throw new Error(secondReference.error.message);
    const unchangedDraft = await createDraft({
      context: writerContext,
      mailboxId,
      input: {
        conversationId: secondConversation.id,
        intent: "reply_all",
        sourceMessageId: secondConversation.messageIds[0]!,
        senderIdentityId: identity.id,
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Another request",
        body: "Reply all",
        format: "plain",
      },
    });
    if (!unchangedDraft.ok) throw new Error(unchangedDraft.error.message);
    expect(unchangedDraft.data.subject).toBe("Re: Another request");
  });

  test("merge preserves references as primary and aliases while split copies none", async () => {
    const before = await getReferenceConfiguration();
    const configuration = await putConversationReferenceConfiguration({
      context: ownerContext,
      mailboxId,
      input: {
        expectedRevision: before.revision,
        pattern: "ESC-{{ year }}-{{ sequence | pad_start: 6 }}",
        enabled: true,
        includeInReplySubjects: true,
      },
    });
    if (!configuration.ok) throw new Error(configuration.error.message);
    const target = await createConversation();
    const source = await createConversation();
    const targetReference = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: target.id,
      input: { idempotencyKey: `merge-target-${suffix}` },
    });
    const sourceReference = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: source.id,
      input: { idempotencyKey: `merge-source-${suffix}` },
    });
    if (!targetReference.ok || !sourceReference.ok) throw new Error("Failed to allocate merge references");
    const merged = await mergeConversations({
      context: writerContext,
      mailboxId,
      targetConversationId: target.id,
      input: {
        sourceConversationId: source.id,
        expectedTargetRevision: targetReference.data.conversationRevision,
        expectedSourceRevision: sourceReference.data.conversationRevision,
        confirm: true,
      },
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(merged.ok).toBe(true);
    const mergedReferences = await listConversationReferences({ context: readerContext, mailboxId, conversationId: target.id });
    expect(mergedReferences.ok && mergedReferences.data.map((reference) => reference.value).sort()).toEqual(
      [targetReference.data.reference.value, sourceReference.data.reference.value].sort(),
    );
    expect(mergedReferences.ok && mergedReferences.data.filter((reference) => reference.role === "primary")).toHaveLength(1);
    const replayedAfterMerge = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: source.id,
      input: { idempotencyKey: `merge-source-${suffix}` },
    });
    expect(replayedAfterMerge.ok && replayedAfterMerge.data.created).toBe(false);
    expect(replayedAfterMerge.ok && replayedAfterMerge.data.reference.conversationId).toBe(target.id);
    const aliasSearch = await searchMessages({
      context: readerContext,
      mailboxId,
      request: {
        expression: { type: "text", field: "reference", query: sourceReference.data.reference.value, match: "exact" },
        sort: "newest",
        limit: 10,
      },
    });
    expect(aliasSearch.ok && aliasSearch.data.items.map((item) => item.id)).toEqual(expect.arrayContaining(source.messageIds));

    const splitSource = await createConversation(2);
    const splitReference = await ensureConversationReference({
      context: writerContext,
      mailboxId,
      conversationId: splitSource.id,
      input: { idempotencyKey: `split-${suffix}` },
    });
    if (!splitReference.ok) throw new Error(splitReference.error.message);
    const split = await splitConversation({
      context: writerContext,
      mailboxId,
      conversationId: splitSource.id,
      input: { messageIds: [splitSource.messageIds[1]!], expectedRevision: splitReference.data.conversationRevision, confirm: true },
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const sourceReferences = await listConversationReferences({ context: readerContext, mailboxId, conversationId: splitSource.id });
    const createdReferences = await listConversationReferences({
      context: readerContext,
      mailboxId,
      conversationId: split.data.created.id,
    });
    expect(sourceReferences.ok && sourceReferences.data).toHaveLength(1);
    expect(createdReferences.ok && createdReferences.data).toEqual([]);
  });
});
