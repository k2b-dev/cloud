import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { accounts, oauthTokens } from "@k2b/cloud/services";
import { captureTableAction, SHARED_TEXT_NAME } from "@k2b/cloud/shared-text";
import { type Result, unwrap } from "@k2b/stdlib";
import { findTables, gridLine } from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import app from "../api";
import { mailCapabilities } from "../capabilities";
import { type DraftEditableContent, draftSchema, type MailDraft } from "../contracts";
import { createDraftRevisionUpdate } from "../lib/draft-document";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import * as integrations from "./app-integrations";
import type { MailRequestContext } from "./auth";
import { attachEventInvitation } from "./calendar-invitations";
import { sha256Json } from "./canonical";
import { mergeConversations } from "./conversations";
import { acceptDraftDocumentUpdate, lockDraftDocumentInTransaction, readDraftDocument } from "./draft-documents";
import { acquireDraftLease, releaseDraftLease } from "./draft-leases";
import { applyDraftTableAction } from "./draft-table-actions";
import * as uploads from "./draft-uploads";
import * as drafts from "./drafts";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats", "valkey");
const at = "2026-11-08T12:00:00.000Z";
const refused = (result: Result<unknown>) => {
  expect(result.ok).toBeFalse();
  if (!result.ok) expect(result.error.code).toBe("DRAFT_ADOPTED");
};
const editable = (draft: DraftEditableContent): DraftEditableContent => ({
  senderIdentityId: draft.senderIdentityId,
  signatureTemplateId: draft.signatureTemplateId,
  quoteSource: draft.quoteSource,
  to: draft.to,
  cc: draft.cc,
  bcc: draft.bcc,
  subject: draft.subject,
  body: draft.body,
  format: draft.format,
  priority: draft.priority,
  requestDeliveryReceipt: draft.requestDeliveryReceipt,
  requestReadReceipt: draft.requestReadReceipt,
});

suite("Mail service-account suggestions", () => {
  let owner: MailRequestContext;
  let gustav: MailRequestContext;
  /** A second automated author: an account an app or automation writes with, not an agent. */
  let invoices: MailRequestContext;
  let invoicesAccountId: string;
  let delegated: MailRequestContext;
  let mailboxId: string;
  let mailboxShortId: string;
  let identityId: string;
  let secondIdentityId: string;
  let signatureId: string;
  let userId: string;
  let accountId: string;
  let delegatedAccountId: string;
  const grants: string[] = [];
  let messageSequence = 0;

  const conversation = async () => {
    const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.test>`}, 'Question', ${at},
        1, ${(++messageSequence).toString(16).padStart(64, "0")}, 'complete', 'Question') RETURNING id`;
    const [row] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Question', 'customer@example.test', ${at}) RETURNING id, short_id`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${row!.id}::uuid, ${message!.id}::uuid, 0, 'headers')`;
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
      VALUES (${message!.id}::uuid, 'from', 0, 'customer@example.test', 'customer@example.test')`;
    return { id: row!.id, shortId: row!.short_id, messageId: message!.id };
  };
  const input = (thread: Awaited<ReturnType<typeof conversation>>, body = "Suggested reply") => ({
    senderIdentityId: identityId,
    signatureTemplateId: null,
    quoteSource: null,
    conversationId: thread.id,
    sourceMessageId: thread.messageId,
    intent: "reply" as const,
    to: [{ address: "customer@example.test" }],
    cc: [],
    bcc: [],
    subject: "Re: Question",
    body,
    format: "plain" as const,
    priority: "normal" as const,
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
  });
  const suggest = async (body = "Suggested reply") =>
    unwrap(
      await drafts.createDraft({
        context: gustav,
        mailboxId,
        input: input(await conversation(), body),
      }),
    );
  const save = (draft: MailDraft, context: MailRequestContext, patch: Partial<DraftEditableContent>) =>
    drafts.updateDraft({
      context,
      mailboxId,
      draftId: draft.id,
      expectedRevision: draft.revision,
      input: { ...editable(draft), ...patch },
    });
  const adoption = async (id: string) => {
    const [row] = await sql<{ adopted_at: Date | null }[]>`SELECT adopted_at FROM mail.drafts WHERE id = ${id}::uuid`;
    return row!.adopted_at?.toISOString() ?? null;
  };
  const attach = (draft: MailDraft, context = owner, filename = "notes.txt") =>
    uploads.uploadDraftAttachmentStream({
      context,
      mailboxId,
      draftId: draft.id,
      expectedRevision: draft.revision,
      filename,
      contentType: "text/plain",
      byteLength: 4,
      stream: Readable.from(Buffer.from("note")),
    });
  const capability = (context: MailRequestContext): CapabilityExecutionContext => ({
    ...context,
    user: context.actor.kind === "user" ? context.actor.user : context.actor.delegatedUser,
    requestId: "draft-suggestions-test",
    origin: "assistant",
    locale: "en",
    signal: new AbortController().signal,
  });
  const publicDraftId = async (id: string) => {
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.drafts WHERE id = ${id}::uuid`;
    return row!.short_id;
  };

  beforeAll(async () => {
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`suggestion-${newShortId()}`}, 'local', 'user', 'Ada', 'ada@example.test') RETURNING id`;
    userId = person!.id;
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing test user");
    owner = { actor: { kind: "user", user }, accessSubject: { type: "user", userId } };
    mailboxId = unwrap(await createMailbox(owner, { name: "Suggestion tests", description: "C3" })).id;
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailbox!.short_id;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES ('Gustav', 'agent') RETURNING id`;
    accountId = account!.id;
    gustav = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: accountId,
          name: "Gustav",
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
    const [delegatedAccount] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
      VALUES ('Personal test credential', 'user_delegated', ${userId}::uuid) RETURNING id`;
    delegatedAccountId = delegatedAccount!.id;
    if (gustav.actor.kind !== "service_account") throw new Error("Expected service account fixture");
    delegated = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          ...gustav.actor.serviceAccount,
          id: delegatedAccountId,
          kind: "user_delegated",
          delegatedUserId: userId,
        },
        delegatedUser: user,
        scopes: [],
      },
      accessSubject: { type: "user", userId },
    };
    grants.push(unwrap(await grantMailboxAccess({ context: owner, mailboxId, principal: gustav.accessSubject, permission: "write" })).id);
    const [invoicesAccount] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES ('Rechnungseingang', 'standalone') RETURNING id`;
    invoicesAccountId = invoicesAccount!.id;
    invoices = {
      actor: {
        ...gustav.actor,
        serviceAccount: { ...gustav.actor.serviceAccount, id: invoicesAccountId, name: "Rechnungseingang", kind: "standalone" },
      },
      accessSubject: { type: "service_account", serviceAccountId: invoicesAccountId },
    };
    grants.push(unwrap(await grantMailboxAccess({ context: owner, mailboxId, principal: invoices.accessSubject, permission: "write" })).id);
    for (const second of [false, true]) {
      const [sender] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
        (short_id, mailbox_id, label, from_address, automation_policy, status)
        VALUES (${newShortId()}, ${mailboxId}::uuid, 'Sender', ${second ? "other@example.test" : "team@example.test"},
          'disabled', 'verified') RETURNING id`;
      if (second) secondIdentityId = sender!.id;
      else identityId = sender!.id;
    }
    const [signature] = await sql<{ id: string }[]>`INSERT INTO mail.compose_templates
      (short_id, mailbox_id, kind, scope, name, normalized_name, shortcut, body_template, created_by_actor_kind, created_by_actor_id)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'signature', 'mailbox', 'Regards', 'regards', 'sig',
        'Regards, Team', 'user', ${userId}::uuid) RETURNING id`;
    signatureId = signature!.id;
  });
  afterAll(async () => {
    const rows = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
    grants.push(...rows.map((row) => row.access_id));
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const id of new Set(grants)) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    await sql`DELETE FROM auth.service_accounts WHERE id IN (${accountId}::uuid, ${delegatedAccountId}::uuid, ${invoicesAccountId}::uuid)`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("human creation is adopted; opening and leasing a suggestion are not edits", async () => {
    const human = unwrap(await drafts.createDraft({ context: owner, mailboxId, input: input(await conversation()) }));
    expect(human.suggestion).toBeFalse();
    expect(await adoption(human.id)).not.toBeNull();
    // A person's own draft stays open to Gustav, which changes it only on request; only adopted suggestions close.
    unwrap(await save(human, gustav, { body: "Changed on request" }));
    const draft = await suggest();
    const lease = unwrap(await acquireDraftLease({ context: owner, mailboxId, draftId: draft.id }));
    unwrap(await releaseDraftLease({ context: owner, mailboxId, draftId: draft.id, token: lease.token }));
    expect(unwrap(await drafts.getDraft(owner, mailboxId, draft.id)).suggestion).toBeTrue();
    expect(await adoption(draft.id)).toBeNull();
  });

  test("delegated creation adopts immediately and does not reuse an untouched suggestion", async () => {
    const suggestion = await suggest();
    const thread = { id: suggestion.conversationId!, shortId: "unused", messageId: suggestion.sourceMessageId! };
    const created = unwrap(await drafts.createDraft({ context: delegated, mailboxId, input: input(thread, "Person's own text") }));
    expect(created.id).not.toBe(suggestion.id);
    expect(created.suggestion).toBeFalse();
    expect(await adoption(created.id)).not.toBeNull();
    expect(unwrap(await drafts.getDraft(owner, mailboxId, suggestion.id)).suggestion).toBeTrue();
  });

  test("GET draft and conversation drafts expose suggestion; REST PUT adopts", async () => {
    const draft = await suggest();
    const id = await publicDraftId(draft.id);
    const [thread] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.conversations WHERE id = ${draft.conversationId}::uuid`;
    if (owner.actor.kind !== "user") throw new Error("Expected human fixture");
    const token = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
      kind: "user",
      payload: {},
      user: owner.actor.user,
      scopes: ["read", "write"],
    });
    const headers = { authorization: "Bearer suggestion-test", "content-type": "application/json" };
    try {
      const read = await app.request(`/mailboxes/${mailboxShortId}/drafts/${id}`, { headers });
      expect(read.status).toBe(200);
      const shown = draftSchema.parse(await read.json());
      expect(shown.suggestion).toBeTrue();
      const list = await app.request(`/mailboxes/${mailboxShortId}/conversations/${thread!.short_id}/drafts`, { headers });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject([{ id, suggestion: true }]);
      const saved = await app.request(`/mailboxes/${mailboxShortId}/drafts/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ expectedRevision: shown.revision, draft: { ...editable(shown), body: "REST edit" } }),
      });
      expect(saved.status).toBe(200);
      expect(draftSchema.parse(await saved.json()).suggestion).toBeFalse();
      const refreshed = await app.request(`/mailboxes/${mailboxShortId}/conversations/${thread!.short_id}/drafts`, { headers });
      expect(await refreshed.json()).toMatchObject([{ id, suggestion: false }]);
    } finally {
      token.mockRestore();
    }
  });

  test("each automated author keeps its own suggestion, named after its account, and adoption closes only that one", async () => {
    const thread = await conversation();
    const fromGustav = unwrap(await drafts.createDraft({ context: gustav, mailboxId, input: input(thread, "From Gustav") }));
    const fromInvoices = unwrap(await drafts.createDraft({ context: invoices, mailboxId, input: input(thread, "From invoices") }));
    // Two authors, two suggestions with their own content and their own name; neither gets the other's draft.
    expect(fromInvoices.id).not.toBe(fromGustav.id);
    expect([fromGustav.body, fromGustav.suggestion, fromGustav.suggestedBy]).toEqual(["From Gustav", true, "Gustav"]);
    expect([fromInvoices.body, fromInvoices.suggestion, fromInvoices.suggestedBy]).toEqual(["From invoices", true, "Rechnungseingang"]);
    // The same author again returns its own untouched suggestion unchanged.
    const again = unwrap(await drafts.createDraft({ context: invoices, mailboxId, input: input(thread, "Second try") }));
    expect([again.id, again.body]).toEqual([fromInvoices.id, "From invoices"]);
    expect(unwrap(await drafts.createDraft({ context: gustav, mailboxId, input: input(thread, "Gustav again") })).id).toBe(fromGustav.id);
    const [open] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.drafts
      WHERE conversation_id = ${thread.id}::uuid AND state = 'draft'`;
    expect(open?.count).toBe(2);
    // The conversation's draft rows name each author.
    if (owner.actor.kind !== "user") throw new Error("Expected human fixture");
    const token = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
      kind: "user",
      payload: {},
      user: owner.actor.user,
      scopes: ["read", "write"],
    });
    try {
      const list = await app.request(`/mailboxes/${mailboxShortId}/conversations/${thread.shortId}/drafts`, {
        headers: { authorization: "Bearer suggestion-test" },
      });
      expect(list.status).toBe(200);
      const rows = (await list.json()) as { createdByDisplayName: string; suggestion: boolean; bodyPreview: string }[];
      expect(
        rows.map(({ createdByDisplayName, suggestion, bodyPreview }) => [createdByDisplayName, suggestion, bodyPreview]).sort(),
      ).toEqual([
        ["Gustav", true, "From Gustav"],
        ["Rechnungseingang", true, "From invoices"],
      ]);
    } finally {
      token.mockRestore();
    }
    // A person takes over Gustav's suggestion: only that one closes to its author.
    const taken = unwrap(await save(fromGustav, owner, { body: "Ada's reply" }));
    expect([taken.suggestion, taken.suggestedBy]).toEqual([false, null]);
    refused(await save(taken, gustav, { body: "Gustav overrides" }));
    const revised = unwrap(await save(fromInvoices, invoices, { body: "Invoices revised" }));
    expect([revised.body, revised.suggestion, revised.suggestedBy]).toEqual(["Invoices revised", true, "Rechnungseingang"]);
  });

  for (const mode of ["lock", "shared"] as const)
    test(`an unchanged human save does not adopt; Gustav can revise an untouched suggestion (${mode})`, async () => {
      let draft = await suggest();
      await sql`UPDATE mail.drafts SET edit_mode = ${mode} WHERE id = ${draft.id}::uuid`;
      draft = unwrap(await save(draft, owner, {}));
      expect(draft.suggestion).toBeTrue();
      draft = unwrap(await save(draft, gustav, { body: "Revised suggestion" }));
      expect(draft.suggestion).toBeTrue();
      expect(draft.createdBy.kind).toBe("service_account");
      expect(await adoption(draft.id)).toBeNull();
    });

  const changes: [string, () => Partial<DraftEditableContent>][] = [
    ["body", () => ({ body: "Human body" })],
    ["subject", () => ({ subject: "Human subject" })],
    ["To", () => ({ to: [{ address: "new@example.test" }] })],
    ["Cc", () => ({ cc: [{ address: "copy@example.test" }] })],
    ["Bcc", () => ({ bcc: [{ address: "private@example.test" }] })],
    ["sender", () => ({ senderIdentityId: secondIdentityId })],
    ["signature", () => ({ signatureTemplateId: signatureId })],
    ["format", () => ({ format: "markdown" })],
    ["priority", () => ({ priority: "high" })],
    ["receipt", () => ({ requestReadReceipt: true })],
  ];
  for (const [field, patch] of changes)
    test(`human ${field} changes adopt permanently and reject automatic replacement`, async () => {
      let draft = unwrap(await save(await suggest(), owner, patch()));
      expect(draft.suggestion).toBeFalse();
      const first = await adoption(draft.id);
      expect(first).not.toBeNull();
      refused(await save(draft, gustav, { body: "Must not replace" }));
      draft = unwrap(await save(draft, delegated, { body: "Requested in chat" }));
      expect(draft.createdBy.kind).toBe("service_account");
      expect(draft.lastEditedBy.kind).toBe("service_account");
      expect(draft.suggestion).toBeFalse();
      expect(await adoption(draft.id)).toBe(first);
    });

  for (const mode of ["lock", "shared"] as const) {
    test(`delegated first content edits adopt in ${mode} mode`, async () => {
      for (const [, patch] of changes) {
        let draft = await suggest();
        await sql`UPDATE mail.drafts SET edit_mode = ${mode} WHERE id = ${draft.id}::uuid`;
        expect(await adoption(draft.id)).toBeNull();
        draft = unwrap(await save(draft, delegated, {}));
        expect(draft.suggestion).toBeTrue();
        draft = unwrap(await save(draft, delegated, patch()));
        expect(draft.suggestion).toBeFalse();
        expect(await adoption(draft.id)).not.toBeNull();
        refused(await save(draft, gustav, { body: "Automatic replacement" }));
      }
    });

    test(`delegated first attachment add and removal adopt in ${mode} mode`, async () => {
      const suggestion = async () => {
        const draft = await suggest();
        await sql`UPDATE mail.drafts SET edit_mode = ${mode} WHERE id = ${draft.id}::uuid`;
        return draft;
      };
      const added = unwrap(await attach(await suggestion(), delegated));
      expect(added.suggestion).toBeFalse();
      expect(await adoption(added.id)).not.toBeNull();
      refused(await save(added, gustav, { body: "Automatic replacement" }));
      const untouched = unwrap(await attach(await suggestion(), gustav));
      expect(untouched.suggestion).toBeTrue();
      expect(await adoption(untouched.id)).toBeNull();
      const removed = unwrap(
        await drafts.removeDraftAttachment({
          context: delegated,
          mailboxId,
          draftId: untouched.id,
          attachmentId: untouched.attachments[0]!.id,
          expectedRevision: untouched.revision,
        }),
      );
      expect(removed.suggestion).toBeFalse();
      expect(await adoption(removed.id)).not.toBeNull();
      refused(await attach(removed, gustav));
    });
  }

  for (const editor of ["person", "delegated"] as const)
    test(`human patch uses the same adoption guard and capability errors remain normal errors (${editor})`, async () => {
      const human = editor === "person" ? owner : delegated;
      const draft = await suggest();
      const id = await publicDraftId(draft.id);
      const patch = mailCapabilities.actions!["draft.patch"]!;
      unwrap(
        await patch.run(
          { mailboxId: mailboxShortId, draftId: id, expectedRevision: draft.revision, patch: { subject: "Human patch" } },
          capability(human),
        ),
      );
      const current = unwrap(await drafts.getDraft(owner, mailboxId, draft.id));
      expect(current.suggestion).toBeFalse();
      const result = await patch.run(
        { mailboxId: mailboxShortId, draftId: id, expectedRevision: current.revision, patch: { body: "Automatic patch" } },
        capability(gustav),
      );
      refused(result);
    });

  test("attachment add and removal adopt and reject autonomous changes, including an upload started before adoption", async () => {
    let added = unwrap(await attach(await suggest()));
    expect(added.suggestion).toBeFalse();
    refused(await attach(added, gustav));
    refused(
      await drafts.removeDraftAttachment({
        context: gustav,
        mailboxId,
        draftId: added.id,
        attachmentId: added.attachments[0]!.id,
        expectedRevision: added.revision,
      }),
    );
    let untouched = unwrap(await attach(await suggest(), gustav));
    expect(untouched.suggestion).toBeTrue();
    const pending = unwrap(
      await uploads.createDraftAttachmentUpload({
        context: gustav,
        mailboxId,
        draftId: untouched.id,
        input: { filename: "pending.txt", contentType: "text/plain", byteLength: 0 },
      }),
    );
    untouched = unwrap(
      await drafts.removeDraftAttachment({
        context: owner,
        mailboxId,
        draftId: untouched.id,
        attachmentId: untouched.attachments[0]!.id,
        expectedRevision: untouched.revision,
      }),
    );
    expect(untouched.suggestion).toBeFalse();
    refused(
      await uploads.finalizeDraftAttachmentUpload({
        context: gustav,
        mailboxId,
        draftId: untouched.id,
        uploadId: pending.id,
        expectedRevision: untouched.revision,
      }),
    );
    added = unwrap(await drafts.getDraft(owner, mailboxId, added.id));
    expect(added.attachments).toHaveLength(1);
  });

  for (const editor of ["person", "delegated"] as const)
    test(`recovery restoration adopts under the draft lock (${editor})`, async () => {
      const human = editor === "person" ? owner : delegated;
      const draft = await suggest();
      const content = { ...editable(draft), body: "Recovered human text" };
      const [copy] = await sql<{ id: string }[]>`INSERT INTO mail.draft_recovery_copies
      (draft_id, base_revision, content, content_hash, creator_kind, creator_id)
      VALUES (${draft.id}::uuid, ${draft.revision}, ${content}::jsonb, ${await sha256Json(content)}, 'user', ${userId}::uuid) RETURNING id`;
      const lease = unwrap(await acquireDraftLease({ context: human, mailboxId, draftId: draft.id }));
      try {
        const restored = unwrap(
          await drafts.restoreDraftRecoveryCopy({
            context: human,
            mailboxId,
            draftId: draft.id,
            expectedRevision: draft.revision,
            recoveryCopyId: copy!.id,
            leaseToken: lease.token,
          }),
        );
        expect(restored.body).toBe(content.body);
        expect(restored.suggestion).toBeFalse();
      } finally {
        unwrap(await releaseDraftLease({ context: human, mailboxId, draftId: draft.id, token: lease.token }));
      }
    });

  for (const mode of ["lock", "shared"] as const)
    test(`delegated attachment-only recovery adopts in ${mode} mode`, async () => {
      const draft = unwrap(await attach(await suggest(), gustav));
      await sql`UPDATE mail.drafts SET edit_mode = ${mode} WHERE id = ${draft.id}::uuid`;
      if (mode === "shared") unwrap(await readDraftDocument({ context: delegated, mailboxId, draftId: draft.id }));
      const content = editable(draft);
      const [copy] = await sql<{ id: string }[]>`INSERT INTO mail.draft_recovery_copies
        (draft_id, base_revision, content, content_hash, creator_kind, creator_id, has_attachment_snapshot)
        VALUES (${draft.id}::uuid, ${draft.revision}, ${content}::jsonb, ${await sha256Json(content)},
          'user', ${userId}::uuid, true) RETURNING id`;
      const lease = mode === "lock" ? unwrap(await acquireDraftLease({ context: delegated, mailboxId, draftId: draft.id })) : null;
      let restored: MailDraft;
      try {
        restored = unwrap(
          await drafts.restoreDraftRecoveryCopy({
            context: delegated,
            mailboxId,
            draftId: draft.id,
            expectedRevision: draft.revision,
            recoveryCopyId: copy!.id,
            leaseToken: lease?.token,
          }),
        );
        expect(restored.body).toBe(draft.body);
        expect(restored.attachments).toHaveLength(0);
        expect(restored.suggestion).toBeFalse();
        expect(await adoption(draft.id)).not.toBeNull();
      } finally {
        if (lease) unwrap(await releaseDraftLease({ context: delegated, mailboxId, draftId: draft.id, token: lease.token }));
      }
      refused(await save(restored, gustav, { body: "Automatic replacement" }));
    });

  for (const editor of ["person", "delegated"] as const)
    test(`calendar invitation attachments adopt through the composer path (${editor})`, async () => {
      const human = editor === "person" ? owner : delegated;
      const draft = await suggest();
      const deliveryId = crypto.randomUUID();
      const prepare = spyOn(integrations, "prepareEventInvitation").mockResolvedValue({
        ok: true,
        data: {
          deliveryId,
          itemId: "Event1",
          mailboxId: mailboxShortId,
          draftId: await publicDraftId(draft.id),
          sequence: 0,
          filename: "invitation.ics",
          contentType: "text/calendar; method=REQUEST",
          calendar: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        },
      });
      const commit = spyOn(integrations, "commitEventInvitation").mockResolvedValue({
        ok: true,
        data: {
          deliveryId,
          itemId: "Event1",
          draftId: await publicDraftId(draft.id),
          state: "drafted",
        },
      });
      try {
        const saved = unwrap(
          await attachEventInvitation({
            context: human,
            mailboxId,
            draftId: draft.id,
            itemId: "Event1",
            idempotencyKey: crypto.randomUUID(),
            request: {},
          }),
        );
        expect(saved.suggestion).toBeFalse();
        expect(saved.attachments).toHaveLength(1);
      } finally {
        prepare.mockRestore();
        commit.mockRestore();
      }
    });

  test("concurrent create keys return one suggestion and retries retain their draft after adoption", async () => {
    const thread = await conversation();
    const origin = { kind: "compose" as const, input: input(thread) };
    const request = (key: string) => ({ idempotencyKey: key, origin, draft: editableInput(origin.input) });
    const keys = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.all(keys.map((key) => drafts.materializeDraftSeed({ context: gustav, mailboxId, input: request(key) })));
    const draftsCreated = results.map(unwrap);
    expect(new Set(draftsCreated.map((draft) => draft.id)).size).toBe(1);
    const first = draftsCreated[0]!;
    const listed = unwrap(await drafts.listConversationDrafts({ context: owner, mailboxId, conversationId: thread.id }));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.suggestion).toBeTrue();
    expect(unwrap(await drafts.getDraft(owner, mailboxId, first.id)).suggestion).toBeTrue();
    unwrap(await save(first, owner, { body: "Adopted content" }));
    const second = unwrap(await drafts.materializeDraftSeed({ context: gustav, mailboxId, input: request(crypto.randomUUID()) }));
    expect(second.id).not.toBe(first.id);
    for (const key of keys) {
      const retry = unwrap(await drafts.materializeDraftSeed({ context: gustav, mailboxId, input: request(key) }));
      expect(retry.id).toBe(first.id);
      expect(retry.body).toBe("Adopted content");
    }
    const conflicting = await drafts.materializeDraftSeed({
      context: gustav,
      mailboxId,
      input: { ...request(keys[1]!), origin: { ...origin, input: { ...origin.input, body: "Different request" } } },
    });
    expect(conflicting.ok).toBeFalse();
    expect(
      unwrap(await drafts.listConversationDrafts({ context: owner, mailboxId, conversationId: thread.id }))
        .map((draft) => draft.suggestion)
        .sort(),
    ).toEqual([false, true]);
    const [stored] = await sql<
      { origin: string; author_kind: string }[]
    >`SELECT origin, author_kind FROM mail.drafts WHERE id = ${second.id}::uuid`;
    expect(stored).toEqual({ origin: "user", author_kind: "service_account" });
    // The database constraint also rejects bypasses of the transactional creation path.
    await expect(sql`UPDATE mail.drafts SET adopted_at = NULL WHERE id = ${first.id}::uuid`.execute()).rejects.toThrow();
  });

  test("a pending send keeps its suggestion slot so undo can restore the draft", async () => {
    const thread = await conversation();
    const request = { context: gustav, mailboxId, input: input(thread) };
    const draft = unwrap(await drafts.createDraft(request));
    await sql`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${draft.id}::uuid`;
    const repeated = unwrap(await drafts.createDraft(request));
    expect(repeated.id).toBe(draft.id);
    expect(repeated.state).toBe("scheduled");
    expect(await adoption(draft.id)).toBeNull();
    // Undo restores the original draft without colliding with a newer suggestion.
    await sql`UPDATE mail.drafts SET state = 'draft' WHERE id = ${draft.id}::uuid`;
    expect(unwrap(await drafts.listConversationDrafts({ context: owner, mailboxId, conversationId: thread.id }))).toHaveLength(1);
  });

  test("merging conversations preserves both suggestions and returns a recoverable conflict", async () => {
    const first = await suggest();
    const second = await suggest();
    // Pending sends also reserve their suggestion slot until Undo is no longer possible.
    await sql`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${second.id}::uuid`;
    const revisions = await sql<{ id: string; revision: number }[]>`SELECT id, revision FROM mail.conversations
      WHERE id IN (${first.conversationId}::uuid, ${second.conversationId}::uuid)`;
    const merged = await mergeConversations({
      context: owner,
      mailboxId,
      targetConversationId: first.conversationId!,
      input: {
        sourceConversationId: second.conversationId!,
        expectedTargetRevision: Number(revisions.find((row) => row.id === first.conversationId)!.revision),
        expectedSourceRevision: Number(revisions.find((row) => row.id === second.conversationId)!.revision),
        confirm: true,
      },
    });
    expect(merged.ok).toBeFalse();
    if (!merged.ok) {
      expect(merged.error.code).toBe("DRAFT_SUGGESTION_CONFLICT");
      expect(merged.error.status).toBe(409);
    }
    for (const original of [first, second]) {
      const retained = unwrap(await drafts.getDraft(owner, mailboxId, original.id));
      expect(retained.conversationId).toBe(original.conversationId);
      expect(retained.body).toBe(original.body);
      expect(retained.suggestion).toBeTrue();
      expect(
        unwrap(await drafts.listConversationDrafts({ context: owner, mailboxId, conversationId: original.conversationId! })),
      ).toHaveLength(original.id === first.id ? 1 : 0);
      const [conversation] = await sql<{ id: string }[]>`SELECT id FROM mail.conversations WHERE id = ${original.conversationId}::uuid`;
      expect(conversation?.id).toBe(original.conversationId!);
    }
  });

  test("service-account offline recovery keeps its content beside a newer suggestion", async () => {
    const draft = await suggest();
    await sql`UPDATE mail.drafts SET edit_mode = 'shared' WHERE id = ${draft.id}::uuid`;
    const initial = unwrap(await readDraftDocument({ context: owner, mailboxId, draftId: draft.id }));
    const update = await createDraftRevisionUpdate(
      initial.fresh.state,
      { ...initial.fresh.content, body: "Offline recovered content" },
      { deadline: Date.now() + 10_000 },
    );
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, initial.fresh.state);
      Y.applyUpdate(doc, update);
      unwrap(await drafts.discardDraft({ context: owner, mailboxId, draftId: draft.id, expectedRevision: draft.revision }));
      const thread = { id: draft.conversationId!, shortId: "unused", messageId: draft.sourceMessageId! };
      const newer = unwrap(await drafts.createDraft({ context: gustav, mailboxId, input: input(thread, "New suggestion") }));
      const recovery = {
        context: gustav,
        mailboxId,
        draftId: draft.id,
        generation: initial.generation,
        clientId: crypto.randomUUID(),
        state: Y.encodeStateAsUpdate(doc),
      };
      const recovered = unwrap(await drafts.recoverDraftDocumentRest(recovery));
      expect(recovered.status).toBe("recovered");
      if (recovered.status !== "recovered") throw new Error("Expected a distinct recovery draft");
      expect(recovered.draft.id).not.toBe(newer.id);
      expect(recovered.draft.suggestion).toBeFalse();
      expect(recovered.draft.body).toBe("Offline recovered content");
      expect(unwrap(await drafts.getDraft(owner, mailboxId, newer.id)).body).toBe("New suggestion");
      const retry = unwrap(await drafts.recoverDraftDocumentRest(recovery));
      expect(retry.status).toBe("recovered");
      if (retry.status === "recovered") expect(retry.draft.id).toBe(recovered.draft.id);
    } finally {
      doc.destroy();
    }
  });

  test("a second capability creation returns the suggestion without appending its inline attachment", async () => {
    const thread = await conversation();
    const [sender] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.sender_identities WHERE id = ${identityId}::uuid`;
    const [source] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.message_contents WHERE id = ${thread.messageId}::uuid`;
    const action = mailCapabilities.actions["draft.create"];
    const create = (body: string, filename: string, idempotencyKey: string) =>
      action.run(
        action.input.parse({
          mailboxId: mailboxShortId,
          senderIdentityId: sender!.short_id,
          signatureTemplateId: null,
          conversationId: thread.shortId,
          sourceMessageId: source!.short_id,
          intent: "reply",
          body,
          attachments: [{ filename, contentType: "text/plain", base64: Buffer.from(filename).toString("base64") }],
        }),
        { ...capability(gustav), idempotencyKey },
      );
    const first = unwrap(await create("Original", "first.txt", "original-attachment"));
    const second = unwrap(await create("Different", "second.txt", "duplicate-attachment"));
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.attachments.map((attachment) => attachment.filename)).toEqual(["first.txt"]);
    const [stored] = await sql<{ id: string }[]>`SELECT id FROM mail.drafts WHERE short_id = ${first.data.id}`;
    const adopted = unwrap(await save(unwrap(await drafts.getDraft(owner, mailboxId, stored!.id)), owner, { body: "Adopted" }));
    const retry = unwrap(await create("Different", "second.txt", "duplicate-attachment"));
    expect(retry.data.id).toBe(first.data.id);
    expect(unwrap(await drafts.getDraft(owner, mailboxId, adopted.id)).body).toBe("Adopted");
  });

  const editableInput = (value: ReturnType<typeof input>) => editable(value);

  for (const editor of ["person", "delegated"] as const)
    test(`shared admission adopts; service projection alone and no-op human input do not adopt (${editor})`, async () => {
      const human = editor === "person" ? owner : delegated;
      const draft = await suggest();
      await sql`UPDATE mail.drafts SET edit_mode = 'shared' WHERE id = ${draft.id}::uuid`;
      const initial = unwrap(await readDraftDocument({ context: human, mailboxId, draftId: draft.id }));
      expect(await adoption(draft.id)).toBeNull();
      const noOp = await acceptDraftDocumentUpdate({
        context: human,
        mailboxId,
        draftId: draft.id,
        generation: initial.generation,
        baseCursor: initial.fresh.cursor,
        update: new Uint8Array([0, 0]),
      });
      unwrap(noOp);
      expect(await adoption(draft.id)).toBeNull();
      const current = unwrap(await readDraftDocument({ context: human, mailboxId, draftId: draft.id }));
      const update = await createDraftRevisionUpdate(
        current.fresh.state,
        { ...current.fresh.content, subject: "Human shared subject" },
        { deadline: Date.now() + 10_000 },
      );
      const accepted = unwrap(
        await acceptDraftDocumentUpdate({
          context: human,
          mailboxId,
          draftId: draft.id,
          generation: current.generation,
          baseCursor: current.fresh.cursor,
          update,
        }),
      );
      expect(accepted.status).toBe("accepted");
      expect(await adoption(draft.id)).not.toBeNull();
      const saved = unwrap(await drafts.getDraft(owner, mailboxId, draft.id));
      refused(await save(saved, gustav, { body: "Autonomous shared update" }));
      const rejected = await acceptDraftDocumentUpdate({
        context: gustav,
        mailboxId,
        draftId: draft.id,
        generation: current.generation,
        baseCursor: current.fresh.cursor,
        update,
      });
      refused(rejected);
    });

  for (const editor of ["person", "delegated"] as const)
    test(`shared table actions adopt human input and refuse autonomous table changes (${editor})`, async () => {
      const human = editor === "person" ? owner : delegated;
      const draft = await suggest("| Item | Cost |\n| --- | --- |\n| Paper | 4 |\n");
      await sql`UPDATE mail.drafts SET edit_mode = 'shared', body_format = 'markdown' WHERE id = ${draft.id}::uuid`;
      const initial = unwrap(await readDraftDocument({ context: human, mailboxId, draftId: draft.id }));
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, initial.fresh.state);
        const text = doc.getText(SHARED_TEXT_NAME);
        const table = findTables(text.toString())[0]!;
        const intent = captureTableAction(text, "rowBelow", {
          tableFrom: table.from,
          rowFrom: gridLine(table, 1)!.from,
          columnFrom: table.lines[0]!.cells[0]!.from,
          row: 1,
          column: 0,
        });
        const target = { mailboxId, draftId: draft.id, generation: initial.generation, actionId: crypto.randomUUID(), intent };
        const result = unwrap(await applyDraftTableAction({ ...target, context: human }));
        expect(result.persisted).toBeTrue();
        expect(unwrap(await drafts.getDraft(owner, mailboxId, draft.id)).suggestion).toBeFalse();
        refused(await applyDraftTableAction({ ...target, actionId: crypto.randomUUID(), context: gustav }));
      } finally {
        doc.destroy();
      }
    });

  for (const editor of ["person", "delegated"] as const)
    test(`published human input survives SQL rollback and service projection recovers adoption (${editor})`, async () => {
      const human = editor === "person" ? owner : delegated;
      const draft = await suggest();
      await sql`UPDATE mail.drafts SET edit_mode = 'shared' WHERE id = ${draft.id}::uuid`;
      const initial = unwrap(await readDraftDocument({ context: human, mailboxId, draftId: draft.id }));
      const update = await createDraftRevisionUpdate(
        initial.fresh.state,
        { ...initial.fresh.content, body: "Retained human text" },
        { deadline: Date.now() + 10_000 },
      );
      await expect(
        sql.begin(async (db) => {
          const locked = unwrap(await lockDraftDocumentInTransaction({ context: human, db, mailboxId, draftId: draft.id }));
          unwrap(await locked.accept({ generation: initial.generation, baseCursor: initial.fresh.cursor, update }));
          throw new Error("Simulated commit failure");
        }),
      ).rejects.toThrow("Simulated commit failure");
      expect(await adoption(draft.id)).toBeNull();
      // An autonomous mutation must discover retained human edits before either merge or replacement.
      refused(await save(draft, gustav, { body: "Must never replace retained input" }));
      expect(await adoption(draft.id)).not.toBeNull();
      unwrap(
        await sql.begin(async (db) => {
          const locked = unwrap(await lockDraftDocumentInTransaction({ context: gustav, db, mailboxId, draftId: draft.id }));
          return locked.project();
        }),
      );
      const projected = unwrap(await drafts.getDraft(owner, mailboxId, draft.id));
      expect(projected.body).toBe("Retained human text");
      expect(projected.suggestion).toBeFalse();
      expect(projected.lastEditedBy.kind).toBe("service_account");
    });
});
