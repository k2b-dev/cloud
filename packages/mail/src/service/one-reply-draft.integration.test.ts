import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { accounts, oauthTokens } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import api from "../api";
import { mailCapabilities } from "../capabilities";
import { DraftCreateInputSchema, DraftSwitchIntentInputSchema } from "../capability-contracts";
import { type DraftContentInput, draftSchema, type MailDraft } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { prepareAutomaticReplyInTransaction } from "./automatic-reply";
import { readDraftDocument } from "./draft-documents";
import { acquireDraftLease, heartbeatDraftLease } from "./draft-leases";
import { finishReplyDraftRetirements } from "./draft-retirement";
import { uploadDraftAttachmentStream } from "./draft-uploads";
import * as drafts from "./drafts";
import { createMailbox } from "./mailboxes";
import { EMPTY_MESSAGE_PROTOCOL_FACTS } from "./message-protocol";

const suite = suiteFor("database", "nats", "valkey");
const at = "2026-11-01T12:00:00.000Z";

suite("one reply draft per conversation", () => {
  let owner: MailRequestContext;
  let gustav: MailRequestContext;
  let mailboxId: string;
  let mailboxShortId: string;
  let identityId: string;
  let identityShortId: string;
  let accountId: string;
  let userId: string;
  const grantIds: string[] = [];

  const cap = (context = owner): CapabilityExecutionContext => ({
    ...context,
    user: context.actor.kind === "user" ? context.actor.user : null,
    requestId: "one-reply-test",
    origin: "assistant",
    locale: "en",
    signal: new AbortController().signal,
    idempotencyKey: crypto.randomUUID(),
  });
  let messageSequence = 0;
  const thread = async () => {
    const [conversation] = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO mail.conversations (short_id, mailbox_id, subject, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Question', ${at}) RETURNING id, short_id`;
    const [message] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, internal_date, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.test>`}, 'Re: Question', ${at},
        ${(++messageSequence).toString(16).padStart(64, "0")}, 'complete', 'Source') RETURNING id, short_id`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 0, 'headers')`;
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
      VALUES (${message!.id}::uuid, 'from', 0, 'customer@example.test', 'customer@example.test'),
      (${message!.id}::uuid, 'to', 0, 'team@example.test', 'team@example.test'),
      (${message!.id}::uuid, 'to', 1, 'other@example.test', 'other@example.test'),
      (${message!.id}::uuid, 'cc', 0, 'copy@example.test', 'copy@example.test')`;
    return {
      conversationId: conversation!.id,
      conversationShortId: conversation!.short_id,
      sourceMessageId: message!.id,
      sourceShortId: message!.short_id,
    };
  };
  const input = (
    source: { conversationId: string; sourceMessageId: string },
    intent: "reply" | "reply_all" | "forward" = "reply",
  ): DraftContentInput => ({
    conversationId: source.conversationId,
    sourceMessageId: source.sourceMessageId,
    senderIdentityId: identityId,
    intent,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "My text",
    format: "markdown",
    priority: "normal",
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
    quoteSource: null,
  });
  const create = async (intent: "reply" | "reply_all" | "forward" = "reply") =>
    unwrap(await drafts.createDraft({ context: owner, mailboxId, input: input(await thread(), intent) }));
  const attach = (draft: MailDraft) =>
    uploadDraftAttachmentStream({
      context: owner,
      mailboxId,
      draftId: draft.id,
      expectedRevision: draft.revision,
      filename: "personal.txt",
      contentType: "text/plain",
      byteLength: 4,
      stream: Readable.from("note"),
    });

  beforeAll(async () => {
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`one-reply-${newShortId()}`}, 'local', 'user', 'Ada', 'ada@example.test') RETURNING id`;
    userId = person!.id;
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing test user");
    owner = { actor: { kind: "user", user }, accessSubject: { type: "user", userId } };
    mailboxId = unwrap(await createMailbox(owner, { name: "One reply draft", description: "B1" })).id;
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailbox!.short_id;
    const [identity] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, from_address, automation_policy, status, is_default)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Team', 'team@example.test', 'mailbox', 'verified', true) RETURNING id, short_id`;
    identityId = identity!.id;
    identityShortId = identity!.short_id;
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES ('B1 Gustav', 'agent') RETURNING id`;
    accountId = account!.id;
    gustav = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: accountId,
          name: "B1 Gustav",
          kind: "agent",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: at,
        },
        delegatedUser: null,
        scopes: ["mail:write"],
        credentialId: null,
        credentialExpiresAt: null,
      },
      accessSubject: { type: "service_account", serviceAccountId: accountId },
    };
    grantIds.push(
      unwrap(
        await grantMailboxAccess({
          context: owner,
          mailboxId,
          principal: { type: "service_account", serviceAccountId: accountId },
          permission: "write",
        }),
      ).id,
    );
  });
  afterAll(async () => {
    const rows = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
    grantIds.push(...rows.map((row) => row.access_id));
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const id of new Set(grantIds)) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("concurrent creation returns one row, regardless of requested reply mode", async () => {
    const source = await thread();
    const results = await Promise.all(
      ["reply", "reply_all", "forward"].map((intent) =>
        drafts.createDraft({ context: owner, mailboxId, input: { ...input(source), intent: intent as "reply" | "reply_all" | "forward" } }),
      ),
    );
    expect(new Set(results.map((result) => unwrap(result).id)).size).toBe(1);
    const rows = await sql`SELECT id FROM mail.drafts WHERE conversation_id = ${source.conversationId}::uuid`;
    expect(rows).toHaveLength(1);
  });
  test("the database index reserves draft, scheduled and sending, and releases sent/discarded", async () => {
    const draft = await create();
    for (const state of ["draft", "scheduled", "sending"]) {
      await sql`UPDATE mail.drafts SET state = ${state} WHERE id = ${draft.id}::uuid`;
      const again = unwrap(
        await drafts.createDraft({
          context: owner,
          mailboxId,
          input: input({ conversationId: draft.conversationId!, sourceMessageId: draft.sourceMessageId! }),
        }),
      );
      expect(again.id).toBe(draft.id);
      await expect(
        sql`INSERT INTO mail.drafts (short_id, mailbox_id, conversation_id, source_message_id, intent,
        sender_identity_id, author_kind, last_editor_kind) VALUES (${newShortId()}, ${mailboxId}::uuid,
        ${draft.conversationId}::uuid, ${draft.sourceMessageId}::uuid, 'forward', ${identityId}::uuid, 'system', 'system')`.execute(),
      ).rejects.toThrow();
    }
    await sql`UPDATE mail.drafts SET state = 'sent' WHERE id = ${draft.id}::uuid`;
    const next = unwrap(
      await drafts.createDraft({
        context: owner,
        mailboxId,
        input: input({ conversationId: draft.conversationId!, sourceMessageId: draft.sourceMessageId! }),
      }),
    );
    expect(next.id).not.toBe(draft.id);
  });
  test("suggestions skip human/adopted drafts, and an untouched suggestion is the one draft", async () => {
    const human = await create();
    const skipped = unwrap(
      await drafts.createDraft({
        context: gustav,
        mailboxId,
        input: input({ conversationId: human.conversationId!, sourceMessageId: human.sourceMessageId! }),
      }),
    );
    expect(skipped.creationOutcome).toBe("suggestion_skipped");
    expect(skipped.body).toBe(human.body);
    expect(skipped.id).toBe(human.id);
    const source = await thread();
    const suggestion = unwrap(await drafts.createDraft({ context: gustav, mailboxId, input: input(source) }));
    const continued = unwrap(
      await drafts.createDraft({ context: owner, mailboxId, input: { ...input(source), body: "Must not replace" } }),
    );
    expect(continued.id).toBe(suggestion.id);
    expect(continued.suggestion).toBeTrue();
    expect(continued.body).toBe("My text");
    const adopted = unwrap(
      await drafts.updateDraft({
        context: owner,
        mailboxId,
        draftId: suggestion.id,
        expectedRevision: suggestion.revision,
        input: {
          senderIdentityId: suggestion.senderIdentityId,
          signatureTemplateId: suggestion.signatureTemplateId,
          quoteSource: suggestion.quoteSource,
          to: suggestion.to,
          cc: suggestion.cc,
          bcc: suggestion.bcc,
          subject: suggestion.subject,
          body: "Human edit",
          format: suggestion.format,
          priority: suggestion.priority,
          requestDeliveryReceipt: false,
          requestReadReceipt: false,
        },
      }),
    );
    expect(unwrap(await drafts.createDraft({ context: gustav, mailboxId, input: input(source) })).creationOutcome).toBe(
      "suggestion_skipped",
    );
    expect(adopted.body).toBe("Human edit");
  });
  test("REST and capability creation/materialization return the same draft", async () => {
    const source = await thread();
    if (owner.actor.kind !== "user") throw new Error("Missing user");
    const token = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
      kind: "user",
      payload: {},
      user: owner.actor.user,
      scopes: ["read", "write"],
    });
    try {
      const body = {
        ...input(source),
        conversationId: source.conversationShortId,
        sourceMessageId: source.sourceShortId,
        senderIdentityId: identityShortId,
      };
      const headers = { authorization: "Bearer b1", "content-type": "application/json" };
      const responses = await Promise.all(
        [1, 2].map(() => api.request(`/mailboxes/${mailboxShortId}/drafts`, { method: "POST", headers, body: JSON.stringify(body) })),
      );
      for (const response of responses) expect(response.status).toBe(200);
      const first = draftSchema.parse(await responses[0]!.json());
      const second = draftSchema.parse(await responses[1]!.json());
      expect(second.id).toBe(first.id);
      const result = unwrap(
        await mailCapabilities.actions["draft.create"].run(DraftCreateInputSchema.parse({ ...body, mailboxId: mailboxShortId }), cap()),
      );
      expect(result.data.id).toBe(first.id);
      expect(result.data.creationOutcome).toBe("existing");
      const skipped = unwrap(
        await mailCapabilities.actions["draft.create"].run(
          DraftCreateInputSchema.parse({
            ...body,
            mailboxId: mailboxShortId,
            attachments: [{ filename: "do-not-add.txt", contentType: "text/plain", base64: "bm8=" }],
          }),
          cap(gustav),
        ),
      );
      expect(skipped.data.creationOutcome).toBe("suggestion_skipped");
      expect(skipped.data.attachments).toHaveLength(0);
      const switched = await api.request(`/mailboxes/${mailboxShortId}/drafts/${first.id}/intent`, {
        method: "POST",
        headers,
        body: JSON.stringify({ intent: "reply_all", expectedRevision: first.revision }),
      });
      expect(switched.status).toBe(200);
      expect(draftSchema.parse(await switched.json()).intent).toBe("reply_all");
    } finally {
      token.mockRestore();
    }
  });
  for (const mode of ["lock", "shared"] as const)
    test(`mode switch derives recipients, subject and attachments in both directions (${mode})`, async () => {
      let draft = await create();
      await sql`UPDATE mail.drafts SET edit_mode = ${mode} WHERE id = ${draft.id}::uuid`;
      const documentBefore = mode === "shared" ? unwrap(await readDraftDocument({ context: owner, mailboxId, draftId: draft.id })) : null;
      draft = unwrap(await attach(draft));
      // Attach a source file using an existing complete blob; no external storage needed.
      const [part] = await sql<{ id: string }[]>`INSERT INTO mail.message_parts (message_id, part_path, content_type, size_bytes)
      VALUES (${draft.sourceMessageId}::uuid, '1', 'text/plain', 4) RETURNING id`;
      await sql`INSERT INTO mail.attachments (short_id, message_id, part_id, blob_id, filename, content_type, size_bytes, checksum)
      SELECT ${newShortId()}, ${draft.sourceMessageId}::uuid, ${part!.id}::uuid, blob_id, 'source.txt', content_type, byte_length, content_hash
      FROM mail.draft_attachments WHERE draft_id = ${draft.id}::uuid LIMIT 1`;
      const change = (intent: "reply" | "reply_all" | "forward", expectedRevision = draft.revision) =>
        drafts.switchDraftIntent({ context: owner, mailboxId, draftId: draft.id, intent, expectedRevision });
      draft = unwrap(await change("reply_all"));
      expect(draft.to.map((a) => a.address)).toEqual(["customer@example.test"]);
      expect(draft.cc.map((a) => a.address)).toEqual(["other@example.test", "copy@example.test"]);
      expect(draft.subject).toBe("Re: Question");
      expect(draft.body).toBe("My text");
      expect((await change("forward", draft.revision - 1)).ok).toBeFalse();
      draft = unwrap(await change("forward"));
      expect(draft.subject).toBe("Fwd: Question");
      expect(draft.to).toEqual([]);
      expect(draft.cc).toEqual([]);
      expect(draft.attachments.map((a) => a.filename).sort()).toEqual(["personal.txt", "source.txt"]);
      // Legacy initial forward copies had no provenance column; personal uploads still survive.
      await sql`UPDATE mail.draft_attachments a SET forwarded_source_message_id = NULL, created_at = d.created_at
        FROM mail.drafts d WHERE a.draft_id = d.id AND d.id = ${draft.id}::uuid AND a.filename = 'source.txt'`;
      draft = unwrap(await change("reply"));
      expect(draft.subject).toBe("Re: Question");
      expect(draft.to.map((a) => a.address)).toEqual(["customer@example.test"]);
      expect(draft.attachments.map((a) => a.filename)).toEqual(["personal.txt"]);
      if (documentBefore) {
        const documentAfter = unwrap(await readDraftDocument({ context: owner, mailboxId, draftId: draft.id }));
        expect(Number(documentAfter.generation)).toBeGreaterThan(Number(documentBefore.generation));
        expect(documentAfter.fresh.content).toMatchObject({ body: "My text", subject: "Re: Question", cc: [] });
      }
      expect(draft.body).toBe("My text");
      if (mode === "shared")
        expect(unwrap(await readDraftDocument({ context: owner, mailboxId, draftId: draft.id })).fresh.content.subject).toBe(draft.subject);
    });
  test("workflow and automatic replies reuse the box without sending its existing content", async () => {
    const draft = await create();
    const [workflow] = await sql<{ id: string }[]>`INSERT INTO workflows.workflow(app_id, scope_id, key, name, created_by_kind)
      VALUES ('mail', ${mailboxId}, ${newShortId()}, 'B1 automated reply', 'system') RETURNING id`;
    const [version] = await sql<{ id: string }[]>`INSERT INTO workflows.version(workflow_id, revision, source, source_hash, plan,
      language_id, language_version, manifest_hash, created_by_kind)
      VALUES (${workflow!.id}::uuid, 1, 'source', ${"a".repeat(64)}, '{}', 'test', 1, ${"b".repeat(64)}, 'system') RETURNING id`;
    const workflowVersionId = version!.id;
    const [run] = await sql<{ id: string }[]>`INSERT INTO workflows.run(app_id, scope_id, workflow_id, workflow_version_id,
      mode, authorization_snapshot, idempotency_key, occurred_at)
      VALUES ('mail', ${mailboxId}, ${workflow!.id}::uuid, ${workflowVersionId}::uuid, 'execute', '{}', 'b1-reply', ${at}) RETURNING id`;
    const result = unwrap(
      await sql.begin((tx) =>
        drafts.createWorkflowReplyDraftInTransaction({
          db: tx,
          mailboxId,
          workflowVersionId,
          draftId: crypto.randomUUID(),
          conversationId: draft.conversationId!,
          sourceMessageId: draft.sourceMessageId!,
          senderIdentityId: identityId,
          recipient: { name: null, address: "customer@example.test" },
          subject: "Auto",
          body: "Automation",
          format: "plain",
        }),
      ),
    );
    expect(result).toMatchObject({ id: draft.id, reused: true });
    const suppressed = unwrap(
      await sql.begin((tx) =>
        prepareAutomaticReplyInTransaction({
          db: tx,
          mailboxId,
          workflowVersionId,
          workflowRunId: run!.id,
          stepKey: "reply",
          messageId: draft.sourceMessageId!,
          conversationId: draft.conversationId!,
          senderIdentityId: identityId,
          subject: "Auto",
          body: "Automation",
          format: "plain",
          protocolFacts: { ...EMPTY_MESSAGE_PROTOCOL_FACTS, returnPath: "<customer@example.test>" },
          occurredAt: at,
          minimumIntervalHours: 1,
          schedule: { mode: "always" },
        }),
      ),
    );
    expect(suppressed).toMatchObject({ state: "suppressed", reasons: ["reply_draft_exists"] });
    expect(await sql`SELECT id FROM mail.outbox_submissions WHERE draft_id = ${draft.id}::uuid`).toHaveLength(0);
    expect(unwrap(await drafts.getDraft(owner, mailboxId, draft.id)).body).toBe("My text");
    await sql`DELETE FROM workflows.run WHERE id = ${run!.id}::uuid`;
    await sql`DELETE FROM workflows.version WHERE id = ${workflowVersionId}::uuid`;
    await sql`DELETE FROM workflows.workflow WHERE id = ${workflow!.id}::uuid`;
  });
  test("switching honors another editor's lease and capability revision checks", async () => {
    const draft = await create();
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.drafts WHERE id = ${draft.id}::uuid`;
    const operation = DraftSwitchIntentInputSchema.parse({
      mailboxId: mailboxShortId,
      draftId: row!.short_id,
      expectedRevision: draft.revision,
      intent: "forward",
    });
    unwrap(await acquireDraftLease({ context: owner, mailboxId, draftId: draft.id, editorId: crypto.randomUUID() }));
    const busy = await mailCapabilities.actions["draft.intent"].run(operation, cap(gustav));
    expect(busy.ok).toBeFalse();
    const switched = unwrap(await mailCapabilities.actions["draft.intent"].run(operation, cap()));
    expect(switched.data.revision).toBeGreaterThan(draft.revision);
    expect((await mailCapabilities.actions["draft.intent"].run(operation, cap())).ok).toBeFalse();
  });
  test("F6 preflight leaves the predecessor usable to reconcile uncertain duplicate sends", async () => {
    const draft = await create();
    await sql`DROP INDEX mail.drafts_one_open_reply_idx`.simple();
    const [loser] = await sql<{ id: string }[]>`INSERT INTO mail.drafts (short_id, mailbox_id, conversation_id, source_message_id, intent,
      sender_identity_id, author_kind, last_editor_kind, state, body_markdown, created_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${draft.conversationId}::uuid, ${draft.sourceMessageId}::uuid, 'reply',
        ${identityId}::uuid, 'system', 'system', 'sending', 'Uncertain send', '2026-10-01') RETURNING id`;
    await sql`DELETE FROM mail.schema_migrations WHERE version = 4`;
    await expect(migrate()).rejects.toThrow("F6 preflight");
    expect(await sql`SELECT version FROM mail.schema_migrations WHERE version = 4`).toHaveLength(0);
    expect(
      await sql`SELECT id FROM mail.drafts WHERE conversation_id = ${draft.conversationId}::uuid AND state <> 'discarded'`,
    ).toHaveLength(2);
    // Simulate reconciliation before retrying the new startup.
    await sql`UPDATE mail.drafts SET state = 'draft' WHERE id = ${loser!.id}::uuid`;
    expect(await migrate()).toEqual({ deletedDrafts: 1, affectedConversations: 1, completed: true });
  });
  test("F6 keeps real last edit, scrubs discarded content and attachments, counts once and acknowledges", async () => {
    let older = await create();
    older = unwrap(await attach(older));
    const source = { conversationId: older.conversationId!, sourceMessageId: older.sourceMessageId! };
    await sql`DROP INDEX mail.drafts_one_open_reply_idx`.simple();
    const [loser] = await sql<{ id: string }[]>`INSERT INTO mail.drafts (short_id, mailbox_id, conversation_id, source_message_id, intent,
      sender_identity_id, author_kind, last_editor_kind, body_markdown, created_at, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${source.conversationId}::uuid, ${source.sourceMessageId}::uuid, 'reply',
        ${identityId}::uuid, 'system', 'system', 'Unedited copy', '2026-10-01', '2026-11-30') RETURNING id`;
    await sql`INSERT INTO mail.draft_attachments (short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position)
      SELECT ${newShortId()}, ${loser!.id}::uuid, blob_id, 'discard.txt', content_type, byte_length, content_hash, 0
      FROM mail.draft_attachments WHERE draft_id = ${older.id}::uuid LIMIT 1`;
    await sql`UPDATE mail.drafts SET edit_mode = 'shared' WHERE id = ${loser!.id}::uuid`;
    unwrap(await readDraftDocument({ context: owner, mailboxId, draftId: loser!.id }));
    const lease = unwrap(await acquireDraftLease({ context: owner, mailboxId, draftId: loser!.id, editorId: crypto.randomUUID() }));
    // Metadata maintenance after the real edit must not select the losing row.
    await sql`UPDATE mail.drafts SET content_edited_at = '2026-11-01', updated_at = '2026-11-30', doc_idle_through = 99 WHERE id = ${loser!.id}::uuid`;
    await sql`UPDATE mail.schema_migrations SET details = '{"deletedDrafts":0,"affectedConversations":0,"completed":false}' WHERE version = 4`;
    await sql`UPDATE mail.drafts SET edit_mode = 'shared', created_at = '2026-10-01' WHERE id = ${older.id}::uuid`;
    unwrap(await readDraftDocument({ context: owner, mailboxId, draftId: older.id }));
    await sql`UPDATE mail.draft_document_revisions SET created_at = '2026-11-30' WHERE draft_id = ${older.id}::uuid`;
    await sql`UPDATE mail.drafts SET content_edited_at = NULL WHERE id = ${older.id}::uuid`;
    await sql`UPDATE mail.draft_provider_snapshots SET created_at = '2026-11-30' WHERE draft_id = ${older.id}::uuid`;
    // Cross the 100-draft transaction budget. Origins share the same box.
    await sql`INSERT INTO mail.drafts (short_id, mailbox_id, conversation_id, source_message_id, intent,
      sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, origin, body_markdown, created_at)
      SELECT 'B1' || lpad(n::text, 4, '0'), ${mailboxId}::uuid, ${source.conversationId}::uuid,
        ${source.sourceMessageId}::uuid, 'forward', ${identityId}::uuid, 'workflow', ${crypto.randomUUID()}::uuid, 'workflow', ${crypto.randomUUID()}::uuid, 'workflow',
        'Old automated copy', '2026-10-01' FROM generate_series(1, 103) n`;
    const result = await migrate();
    expect(result).toEqual({ deletedDrafts: 104, affectedConversations: 1, completed: true });
    const kept = unwrap(await drafts.getDraft(owner, mailboxId, older.id));
    expect(kept.consolidatedCount).toBe(104);
    expect(kept.body).toBe("My text");
    expect(await sql`SELECT id FROM mail.draft_attachments WHERE draft_id = ${loser!.id}::uuid`).toHaveLength(0);
    const [erased] = await sql<
      { state: string; body_markdown: string; doc_state: Uint8Array | null }[]
    >`SELECT state, body_markdown, doc_state FROM mail.drafts WHERE id = ${loser!.id}::uuid`;
    expect(erased).toEqual({ state: "discarded", body_markdown: "", doc_state: null });
    expect(await sql`SELECT 1 FROM mail.draft_document_revisions WHERE draft_id = ${loser!.id}::uuid`).toHaveLength(0);
    await finishReplyDraftRetirements();
    expect(await sql`SELECT 1 FROM mail.reply_draft_retirements WHERE draft_id = ${loser!.id}::uuid`).toHaveLength(0);
    expect((await heartbeatDraftLease({ context: owner, mailboxId, draftId: loser!.id, token: lease.token })).ok).toBeFalse();
    expect(await migrate()).toEqual(result);
    const acknowledged = unwrap(await drafts.acknowledgeDraftConsolidation({ context: owner, mailboxId, draftId: older.id }));
    expect(acknowledged.consolidatedCount).toBe(0);
    expect(acknowledged.revision).toBe(kept.revision);
    expect(await migrate()).toEqual(result);
  });
});
