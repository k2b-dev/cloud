import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deleteWorkflowScope } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import {
  createAutomaticReplyConfiguration,
  createAutomaticReplySetup,
  listAutomaticReplyConfigurations,
  previewAutomaticReply,
  updateAutomaticReplyConfiguration,
  updateAutomaticReplySetup,
} from "./automatic-reply-configuration";
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
import { createWorkflowVersion, getWorkflow, listWorkflows } from "./workflow-definition-service";

const suite = process.env.MAIL_INTEGRATION_TESTS === "1" ? describe : describe.skip;

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
    await migrate();
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

  test("creates and updates managed automatic replies atomically", async () => {
    const [identity] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.sender_identities (short_id,
        mailbox_id, label, display_name, from_address, automation_policy, is_default, status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        'Automatic replies',
        'Automatic replies',
        ${`automatic-${suffix}@example.com`},
        'mailbox',
        true,
        'verified'
      )
      RETURNING id, short_id
    `;
    if (!identity) throw new Error("Failed to create automatic reply sender fixture");
    const preview = await previewAutomaticReply({
      context: ownerContext,
      mailboxId,
      input: {
        senderIdentityId: identity.id,
        subject: "Re: {{ inputs.message.subject }}",
        body: "Reference: **{{ reference.value }}**",
        format: "markdown",
        ensureReference: true,
        referencePattern: "PREVIEW-{{ year }}-{{ sequence | pad_start: 6 }}",
      },
    });
    expect(preview).toMatchObject({
      ok: true,
      data: {
        subject: "Re: Example customer request",
        text: `Reference: PREVIEW-${new Date().getUTCFullYear()}-000042`,
      },
    });
    const invalidPreview = await previewAutomaticReply({
      context: ownerContext,
      mailboxId,
      input: {
        senderIdentityId: identity.id,
        subject: "{{ missing.value }}",
        body: "Body",
        format: "plain",
        ensureReference: false,
        referencePattern: null,
      },
    });
    expect(invalidPreview.ok).toBe(false);
    const input = {
      name: `Out of office ${suffix}`,
      enabled: true,
      senderIdentityId: identity.id,
      subject: "Re: {{ inputs.message.subject }}",
      body: "I am currently away.",
      format: "markdown" as const,
      ensureReference: false,
      minimumIntervalHours: 168,
      inactiveBehavior: "skip" as const,
      schedule: {
        mode: "windows" as const,
        timeZone: "Europe/Berlin",
        activeRanges: [{ from: "2026-07-20", to: "2026-08-03" }],
        weeklyWindows: [
          { weekday: 1 as const, start: "00:00", end: "24:00" },
          { weekday: 2 as const, start: "00:00", end: "24:00" },
          { weekday: 3 as const, start: "00:00", end: "24:00" },
          { weekday: 4 as const, start: "00:00", end: "24:00" },
          { weekday: 5 as const, start: "00:00", end: "24:00" },
          { weekday: 6 as const, start: "00:00", end: "24:00" },
          { weekday: 7 as const, start: "00:00", end: "24:00" },
        ],
        exceptions: [],
      },
    };
    const writerList = await listAutomaticReplyConfigurations(writerContext, mailboxId);
    expect(writerList.ok).toBe(true);
    expect((await createAutomaticReplyConfiguration({ context: writerContext, mailboxId, input })).ok).toBe(false);
    await sql`
      UPDATE mail.mailboxes
      SET automatic_reply_management_permission = 'write'
      WHERE id = ${mailboxId}::uuid
    `;
    const created = await createAutomaticReplyConfiguration({ context: writerContext, mailboxId, input });
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
    expect(created.data).toMatchObject({
      name: input.name,
      enabled: true,
      senderIdentityId: identity.id,
      inactiveBehavior: "skip",
      revision: 1,
    });
    const loadedReferenceConfiguration = await getConversationReferenceConfiguration(ownerContext, mailboxId);
    if (!loadedReferenceConfiguration.ok) throw new Error(loadedReferenceConfiguration.error.message);
    let referenceBeforeAtomicConflict = loadedReferenceConfiguration.data;
    if (!referenceBeforeAtomicConflict) {
      const createdReferenceConfiguration = await putConversationReferenceConfiguration({
        context: ownerContext,
        mailboxId,
        input: {
          expectedRevision: null,
          pattern: "SUP-{{ year }}-{{ sequence | pad_start: 6 }}",
          enabled: true,
          includeInReplySubjects: true,
        },
      });
      if (!createdReferenceConfiguration.ok) throw new Error(createdReferenceConfiguration.error.message);
      referenceBeforeAtomicConflict = createdReferenceConfiguration.data;
    }
    const atomicConflict = await createAutomaticReplySetup({
      context: ownerContext,
      mailboxId,
      input: {
        automaticReply: {
          ...input,
          name: `Atomic rollback ${suffix}`,
          ensureReference: true,
          body: "Your reference is {{ reference.value }}.",
        },
        referenceConfiguration: {
          expectedRevision: referenceBeforeAtomicConflict.revision,
          pattern: `ROLLBACK-{{ year }}-{{ sequence | pad_start: 6 }}`,
          enabled: true,
          includeInReplySubjects: referenceBeforeAtomicConflict.includeInReplySubjects,
        },
      },
    });
    expect(atomicConflict.ok).toBe(false);
    if (!atomicConflict.ok) expect(atomicConflict.error.code).toBe("CONFLICT");
    expect(await getReferenceConfiguration()).toEqual(referenceBeforeAtomicConflict);
    const atomicSetup = await createAutomaticReplySetup({
      context: ownerContext,
      mailboxId,
      input: {
        automaticReply: {
          ...input,
          name: `Reference acknowledgement ${suffix}`,
          enabled: false,
          ensureReference: true,
          body: "Your reference is {{ reference.value }}.",
          schedule: { mode: "always" },
        },
        referenceConfiguration: {
          expectedRevision: referenceBeforeAtomicConflict.revision,
          pattern: `CASE-{{ year }}-{{ sequence | pad_start: 6 }}`,
          enabled: true,
          includeInReplySubjects: true,
        },
      },
    });
    if (!atomicSetup.ok) throw new Error(`${atomicSetup.error.code}: ${atomicSetup.error.message}`);
    expect(atomicSetup.data).toMatchObject({
      automaticReply: {
        name: `Reference acknowledgement ${suffix}`,
        enabled: false,
        ensureReference: true,
        schedule: { mode: "always" },
      },
      referenceConfiguration: {
        pattern: `CASE-{{ year }}-{{ sequence | pad_start: 6 }}`,
        enabled: true,
        revision: referenceBeforeAtomicConflict.revision + 1,
      },
    });
    const atomicReply = atomicSetup.data.automaticReply;
    const atomicReplyUpdate = {
      expectedRevision: atomicReply.revision,
      name: atomicReply.name,
      enabled: atomicReply.enabled,
      senderIdentityId: atomicReply.senderIdentityId,
      subject: atomicReply.subject,
      body: "Updated atomic reply.",
      format: atomicReply.format,
      ensureReference: atomicReply.ensureReference,
      minimumIntervalHours: atomicReply.minimumIntervalHours,
      inactiveBehavior: atomicReply.inactiveBehavior,
      schedule: atomicReply.schedule,
    };
    const updatedAtomicReply = await updateAutomaticReplyConfiguration({
      context: ownerContext,
      mailboxId,
      configurationId: atomicReply.id,
      input: atomicReplyUpdate,
    });
    if (!updatedAtomicReply.ok) throw new Error(`${updatedAtomicReply.error.code}: ${updatedAtomicReply.error.message}`);
    const referenceBeforeStaleAutomaticReply = await getReferenceConfiguration();
    const staleAutomaticReply = await updateAutomaticReplySetup({
      context: ownerContext,
      mailboxId,
      configurationId: atomicReply.id,
      input: {
        automaticReply: {
          ...atomicReplyUpdate,
          expectedRevision: atomicReply.revision,
          body: "This stale automatic reply must not be saved.",
        },
        referenceConfiguration: {
          expectedRevision: referenceBeforeStaleAutomaticReply.revision,
          pattern: `STALE-AUTO-{{ year }}-{{ sequence | pad_start: 6 }}`,
          enabled: true,
          includeInReplySubjects: true,
        },
      },
    });
    expect(staleAutomaticReply.ok).toBe(false);
    if (!staleAutomaticReply.ok) expect(staleAutomaticReply.error.code).toBe("CONFLICT");
    expect(await getReferenceConfiguration()).toEqual(referenceBeforeStaleAutomaticReply);
    const staleReferenceConfiguration = await updateAutomaticReplySetup({
      context: ownerContext,
      mailboxId,
      configurationId: atomicReply.id,
      input: {
        automaticReply: {
          ...atomicReplyUpdate,
          expectedRevision: updatedAtomicReply.data.revision,
          name: "This automatic reply change must roll back",
        },
        referenceConfiguration: {
          expectedRevision: referenceBeforeStaleAutomaticReply.revision - 1,
          pattern: `STALE-REFERENCE-{{ year }}-{{ sequence | pad_start: 6 }}`,
          enabled: true,
          includeInReplySubjects: true,
        },
      },
    });
    expect(staleReferenceConfiguration.ok).toBe(false);
    if (!staleReferenceConfiguration.ok) expect(staleReferenceConfiguration.error.code).toBe("CONFLICT");
    const automaticRepliesAfterStaleReference = await listAutomaticReplyConfigurations(ownerContext, mailboxId);
    if (!automaticRepliesAfterStaleReference.ok) throw new Error(automaticRepliesAfterStaleReference.error.message);
    expect(automaticRepliesAfterStaleReference.data.find((configuration) => configuration.id === atomicReply.id)).toMatchObject({
      name: atomicReply.name,
      body: "Updated atomic reply.",
      revision: updatedAtomicReply.data.revision,
    });
    const [stored] = await sql<
      {
        current_version_id: string;
        active_version_id: string | null;
        activation_count: number;
        schedule_definition: unknown;
      }[]
    >`
      SELECT
        latest.id AS current_version_id,
        workflow.active_version_id,
        (SELECT COUNT(*)::int FROM workflows.activation activation
         WHERE activation.workflow_id = workflow.id AND activation.enabled) AS activation_count,
        configuration.schedule_definition
      FROM mail.automatic_reply_configurations configuration
      JOIN workflows.workflow workflow ON workflow.id = configuration.workflow_id
      JOIN LATERAL (
        SELECT id FROM workflows.version
        WHERE workflow_id = workflow.id
        ORDER BY revision DESC
        LIMIT 1
      ) latest ON true
      WHERE configuration.id = ${created.data.id}::uuid
    `;
    expect(stored).toMatchObject({
      current_version_id: expect.any(String),
      active_version_id: expect.any(String),
      activation_count: 1,
      schedule_definition: input.schedule,
    });
    const visibleWorkflows = await listWorkflows(readerContext, mailboxId);
    expect(visibleWorkflows.ok && visibleWorkflows.data.some((workflow) => workflow.id === created.data.workflowId)).toBe(false);
    const managedWorkflowRead = await getWorkflow(readerContext, mailboxId, created.data.workflowId);
    expect(managedWorkflowRead.ok).toBe(false);
    if (!managedWorkflowRead.ok) expect(managedWorkflowRead.error.code).toBe("NOT_FOUND");
    const [beforeConflict] = await sql<{ configurations: number; workflows: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.automatic_reply_configurations WHERE mailbox_id = ${mailboxId}::uuid) AS configurations,
        (SELECT COUNT(*)::int FROM mail.workflow_profile WHERE mailbox_id = ${mailboxId}::uuid) AS workflows
    `;
    const duplicate = await createAutomaticReplyConfiguration({
      context: ownerContext,
      mailboxId,
      input: { ...input, body: "This insert must roll back." },
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("CONFLICT");
    const [afterConflict] = await sql<{ configurations: number; workflows: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.automatic_reply_configurations WHERE mailbox_id = ${mailboxId}::uuid) AS configurations,
        (SELECT COUNT(*)::int FROM mail.workflow_profile WHERE mailbox_id = ${mailboxId}::uuid) AS workflows
    `;
    expect(afterConflict).toEqual(beforeConflict);
    const secondActive = await createAutomaticReplyConfiguration({
      context: ownerContext,
      mailboxId,
      input: { ...input, name: `Second active ${suffix}` },
    });
    expect(secondActive.ok).toBe(false);
    if (!secondActive.ok) expect(secondActive.error).toMatchObject({ code: "CONFLICT" });
    const managedEdit = await createWorkflowVersion({
      context: ownerContext,
      mailboxId,
      workflowId: created.data.workflowId,
      input: {
        source: "steps:\n  - succeed:\n      message: bypass\n",
        effectBudget: {
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
        },
      },
    });
    expect(managedEdit.ok).toBe(false);
    if (!managedEdit.ok) expect(managedEdit.error.code).toBe("CONFLICT");

    const updates = await Promise.all([
      updateAutomaticReplyConfiguration({
        context: ownerContext,
        mailboxId,
        configurationId: created.data.id,
        input: { expectedRevision: 1, ...input, body: "Updated response.", enabled: false },
      }),
      updateAutomaticReplyConfiguration({
        context: ownerContext,
        mailboxId,
        configurationId: created.data.id,
        input: { expectedRevision: 1, ...input, body: "Conflicting response." },
      }),
    ]);
    expect(updates.filter((result) => result.ok)).toHaveLength(1);
    expect(updates.filter((result) => !result.ok)).toHaveLength(1);
    const listed = await listAutomaticReplyConfigurations(ownerContext, mailboxId);
    if (!listed.ok) throw new Error(listed.error.message);
    let current = listed.data.find((configuration) => configuration.id === created.data.id);
    if (!current) throw new Error("Updated automatic reply could not be reloaded");
    expect(current.revision).toBe(2);
    if (current.enabled) {
      const disabledResult = await updateAutomaticReplyConfiguration({
        context: ownerContext,
        mailboxId,
        configurationId: current.id,
        input: {
          expectedRevision: current.revision,
          name: current.name,
          enabled: false,
          senderIdentityId: current.senderIdentityId,
          subject: current.subject,
          body: current.body,
          format: current.format,
          ensureReference: current.ensureReference,
          minimumIntervalHours: current.minimumIntervalHours,
          inactiveBehavior: current.inactiveBehavior,
          schedule: current.schedule,
        },
      });
      if (!disabledResult.ok) throw new Error(`${disabledResult.error.code}: ${disabledResult.error.message}`);
      current = disabledResult.data;
    }
    const referenceUpdate = await updateAutomaticReplyConfiguration({
      context: ownerContext,
      mailboxId,
      configurationId: current.id,
      input: {
        expectedRevision: current.revision,
        name: current.name,
        enabled: false,
        senderIdentityId: current.senderIdentityId,
        subject: current.subject,
        body: "Your reference is {{ reference.value }}.",
        format: current.format,
        ensureReference: true,
        minimumIntervalHours: current.minimumIntervalHours,
        inactiveBehavior: current.inactiveBehavior,
        schedule: current.schedule,
      },
    });
    if (!referenceUpdate.ok) throw new Error(`${referenceUpdate.error.code}: ${referenceUpdate.error.message}`);
    current = referenceUpdate.data;
    const [referenceWorkflow] = await sql<{ source: string }[]>`
      SELECT version.source
      FROM mail.automatic_reply_configurations configuration
      JOIN workflows.workflow workflow ON workflow.id = configuration.workflow_id
      JOIN LATERAL (
        SELECT source FROM workflows.version
        WHERE workflow_id = workflow.id
        ORDER BY revision DESC
        LIMIT 1
      ) version ON true
      WHERE configuration.id = ${created.data.id}::uuid
    `;
    expect(referenceWorkflow?.source).toContain("ensureConversationReference:");
    expect(referenceWorkflow?.source).toContain("saveAs: reference");
    expect(referenceWorkflow?.source).toContain("{{ reference.value }}");
    const [disabled] = await sql<{ active_version_id: string | null; activation_count: number }[]>`
      SELECT
        workflow.active_version_id,
        (SELECT COUNT(*)::int FROM workflows.activation activation
         WHERE activation.workflow_id = workflow.id AND activation.enabled) AS activation_count
      FROM mail.automatic_reply_configurations configuration
      JOIN workflows.workflow workflow ON workflow.id = configuration.workflow_id
      WHERE configuration.id = ${created.data.id}::uuid
    `;
    expect(disabled).toEqual({ active_version_id: expect.any(String), activation_count: 0 });
    const beforeMetadataUpdate = await sql<{ current_version_id: string }[]>`
      SELECT latest.id AS current_version_id
      FROM mail.automatic_reply_configurations configuration
      JOIN workflows.workflow workflow ON workflow.id = configuration.workflow_id
      JOIN LATERAL (
        SELECT id FROM workflows.version
        WHERE workflow_id = workflow.id
        ORDER BY revision DESC
        LIMIT 1
      ) latest ON true
      WHERE configuration.id = ${created.data.id}::uuid
    `;
    const referenceConfiguration = await getReferenceConfiguration();
    const stoppedReferenceAllocation = await putConversationReferenceConfiguration({
      context: ownerContext,
      mailboxId,
      input: {
        expectedRevision: referenceConfiguration.revision,
        pattern: referenceConfiguration.pattern,
        enabled: false,
        includeInReplySubjects: referenceConfiguration.includeInReplySubjects,
      },
    });
    if (!stoppedReferenceAllocation.ok) throw new Error(stoppedReferenceAllocation.error.message);
    await sql`UPDATE mail.sender_identities SET status = 'disabled' WHERE id = ${identity.id}::uuid`;
    const disabledUpdate = await updateAutomaticReplyConfiguration({
      context: ownerContext,
      mailboxId,
      configurationId: created.data.id,
      input: {
        expectedRevision: current.revision,
        senderIdentityId: current.senderIdentityId,
        subject: current.subject,
        body: current.body,
        format: current.format,
        ensureReference: current.ensureReference,
        minimumIntervalHours: current.minimumIntervalHours,
        inactiveBehavior: current.inactiveBehavior,
        schedule: current.schedule,
        name: `${input.name} renamed`,
        enabled: false,
      },
    });
    if (!disabledUpdate.ok) throw new Error(`${disabledUpdate.error.code}: ${disabledUpdate.error.message}`);
    expect(disabledUpdate.data).toMatchObject({
      enabled: false,
      revision: current.revision + 1,
      name: `${input.name} renamed`,
    });
    const afterMetadataUpdate = await sql<{ current_version_id: string }[]>`
      SELECT latest.id AS current_version_id
      FROM mail.automatic_reply_configurations configuration
      JOIN workflows.workflow workflow ON workflow.id = configuration.workflow_id
      JOIN LATERAL (
        SELECT id FROM workflows.version
        WHERE workflow_id = workflow.id
        ORDER BY revision DESC
        LIMIT 1
      ) latest ON true
      WHERE configuration.id = ${created.data.id}::uuid
    `;
    expect(afterMetadataUpdate[0]?.current_version_id).toBe(beforeMetadataUpdate[0]?.current_version_id);
  });
});
