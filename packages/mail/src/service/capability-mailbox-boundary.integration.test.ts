import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { accounts } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { createConversationComment } from "./collaboration";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats", "valkey");
const at = "2026-10-20T06:00:00.000Z";

/**
 * A caller who cannot read a mailbox gets the same answer for an existing ID inside it as for an unknown one, so no
 * capability tells whether a conversation, comment or draft exists. A caller who can read the mailbox but lacks the
 * right for one action is still refused as forbidden.
 */
suite("Mail capabilities check mailbox access before resolving IDs", () => {
  const users: string[] = [];
  const grantIds: string[] = [];
  let owner: CapabilityExecutionContext;
  let reader: CapabilityExecutionContext;
  let assigned: CapabilityExecutionContext;
  let outsider: CapabilityExecutionContext;
  let mailboxId = "";
  let mailboxShortId = "";
  let conversationShortId = "";
  let commentShortId = "";
  let messageShortId = "";
  let draftShortId = "";

  const createUser = async (name: string): Promise<CapabilityExecutionContext> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail, admin)
      VALUES (${`mail-boundary-${newShortId()}`}, 'local', 'user', ${name}, ${`${name}@internal.test`}, false) RETURNING id`;
    if (!row) throw new Error("Missing boundary fixture user");
    users.push(row.id);
    const user = await accounts.users.get({ id: row.id });
    if (!user) throw new Error("Missing boundary fixture user");
    return {
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: row.id },
      user,
      requestId: `mail-boundary-${name}`,
      origin: "assistant",
      locale: "en",
      signal: new AbortController().signal,
    };
  };
  const mailContext = (context: CapabilityExecutionContext): MailRequestContext => ({
    actor: context.actor,
    accessSubject: context.accessSubject,
    requestId: context.requestId,
  });
  /** The error of a failed call; a successful call fails the test. */
  const refusal = async (call: Promise<{ ok: boolean; error?: unknown }>) => {
    const result = await call;
    expect(result.ok).toBeFalse();
    return result.error;
  };

  beforeEach(async () => {
    setSystemTime(new Date(at));
    users.length = 0;
    grantIds.length = 0;
    owner = await createUser("Owner");
    reader = await createUser("Reader");
    outsider = await createUser("Outsider");
    assigned = await createUser("Assigned");
    const mailbox = unwrap(await createMailbox(mailContext(owner), { name: "Team Ops", description: "Boundary fixture" }));
    mailboxId = mailbox.id;
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailboxRow!.short_id;
    for (const [principal, scope] of [
      [reader, undefined],
      [assigned, "assigned"],
    ] as const) {
      const grant = unwrap(
        await grantMailboxAccess({
          context: mailContext(owner),
          mailboxId,
          principal: { type: "user", userId: principal.accessSubject.type === "user" ? principal.accessSubject.userId : "" },
          permission: "read",
          scope,
        }),
      );
      grantIds.push(grant.id);
    }
    const [conversation] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Release', 'lea@outside.test', ${at}) RETURNING id, short_id`;
    conversationShortId = conversation!.short_id;
    const [message] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${newShortId()}@example.test>`}, 'Release', ${at}, 1,
        ${new Bun.CryptoHasher("sha256").update(`release-${mailboxId}`).digest("hex")}, 'complete') RETURNING id, short_id`;
    messageShortId = message!.short_id;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 0)`;
    unwrap(
      await createConversationComment({
        context: mailContext(owner),
        mailboxId,
        conversationId: conversation!.id,
        input: { body: "Internal note" },
      }),
    );
    const [comment] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.conversation_comments
      WHERE conversation_id = ${conversation!.id}::uuid`;
    commentShortId = comment!.short_id;
    const ownerId = owner.accessSubject.type === "user" ? owner.accessSubject.userId : "";
    const [identity] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Team', 'Team Ops', 'team@internal.test', 'verified') RETURNING id`;
    const [draft] = await sql<{ short_id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, subject, body_markdown, revision, created_at, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${identity!.id}::uuid, 'user', ${ownerId}::uuid, 'user', ${ownerId}::uuid, 'Maintenance', 'Hello', 1, ${at}, ${at})
      RETURNING short_id`;
    draftShortId = draft!.short_id;
  }, 30_000);

  afterEach(async () => {
    setSystemTime();
    if (mailboxId) {
      const links = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
        UNION SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid`;
      grantIds.push(...links.map((link) => link.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${grantIds}::jsonb))`;
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${users}::jsonb))`;
  }, 30_000);

  const unknown = () => newShortId();
  const notFound = { code: "NOT_FOUND", status: 404 };
  const forbidden = { code: "FORBIDDEN", status: 403 };

  test("batch reviews and runs hide unreadable mailboxes before any conversation lookup", async () => {
    const assign = mailCapabilities.actions["conversation.assign.batch"];
    const status = mailCapabilities.actions["conversation.status.update.batch"];
    const legacyStatus = mailCapabilities.actions["conversation.status.set.batch"];
    for (const phase of ["review", "run"] as const) {
      const calls = [
        (mailbox: string, conversation: string) =>
          assign[phase](
            { conversationIds: [conversation], mode: "replace", assigneeUserIds: [] },
            { ...outsider, target: { type: "mail.mailbox", id: mailbox } },
          ),
        ...[status, legacyStatus].map(
          (action) => (mailbox: string, conversation: string) =>
            action[phase](
              { conversationIds: [conversation], status: "done" },
              { ...outsider, target: { type: "mail.mailbox", id: mailbox } },
            ),
        ),
      ];
      for (const call of calls) {
        const existing = await refusal(call(mailboxShortId, conversationShortId));
        const missingConversation = await refusal(call(mailboxShortId, unknown()));
        const missingMailbox = await refusal(call(unknown(), conversationShortId));
        expect(missingConversation).toEqual(existing);
        expect(existing).toMatchObject(notFound);
        expect(missingMailbox).toEqual(existing);
      }
    }
  });

  test("new summary and reference actions hide unreadable mailboxes in review and run", async () => {
    const summary = mailCapabilities.actions["conversation.summary.write"];
    const reference = mailCapabilities.actions["conversation.reference.ensure"];
    for (const phase of ["review", "run"] as const) {
      const context = { ...outsider, idempotencyKey: `boundary-${phase}` };
      const calls = [
        (mailbox: string, conversation: string) =>
          summary[phase](
            { conversationId: conversation, expectedRevision: 1, expectedSummaryRevision: 0, summary: "Prepared" },
            { ...context, target: { type: "mail.mailbox", id: mailbox } },
          ),
        (mailbox: string, conversation: string) =>
          reference[phase]({ conversationId: conversation }, { ...context, target: { type: "mail.mailbox", id: mailbox } }),
      ];
      for (const call of calls) {
        const existing = await refusal(call(mailboxShortId, conversationShortId));
        expect(existing).toMatchObject(notFound);
        expect(await refusal(call(mailboxShortId, unknown()))).toEqual(existing);
        expect(await refusal(call(unknown(), conversationShortId))).toEqual(existing);
      }
    }
  });

  test("conversation reviews answer an unreadable mailbox like an unknown conversation", async () => {
    const statusReview = (context: CapabilityExecutionContext, mailbox: string, conversation: string) =>
      mailCapabilities.actions["conversation.status.update"].review(
        { conversationId: conversation, expectedRevision: 1, status: "done" },
        { ...context, target: { type: "mail.mailbox", id: mailbox } },
      );
    const commentReview = (context: CapabilityExecutionContext, conversation: string) =>
      mailCapabilities.actions["conversation.comment.create"].review(
        { conversationId: conversation, body: "Hello" },
        { ...context, target: { type: "mail.mailbox", id: mailboxShortId } },
      );

    const existing = await refusal(statusReview(outsider, mailboxShortId, conversationShortId));
    expect(existing).toMatchObject(notFound);
    expect(await refusal(statusReview(outsider, mailboxShortId, unknown()))).toEqual(existing);
    expect(await refusal(statusReview(outsider, unknown(), conversationShortId))).toEqual(existing);
    expect(await refusal(commentReview(outsider, conversationShortId))).toEqual(await refusal(commentReview(outsider, unknown())));

    expect(await refusal(statusReview(reader, mailboxShortId, conversationShortId))).toMatchObject(forbidden);
    expect((await commentReview(reader, conversationShortId)).ok).toBeTrue();
    expect((await statusReview(owner, mailboxShortId, conversationShortId)).ok).toBeTrue();
  });

  test("comment reviews and runs answer an unreadable mailbox like an unknown comment", async () => {
    const update = mailCapabilities.actions["conversation.comment.update"];
    const remove = mailCapabilities.actions["conversation.comment.delete"];
    const target = (conversation: string, comment: string) => ({
      conversationId: conversation,
      commentId: comment,
      expectedRevision: 1,
    });
    const scoped = (context: CapabilityExecutionContext): CapabilityExecutionContext => ({
      ...context,
      target: { type: "mail.mailbox", id: mailboxShortId },
    });
    const deleteRun = (context: CapabilityExecutionContext, conversation: string, comment: string) =>
      remove.run(target(conversation, comment), { ...scoped(context), idempotencyKey: `delete-${newShortId()}` });

    const existing = await refusal(update.review({ ...target(conversationShortId, commentShortId), body: "Changed" }, scoped(outsider)));
    expect(existing).toMatchObject(notFound);
    expect(await refusal(update.review({ ...target(conversationShortId, unknown()), body: "Changed" }, scoped(outsider)))).toEqual(
      existing,
    );
    expect(await refusal(update.review({ ...target(unknown(), commentShortId), body: "Changed" }, scoped(outsider)))).toEqual(existing);
    expect(await refusal(deleteRun(outsider, conversationShortId, commentShortId))).toEqual(
      await refusal(deleteRun(outsider, conversationShortId, unknown())),
    );

    expect(await refusal(update.review({ ...target(conversationShortId, commentShortId), body: "Changed" }, scoped(reader)))).toMatchObject(
      forbidden,
    );
    expect(await refusal(deleteRun(reader, conversationShortId, commentShortId))).toMatchObject(forbidden);
    expect((await update.review({ ...target(conversationShortId, commentShortId), body: "Changed" }, scoped(owner))).ok).toBeTrue();
    const [comment] = await sql<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM mail.conversation_comments
      WHERE short_id = ${commentShortId}`;
    expect(comment?.deleted_at).toBeNull();
  });

  test("draft reviews and mailbox queries answer an unreadable mailbox like an unknown ID", async () => {
    const discard = (context: CapabilityExecutionContext, draft: string) =>
      mailCapabilities.actions["draft.discard"].review(
        { draftId: draft, expectedRevision: 1 },
        { ...context, target: { type: "mail.mailbox", id: mailboxShortId } },
      );
    const comments = (context: CapabilityExecutionContext, conversation: string) =>
      mailCapabilities.queries["conversation.comment.list"].run(
        mailCapabilities.queries["conversation.comment.list"].input.parse({ conversationId: conversation }),
        { ...context, target: { type: "mail.mailbox", id: mailboxShortId } },
      );

    const existingDraft = await refusal(discard(outsider, draftShortId));
    expect(existingDraft).toMatchObject(notFound);
    expect(await refusal(discard(outsider, unknown()))).toEqual(existingDraft);
    expect(await refusal(discard(reader, draftShortId))).toMatchObject(forbidden);
    expect((await discard(owner, draftShortId)).ok).toBeTrue();
    // The draft lies outside the assigned-only reader's conversations: the review and the change answer like an unknown draft.
    expect(await refusal(discard(assigned, draftShortId))).toEqual(await refusal(discard(assigned, unknown())));
    const patch = (draft: string) =>
      mailCapabilities.actions["draft.patch"].run(
        { draftId: draft, expectedRevision: 1, patch: { subject: "Changed" } },
        { ...assigned, target: { type: "mail.mailbox", id: mailboxShortId } },
      );
    expect(await refusal(patch(draftShortId))).toEqual(await refusal(patch(unknown())));
    const sendReview = (draft: string) =>
      mailCapabilities.queries["draft.send.review"].run(
        mailCapabilities.queries["draft.send.review"].input.parse({ draftId: draft, expectedRevision: 1 }),
        { ...assigned, target: { type: "mail.mailbox", id: mailboxShortId } },
      );
    expect(await refusal(sendReview(draftShortId))).toEqual(await refusal(sendReview(unknown())));

    const existingComments = await refusal(comments(outsider, conversationShortId));
    expect(existingComments).toMatchObject(notFound);
    expect(await refusal(comments(outsider, unknown()))).toEqual(existingComments);
    expect((await comments(reader, conversationShortId)).ok).toBeTrue();
  });

  test("reads by ID answer an unreadable mailbox or a hidden conversation like an unknown ID", async () => {
    const read = (
      id: "conversation.read" | "message.read" | "comment.read" | "draft.read",
      context: CapabilityExecutionContext,
      ref: string,
    ) => mailCapabilities.queries[id].run(mailCapabilities.queries[id].input.parse({ id: ref }), context);
    const refs = {
      "conversation.read": conversationShortId,
      "message.read": messageShortId,
      "comment.read": commentShortId,
      "draft.read": draftShortId,
    } as const;

    for (const [id, ref] of Object.entries(refs) as Array<[keyof typeof refs, string]>) {
      const existing = await refusal(read(id, outsider, ref));
      expect(existing).toMatchObject(notFound);
      expect(await refusal(read(id, outsider, unknown()))).toEqual(existing);
      expect((await read(id, owner, ref)).ok).toBeTrue();
    }
    for (const id of ["conversation.read", "message.read", "comment.read"] as const) {
      expect((await read(id, reader, refs[id])).ok).toBeTrue();
      // The assigned-only reader can read the mailbox but sees no conversation in it.
      expect(await refusal(read(id, assigned, refs[id]))).toEqual(await refusal(read(id, assigned, unknown())));
    }
  });

  test("a scheduled delivery outside an assigned grant answers like an unknown delivery", async () => {
    if (owner.accessSubject.type !== "user") throw new Error("Expected owner user");
    const ownerId = owner.accessSubject.userId;
    const [draft] = await sql<{ id: string; sender_identity_id: string }[]>`SELECT id, sender_identity_id FROM mail.drafts
      WHERE short_id = ${draftShortId}`;
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}) RETURNING id`;
    const [connection] = await sql<{ id: string }[]>`INSERT INTO mail.provider_connections
      (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, status)
      VALUES (${mailboxId}::uuid, 'Test', 'team@internal.test', 'team@internal.test', 'imap.example.test', 993, 'implicit',
        'smtp.example.test', 587, 'starttls', 'password', 'revoked') RETURNING id`;
    const [binding] = await sql<{ id: string }[]>`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, remote_locator)
      VALUES (${resource!.id}::uuid, ${connection!.id}::uuid, '{}'::jsonb) RETURNING id`;
    const [command] = await sql<{ id: string }[]>`INSERT INTO mail.commands
      (mailbox_id, kind, actor_kind, actor_id, access_subject_kind, access_subject_id, idempotency_key, request_hash, target, payload)
      VALUES (${mailboxId}::uuid, 'send', 'user', ${ownerId}::uuid, 'user', ${ownerId}::uuid, ${newShortId()}, ${"a".repeat(64)},
        '{}'::jsonb, ${{ scheduledAt: at }}::jsonb) RETURNING id`;
    const [delivery] = await sql<{ short_id: string }[]>`INSERT INTO mail.outbox_submissions
      (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id,
        state, scheduled_at, requested_at, mime_date, draft_snapshot, created_at, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${draft!.id}::uuid, ${command!.id}::uuid, ${draft!.sender_identity_id}::uuid,
        ${binding!.id}::uuid, ${`<${newShortId()}@internal.test>`}, 'scheduled', ${at}, ${at}, ${at},
        ${{ to: [], cc: [], bcc: [], subject: "Scheduled", body: "Body", renderedText: "Body" }}::jsonb, ${at}, ${at}) RETURNING short_id`;
    const read = (context: CapabilityExecutionContext, id: string) => mailCapabilities.queries["delivery.read"].run({ id }, context);
    expect((await read(owner, delivery!.short_id)).ok).toBeTrue();
    expect((await read(reader, delivery!.short_id)).ok).toBeTrue();
    for (const context of [assigned, outsider]) {
      const hidden = await refusal(read(context, delivery!.short_id));
      expect(hidden).toMatchObject(notFound);
      expect(hidden).toEqual(await refusal(read(context, unknown())));
    }
  });

  test("a keep release refuses a caller who may not release keeps alike for known and unknown IDs", async () => {
    const release = (conversation: string) =>
      mailCapabilities.actions["conversation.keep.release"].run(
        { conversationId: conversation },
        { ...{ ...owner, idempotencyKey: `release-${newShortId()}` }, target: { type: "mail.mailbox", id: mailboxShortId } },
      );

    const existing = await refusal(release(conversationShortId));
    expect(existing).toMatchObject(forbidden);
    expect(await refusal(release(unknown()))).toEqual(existing);
  });
});
