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
import { forwardMessageBody, quoteReplyBody } from "../compose-quotation";
import { type DraftContentInput, draftSchema, type MailDraft } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { readDraftDocument } from "./draft-documents";
import { acquireDraftLease, heartbeatDraftLease } from "./draft-leases";
import { finishReplyDraftRetirements } from "./draft-retirement";
import { loadDraftSourceQuote } from "./draft-source-quote";
import { uploadDraftAttachmentStream } from "./draft-uploads";
import * as drafts from "./drafts";
import { createMailbox } from "./mailboxes";

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
    target: { type: "mail.mailbox", id: mailboxShortId },
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
  const editable = (draft: MailDraft) => ({
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

  const legacySuggestion = async (draft: MailDraft, state = "draft") => {
    const [copy] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id, author_kind, author_id,
        last_editor_kind, last_editor_id, body_markdown, state, created_at, content_edited_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${draft.conversationId}::uuid, ${draft.sourceMessageId}::uuid, 'reply',
        ${identityId}::uuid, 'service_account', ${accountId}::uuid, 'service_account', ${accountId}::uuid,
        'Newer untouched suggestion', ${state}, '2026-12-01', '2026-12-01') RETURNING id, short_id`;
    return copy!;
  };
  const beginLegacyMigration = async () => {
    await sql`DROP INDEX IF EXISTS mail.drafts_one_open_reply_idx`.simple();
    await sql`DELETE FROM mail.schema_migrations WHERE version = 4`;
    // 0.74 had no rule retirement either: no marker 5 and none of its admission fences.
    await sql`DELETE FROM mail.schema_migrations WHERE version = 5 AND name = 'rules_retired'`;
    await sql`DROP TRIGGER IF EXISTS mail_rules_retired_event ON workflows.event`;
    await sql`DROP TRIGGER IF EXISTS mail_rules_retired_run ON workflows.run`;
    await sql`DROP TRIGGER IF EXISTS mail_rules_retired_replay ON workflows.run`;
    await sql`DROP TRIGGER IF EXISTS mail_rules_retired_command ON mail.commands`;
    await sql`DROP TRIGGER IF EXISTS mail_rules_retired_draft ON mail.drafts`;
    await sql`DROP TRIGGER IF EXISTS mail_rules_retired_outbox ON mail.outbox_submissions`;
  };
  let bindingId: string;
  const submission = async (draftId: string, state: string) => {
    const [command] = await sql<{ id: string }[]>`INSERT INTO mail.commands
      (mailbox_id, kind, state, actor_kind, access_subject_kind, idempotency_key, request_hash, target, payload)
      VALUES (${mailboxId}::uuid, 'send', ${["scheduled", "undo_window"].includes(state) ? "queued" : "failed"},
        'system', 'system', ${crypto.randomUUID()}, ${"a".repeat(64)}, '{}', '{}') RETURNING id`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.outbox_submissions
      (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id, state,
        requested_at, mime_date, scheduled_at, draft_snapshot)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${draftId}::uuid, ${command!.id}::uuid,
        ${identityId}::uuid, ${bindingId}::uuid, ${crypto.randomUUID()}, ${state}, ${at}, ${at}, ${at}, '{"body":"Historical content"}') RETURNING id`;
    return row!.id;
  };

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
    const [connection] = await sql<{ id: string }[]>`INSERT INTO mail.provider_connections
      (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret)
      VALUES (${mailboxId}::uuid, 'B1 test transport', 'team@example.test', 'team', 'imap.example.test', 993, 'implicit',
        'smtp.example.test', 465, 'implicit', 'password', 'test-only') RETURNING id`;
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint) VALUES (${mailboxId}::uuid, '{}', '{}', ${"b".repeat(64)}) RETURNING id`;
    const [binding] = await sql<{ id: string }[]>`INSERT INTO mail.provider_bindings
      (remote_resource_id, connection_id, remote_locator) VALUES (${resource!.id}::uuid, ${connection!.id}::uuid, '{}') RETURNING id`;
    bindingId = binding!.id;
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
        body: "",
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
      const result = unwrap(await mailCapabilities.actions["draft.create"].run(DraftCreateInputSchema.parse(body), cap()));
      expect(result.data.id).toBe(first.id);
      expect(result.data.creationOutcome).toBe("existing");
      const occupied = await mailCapabilities.actions["draft.create"].run(
        DraftCreateInputSchema.parse({
          ...body,
          attachments: [{ filename: "do-not-add.txt", contentType: "text/plain", base64: "bm8=" }],
        }),
        cap(gustav),
      );
      expect(occupied).toMatchObject({ ok: false, error: { code: "DRAFT_REPLY_BOX_OCCUPIED", status: 409 } });
      if (!occupied.ok) {
        expect(occupied.error.message).toContain(first.id);
        expect(occupied.error.message).toContain("mail.draft.intent");
        expect(occupied.error.message).not.toContain("cld mail");
      }
      const contentConflict = await api.request(`/mailboxes/${mailboxShortId}/drafts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, body: "Keep my new text" }),
      });
      expect(contentConflict.status).toBe(409);
      const conflictBody = await contentConflict.json();
      expect(conflictBody.message).not.toContain("cld mail");
      expect(conflictBody).toMatchObject({
        code: "DRAFT_REPLY_BOX_OCCUPIED",
        draftId: first.id,
        message: expect.stringContaining(first.id),
      });
      for (const supplied of [{ body: "New text" }, { subject: "New subject" }, { to: [{ address: "new@example.test" }] }]) {
        const conflict = await mailCapabilities.actions["draft.create"].run(DraftCreateInputSchema.parse({ ...body, ...supplied }), cap());
        expect(conflict).toMatchObject({ ok: false, error: { code: "DRAFT_REPLY_BOX_OCCUPIED", status: 409 } });
      }
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
  for (const mode of ["lock", "shared"] as const) {
    test(`REST materialization rejects different seed content without touching the occupant (${mode})`, async () => {
      const source = await thread();
      const occupant = unwrap(await drafts.createDraft({ context: owner, mailboxId, input: input(source) }));
      await sql`UPDATE mail.drafts SET edit_mode = ${mode} WHERE id = ${occupant.id}::uuid`;
      if (owner.actor.kind !== "user") throw new Error("Missing user");
      const token = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
        kind: "user",
        payload: {},
        user: owner.actor.user,
        scopes: ["read", "write"],
      });
      try {
        const headers = { authorization: "Bearer b1", "content-type": "application/json" };
        const response = await api.request(`/mailboxes/${mailboxShortId}/draft-seeds`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            origin: {
              kind: "compose",
              input: {
                ...input(source),
                conversationId: source.conversationShortId,
                sourceMessageId: source.sourceShortId,
                senderIdentityId: identityShortId,
              },
            },
          }),
        });
        expect(response.status).toBe(200);
        const seed = await response.json();
        const materialize = (body: string) =>
          api.request(`/mailboxes/${mailboxShortId}/draft-seeds/materialize`, {
            method: "POST",
            headers,
            body: JSON.stringify({ idempotencyKey: seed.id, origin: seed.origin, draft: { ...seed.content, body } }),
          });
        const [publicOccupant] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.drafts WHERE id = ${occupant.id}::uuid`;
        const conflict = await materialize("Local recovery text");
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: "DRAFT_REPLY_BOX_OCCUPIED", draftId: publicOccupant!.short_id });
        expect(unwrap(await drafts.getDraft(owner, mailboxId, occupant.id)).body).toBe("My text");
        const same = await materialize("My text");
        expect(same.status).toBe(200);
        expect(await same.json()).toMatchObject({ creationOutcome: "existing", body: "My text" });
        const retry = await materialize("Later local text");
        expect(retry.status).toBe(409);
      } finally {
        token.mockRestore();
      }
    });
  }
  for (const kind of ["reply", "new", "derive"] as const) {
    test(`REST own-key retry after a lost response allows the later save (${kind})`, async () => {
      const source = await thread();
      if (owner.actor.kind !== "user") throw new Error("Missing user");
      const token = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
        kind: "user",
        payload: {},
        user: owner.actor.user,
        scopes: ["read", "write"],
      });
      try {
        const headers = { authorization: "Bearer b1", "content-type": "application/json" };
        const origin =
          kind === "derive"
            ? {
                kind: "derive",
                messageId: source.sourceShortId,
                input: { kind: "edit_as_new", senderIdentityId: identityShortId, includeAttachments: false },
              }
            : {
                kind: "compose",
                input: {
                  ...input(source),
                  senderIdentityId: identityShortId,
                  body: "",
                  intent: kind,
                  conversationId: kind === "reply" ? source.conversationShortId : null,
                  sourceMessageId: kind === "reply" ? source.sourceShortId : null,
                },
              };
        const prepared = await api.request(`/mailboxes/${mailboxShortId}/draft-seeds`, {
          method: "POST",
          headers,
          body: JSON.stringify({ origin }),
        });
        expect(prepared.status).toBe(200);
        const seed = await prepared.json();
        const materialize = (body: string) =>
          api.request(`/mailboxes/${mailboxShortId}/draft-seeds/materialize`, {
            method: "POST",
            headers,
            body: JSON.stringify({ idempotencyKey: seed.id, origin: seed.origin, draft: { ...seed.content, body } }),
          });
        // The first response is lost to the editor. Its request already committed.
        const first = draftSchema.parse(await (await materialize("First text")).json());
        const retry = await materialize("Later text");
        expect(retry.status).toBe(200);
        const retried = draftSchema.parse(await retry.json());
        expect(retried.id).toBe(first.id);
        expect(retried.creationOutcome).toBeUndefined();
        expect(retried.body).toBe("First text");
        const saved = await api.request(`/mailboxes/${mailboxShortId}/drafts/${retried.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ expectedRevision: retried.revision, draft: { ...editable(retried), body: "Later text" } }),
        });
        expect(saved.status).toBe(200);
        expect(draftSchema.parse(await saved.json())).toMatchObject({ id: first.id, body: "Later text", revision: first.revision + 1 });
      } finally {
        token.mockRestore();
      }
    });
  }
  test("REST signatures do not make an own retry or equal foreign seed conflict", async () => {
    const source = await thread();
    const [signature] = await sql<{ id: string }[]>`INSERT INTO mail.compose_templates
      (short_id, mailbox_id, kind, scope, name, normalized_name, shortcut, body_template, created_by_actor_kind, created_by_actor_id)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'signature', 'mailbox', 'Default', 'default', 'default',
        'Best wishes, Ada', 'user', ${userId}::uuid) RETURNING id`;
    await sql`INSERT INTO mail.compose_signature_defaults (mailbox_id, sender_identity_id, template_id)
      VALUES (${mailboxId}::uuid, ${identityId}::uuid, ${signature!.id}::uuid)`;
    if (owner.actor.kind !== "user") throw new Error("Missing user");
    const token = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
      kind: "user",
      payload: {},
      user: owner.actor.user,
      scopes: ["read", "write"],
    });
    try {
      const headers = { authorization: "Bearer b1", "content-type": "application/json" };
      const prepared = await api.request(`/mailboxes/${mailboxShortId}/draft-seeds`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          origin: {
            kind: "compose",
            input: {
              ...input(source),
              senderIdentityId: identityShortId,
              conversationId: source.conversationShortId,
              sourceMessageId: source.sourceShortId,
            },
          },
        }),
      });
      expect(prepared.status).toBe(200);
      const seed = await prepared.json();
      const materialize = (key: string) =>
        api.request(`/mailboxes/${mailboxShortId}/draft-seeds/materialize`, {
          method: "POST",
          headers,
          body: JSON.stringify({ idempotencyKey: key, origin: seed.origin, draft: seed.content }),
        });
      const created = draftSchema.parse(await (await materialize(seed.id)).json());
      expect(created.signatureTemplateId).not.toBeNull();
      // Older images kept the signature in the body. A different seed with the same editable text may reuse it.
      await sql`UPDATE mail.drafts SET body_markdown = ${"My text\n\n\u2063Best wishes, Ada\u2064"}
        WHERE short_id = ${created.id}`;
      const retry = await materialize(seed.id);
      expect(retry.status).toBe(200);
      expect(draftSchema.parse(await retry.json()).creationOutcome).toBeUndefined();
      const equal = await materialize(crypto.randomUUID());
      expect(equal.status).toBe(200);
      expect(draftSchema.parse(await equal.json())).toMatchObject({ id: created.id, creationOutcome: "existing" });
    } finally {
      token.mockRestore();
      await sql`DELETE FROM mail.compose_signature_defaults WHERE mailbox_id = ${mailboxId}::uuid AND sender_identity_id = ${identityId}::uuid`;
    }
  });
  for (const mode of ["lock", "shared"] as const) {
    test(`mode switch derives recipients, subject and attachments in both directions (${mode})`, async () => {
      let draft = await create();
      await sql`UPDATE mail.drafts SET edit_mode = ${mode} WHERE id = ${draft.id}::uuid`;
      const documentBefore = mode === "shared" ? unwrap(await readDraftDocument({ context: owner, mailboxId, draftId: draft.id })) : null;
      draft = unwrap(await attach(draft));
      draft = unwrap(
        await drafts.updateDraft({
          context: owner,
          mailboxId,
          draftId: draft.id,
          expectedRevision: draft.revision,
          input: { ...editable(draft), bcc: [{ address: "private@example.test" }] },
        }),
      );
      await sql`UPDATE mail.sender_identities SET default_bcc = '[{"address":"audit@example.test"}]' WHERE id = ${identityId}::uuid`;
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
      expect(draft.bcc.map((a) => a.address)).toEqual(["private@example.test", "audit@example.test"]);
      expect(draft.to).toEqual([]);
      expect(draft.cc).toEqual([]);
      expect(draft.attachments.map((a) => a.filename).sort()).toEqual(["personal.txt", "source.txt"]);
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
      await sql`UPDATE mail.sender_identities SET default_bcc = '[]' WHERE id = ${identityId}::uuid`;
    });
    test(`mode switch preserves a user-edited subject (${mode})`, async () => {
      let draft = await create();
      await sql`UPDATE mail.drafts SET edit_mode = ${mode} WHERE id = ${draft.id}::uuid`;
      draft = unwrap(
        await drafts.updateDraft({
          context: owner,
          mailboxId,
          draftId: draft.id,
          expectedRevision: draft.revision,
          input: { ...editable(draft), subject: "Re: My own subject" },
        }),
      );
      const preview = unwrap(
        await drafts.previewDraftIntent({
          context: owner,
          mailboxId,
          draftId: draft.id,
          expectedRevision: draft.revision,
          intent: "forward",
        }),
      );
      expect(preview.subject).toBe("Re: My own subject");
      draft = unwrap(
        await drafts.switchDraftIntent({
          context: owner,
          mailboxId,
          draftId: draft.id,
          expectedRevision: draft.revision,
          intent: "forward",
        }),
      );
      expect(draft.subject).toBe("Re: My own subject");
      draft = unwrap(
        await drafts.switchDraftIntent({
          context: owner,
          mailboxId,
          draftId: draft.id,
          expectedRevision: draft.revision,
          intent: "reply_all",
        }),
      );
      expect(draft.subject).toBe("Re: My own subject");
    });
  }
  test("mode switches recognize UI and localized derived prefixes", async () => {
    for (const subject of [
      "Re: Question",
      "Fwd: Re: Question",
      "RE: Question",
      "Fwd: Question",
      "AW: WG: Question",
      "SV: Antw: RV: re[2]: Question",
      "RE: Foo",
    ]) {
      const source = await thread();
      const core = subject.endsWith("Foo") ? "Foo" : "Question";
      await sql`UPDATE mail.message_contents SET subject = ${core} WHERE id = ${source.sourceMessageId}::uuid`;
      let draft = unwrap(await drafts.createDraft({ context: owner, mailboxId, input: { ...input(source), subject } }));
      expect(draft.subject).toBe(subject);
      for (const intent of ["forward", "reply"] as const) {
        draft = unwrap(
          await drafts.switchDraftIntent({ context: owner, mailboxId, draftId: draft.id, intent, expectedRevision: draft.revision }),
        );
        expect(draft.subject).toBe(`${intent === "forward" ? "Fwd" : "Re"}: ${core}`);
      }
    }
  });
  test("creation preserves caller subjects and copies requested source attachments for reply and reply-all", async () => {
    let first = await create();
    first = unwrap(await attach(first));
    const [part] = await sql<{ id: string }[]>`INSERT INTO mail.message_parts (message_id, part_path, content_type, size_bytes)
      VALUES (${first.sourceMessageId}::uuid, '1', 'text/plain', 4) RETURNING id`;
    await sql`INSERT INTO mail.attachments (short_id, message_id, part_id, blob_id, filename, content_type, size_bytes, checksum)
      SELECT ${newShortId()}, ${first.sourceMessageId}::uuid, ${part!.id}::uuid, blob_id, 'source.txt', content_type, byte_length, content_hash
      FROM mail.draft_attachments WHERE draft_id = ${first.id}::uuid LIMIT 1`;
    unwrap(await drafts.discardDraft({ context: owner, mailboxId, draftId: first.id, expectedRevision: first.revision }));
    for (const intent of ["reply", "reply_all"] as const) {
      const draft = unwrap(
        await drafts.createDraft({
          context: owner,
          mailboxId,
          input: {
            ...input({ conversationId: first.conversationId!, sourceMessageId: first.sourceMessageId! }, intent),
            subject: "Chosen by caller",
            includeSourceAttachments: true,
          },
        }),
      );
      expect(draft.subject).toBe("Chosen by caller");
      expect(draft.attachments.map((a) => a.filename)).toEqual(["source.txt"]);
      let switched = unwrap(
        await drafts.switchDraftIntent({
          context: owner,
          mailboxId,
          draftId: draft.id,
          expectedRevision: draft.revision,
          intent: intent === "reply" ? "reply_all" : "reply",
        }),
      );
      expect(switched.attachments.map((a) => a.filename)).toEqual(["source.txt"]);
      for (const mode of ["forward", "reply"] as const) {
        switched = unwrap(
          await drafts.switchDraftIntent({
            context: owner,
            mailboxId,
            draftId: switched.id,
            expectedRevision: switched.revision,
            intent: mode,
          }),
        );
        expect(switched.attachments).toHaveLength(1);
      }
      unwrap(await drafts.discardDraft({ context: owner, mailboxId, draftId: switched.id, expectedRevision: switched.revision }));
    }
    const legacy = unwrap(
      await drafts.createDraft({
        context: owner,
        mailboxId,
        input: input({ conversationId: first.conversationId!, sourceMessageId: first.sourceMessageId! }, "forward"),
      }),
    );
    await sql`UPDATE mail.draft_attachments SET forwarded_source_message_id = NULL WHERE draft_id = ${legacy.id}::uuid`;
    await beginLegacyMigration();
    await migrate();
    const reply = unwrap(
      await drafts.switchDraftIntent({ context: owner, mailboxId, draftId: legacy.id, expectedRevision: legacy.revision, intent: "reply" }),
    );
    expect(reply.attachments).toHaveLength(0);
    unwrap(await drafts.discardDraft({ context: owner, mailboxId, draftId: reply.id, expectedRevision: reply.revision }));
  });
  test("a retired automatic reply remains outside the person's reply box", async () => {
    const source = await thread();
    const automaticId = crypto.randomUUID();
    // Open automatic replies cannot exist after the rule retirement; its retired draft keeps its row.
    const [automatic] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (id, short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id,
        origin, delivery_class, author_kind, author_id, last_editor_kind, last_editor_id, state, body_markdown)
      VALUES (${automaticId}::uuid, ${newShortId()}, ${mailboxId}::uuid, ${source.conversationId}::uuid,
        ${source.sourceMessageId}::uuid, 'reply', ${identityId}::uuid, 'workflow', 'automatic_reply',
        'workflow', ${crypto.randomUUID()}::uuid, 'workflow', ${crypto.randomUUID()}::uuid, 'discarded', 'Failed automatic reply') RETURNING id`;
    const person = unwrap(await drafts.createDraft({ context: owner, mailboxId, input: input(source) }));
    expect(person.id).not.toBe(automatic!.id);
    expect((await drafts.getDraft(owner, mailboxId, automatic!.id)).ok).toBeFalse();
    const again = unwrap(await drafts.createDraft({ context: owner, mailboxId, input: input(source) }));
    expect(again.id).toBe(person.id);
  });
  test("switching honors another editor's lease and capability revision checks", async () => {
    const draft = await create();
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.drafts WHERE id = ${draft.id}::uuid`;
    const operation = DraftSwitchIntentInputSchema.parse({
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
  for (const pendingState of ["scheduled", "undo_window"]) {
    test(`F6 keeps a draft-state ${pendingState} submission before a newer human duplicate`, async () => {
      const committed = await create();
      const sendId = await submission(committed.id, pendingState);
      await beginLegacyMigration();
      const newer = await legacySuggestion(committed);
      await sql`UPDATE mail.drafts SET author_kind = 'user', author_id = ${userId}::uuid WHERE id = ${newer.id}::uuid`;
      const before = await sql`SELECT * FROM mail.outbox_submissions WHERE id = ${sendId}::uuid`;
      expect(await migrate()).toEqual({ deletedDrafts: 1, affectedConversations: 1, completed: true });
      expect((await sql`SELECT state FROM mail.drafts WHERE id = ${committed.id}::uuid`)[0]?.state).toBe("draft");
      expect((await sql`SELECT state FROM mail.drafts WHERE id = ${newer.id}::uuid`)[0]?.state).toBe("discarded");
      expect(await sql`SELECT * FROM mail.outbox_submissions WHERE id = ${sendId}::uuid`).toEqual(before);
    });
    test(`F6 refuses two draft-state ${pendingState} submissions before its downgrade fence`, async () => {
      const first = await create();
      await beginLegacyMigration();
      const second = await legacySuggestion(first);
      await submission(first.id, pendingState);
      await submission(second.id, pendingState);
      const before = await sql`SELECT id, state, body_markdown FROM mail.drafts
        WHERE conversation_id = ${first.conversationId}::uuid ORDER BY id`;
      await expect(migrate()).rejects.toThrow("2 committed sends. Let them send or cancel them with the previous Mail image");
      expect(await sql`SELECT version FROM mail.schema_migrations WHERE version = 4`).toHaveLength(0);
      // Frozen 0.74 compatibility allowlist, verified against its assertSupportedSchema implementation.
      const history = await sql<{ version: number; name: string }[]>`SELECT version, name FROM mail.schema_migrations ORDER BY version`;
      expect(history).toEqual([
        { version: 1, name: "baseline" },
        { version: 2, name: "principal_assignees" },
        { version: 3, name: "suggestions_per_author" },
      ]);
      expect(
        await sql`SELECT id, state, body_markdown FROM mail.drafts
        WHERE conversation_id = ${first.conversationId}::uuid ORDER BY id`,
      ).toEqual(before);
      await sql`UPDATE mail.outbox_submissions SET state = 'cancelled' WHERE draft_id = ${second.id}::uuid`;
      expect(await migrate()).toMatchObject({ deletedDrafts: 1, completed: true });
    });
  }
  for (const unsafeState of ["sending", "unknown", "needs_attention"]) {
    test(`F6 still refuses a draft-state ${unsafeState} delivery before its marker`, async () => {
      const draft = await create();
      await beginLegacyMigration();
      await legacySuggestion(draft);
      const sendId = await submission(draft.id, unsafeState);
      await expect(migrate()).rejects.toThrow("reconcile in-flight or uncertain deliveries");
      expect(await sql`SELECT version FROM mail.schema_migrations WHERE version = 4`).toHaveLength(0);
      expect(await sql`SELECT id FROM mail.drafts WHERE conversation_id = ${draft.conversationId}::uuid AND state = 'draft'`).toHaveLength(
        2,
      );
      await sql`UPDATE mail.outbox_submissions SET state = 'reconciled_unsent' WHERE id = ${sendId}::uuid`;
      await migrate();
    });
  }
  test("F6 validates legacy nonnegative counts before its marker", async () => {
    const draft = await create();
    await beginLegacyMigration();
    await sql`ALTER TABLE mail.drafts DROP CONSTRAINT drafts_consolidated_count_check`.simple();
    await sql`UPDATE mail.drafts SET consolidated_count = -1 WHERE id = ${draft.id}::uuid`;
    await expect(migrate()).rejects.toThrow("drafts_consolidated_count_check");
    expect(await sql`SELECT version FROM mail.schema_migrations WHERE version = 4`).toHaveLength(0);
    await sql`ALTER TABLE mail.drafts DROP CONSTRAINT drafts_consolidated_count_check`.simple();
    await sql`UPDATE mail.drafts SET consolidated_count = 0 WHERE id = ${draft.id}::uuid`;
    await migrate();
  });
  for (const counter of ["consolidated_count", "revision", "doc_generation"] as const) {
    test(`F6 refuses ${counter} overflow before its marker`, async () => {
      const draft = await create();
      await beginLegacyMigration();
      await legacySuggestion(draft);
      await sql`UPDATE mail.drafts SET ${sql(counter)} = ${counter === "consolidated_count" ? "2147483647" : "9223372036854775807"}
        WHERE id = ${draft.id}::uuid`;
      await expect(migrate()).rejects.toThrow("consolidation counters exceed their storage range");
      expect(await sql`SELECT version FROM mail.schema_migrations WHERE version = 4`).toHaveLength(0);
      await sql`UPDATE mail.drafts SET ${sql(counter)} = ${counter === "consolidated_count" ? 0 : 1} WHERE id = ${draft.id}::uuid`;
      await migrate();
    });
  }
  for (const broken of ["content", "quote"]) {
    test(`F6 retires a loser with broken ${broken} without rendering or parsing it`, async () => {
      const draft = await create();
      await beginLegacyMigration();
      const loser = await legacySuggestion(draft);
      if (broken === "content") {
        // A legacy JSON array can satisfy the database constraint but fail provider-content validation.
        await sql`UPDATE mail.drafts SET to_addresses = '[{"address":"invalid"}]' WHERE id = ${loser.id}::uuid`;
      } else {
        await sql`UPDATE mail.message_contents SET plain_text = repeat('x', 2097153) WHERE id = ${draft.sourceMessageId}::uuid`;
        await sql`UPDATE mail.drafts SET quote_source = true WHERE id = ${loser.id}::uuid`;
        const quote = await loadDraftSourceQuote({
          db: sql,
          mailboxId,
          sourceMessageId: draft.sourceMessageId,
          access: { scope: "mailbox", permission: "read" },
          quoteSource: { locale: "en", timeZone: "UTC" },
        });
        expect(quote.ok).toBeFalse();
      }
      const [snapshot] = await sql<{ id: string }[]>`INSERT INTO mail.draft_provider_snapshots
        (mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id, content_fingerprint, content_snapshot, completed_at)
        VALUES (${mailboxId}::uuid, ${loser.id}::uuid, 1, 'export', 'active', ${crypto.randomUUID()},
          ${"c".repeat(64)}, '{"body":"Legacy remote content"}', ${at}) RETURNING id`;
      expect(await migrate()).toMatchObject({ deletedDrafts: 1, completed: true });
      expect((await sql`SELECT state, body_markdown, to_addresses FROM mail.drafts WHERE id = ${loser.id}::uuid`)[0]).toEqual({
        state: "discarded",
        body_markdown: "",
        to_addresses: [],
      });
      expect(unwrap(await drafts.getDraft(owner, mailboxId, draft.id))).toMatchObject({
        state: "draft",
        body: "My text",
        consolidatedCount: 1,
      });
      expect(
        (await sql`SELECT state, content_snapshot, completed_at FROM mail.draft_provider_snapshots WHERE id = ${snapshot!.id}::uuid`)[0],
      ).toEqual({
        state: "retiring",
        content_snapshot: {},
        completed_at: null,
      });
    });
  }
  test("F6 keeps a scheduled send ahead of a newer suggestion and preserves terminal history", async () => {
    for (const pendingState of ["scheduled", "undo_window"]) {
      const committed = await create();
      await sql`UPDATE mail.drafts SET state = ${pendingState === "scheduled" ? "scheduled" : "sending"} WHERE id = ${committed.id}::uuid`;
      const sendId = await submission(committed.id, pendingState);
      await beginLegacyMigration();
      const suggestion = await legacySuggestion(committed);
      for (const state of ["failed", "reconciled_unsent", "cancelled"]) await submission(suggestion.id, state);
      const before =
        await sql`SELECT * FROM mail.outbox_submissions WHERE draft_id IN (${committed.id}::uuid, ${suggestion.id}::uuid) ORDER BY id`;
      const commands = await sql`SELECT * FROM mail.commands WHERE id IN (SELECT command_id FROM mail.outbox_submissions
      WHERE draft_id IN (${committed.id}::uuid, ${suggestion.id}::uuid)) ORDER BY id`;
      expect(await migrate()).toMatchObject({ deletedDrafts: 1, affectedConversations: 1 });
      expect(unwrap(await drafts.getDraft(owner, mailboxId, committed.id)).state).toBe(
        pendingState === "scheduled" ? "scheduled" : "sending",
      );
      expect(
        await sql`SELECT * FROM mail.outbox_submissions WHERE draft_id IN (${committed.id}::uuid, ${suggestion.id}::uuid) ORDER BY id`,
      ).toEqual(before);
      expect(
        await sql`SELECT * FROM mail.commands WHERE id IN (SELECT command_id FROM mail.outbox_submissions
      WHERE draft_id IN (${committed.id}::uuid, ${suggestion.id}::uuid)) ORDER BY id`,
      ).toEqual(commands);
      expect((await sql`SELECT state FROM mail.outbox_submissions WHERE id = ${sendId}::uuid`)[0]?.state).toBe(pendingState);
    }
  });
  test("F6 keeps human and adopted drafts ahead of a newer untouched suggestion", async () => {
    for (const adopted of [false, true]) {
      const human = await create();
      if (adopted)
        await sql`UPDATE mail.drafts SET author_kind = 'service_account', author_id = ${accountId}::uuid,
      adopted_at = '2026-11-01' WHERE id = ${human.id}::uuid`;
      await sql`UPDATE mail.drafts SET content_edited_at = '2026-11-01' WHERE id = ${human.id}::uuid`;
      await beginLegacyMigration();
      const suggestion = await legacySuggestion(human);
      expect(await migrate()).toMatchObject({ deletedDrafts: 1 });
      expect(unwrap(await drafts.getDraft(owner, mailboxId, human.id)).body).toBe("My text");
      expect((await sql`SELECT state FROM mail.drafts WHERE id = ${suggestion.id}::uuid`)[0]?.state).toBe("discarded");
    }
  });
  for (const evidence of ["timestamp", "legacy revision"] as const) {
    test(`F6 prefers an older edited draft over a newer untouched reply with derived content (${evidence})`, async () => {
      const edited = await create();
      await sql`UPDATE mail.drafts SET edit_mode = 'lock', created_at = '2026-11-01T09:00:00Z',
        content_edited_at = ${evidence === "timestamp" ? "2026-11-01T10:00:00Z" : null}::timestamptz,
        revision = ${evidence === "legacy revision" ? 6 : 1},
        body_markdown = 'Edited text', subject = 'Re: Question', to_addresses = '[{"address":"customer@example.test"}]', cc_addresses = '[]', bcc_addresses = '[]'
        WHERE id = ${edited.id}::uuid`;
      // Historical timestamps are restored separately: the content-update trigger records the fixture write itself.
      await sql`UPDATE mail.drafts SET content_edited_at = ${evidence === "timestamp" ? "2026-11-01T10:00:00Z" : null}::timestamptz WHERE id = ${edited.id}::uuid`;
      await beginLegacyMigration();
      const empty = await legacySuggestion(edited);
      await sql`UPDATE mail.drafts SET author_kind = 'user', author_id = ${userId}::uuid, adopted_at = '2026-11-01T12:00:00Z',
        edit_mode = 'lock', revision = 1, content_edited_at = NULL, created_at = '2026-11-01T11:00:00Z',
        body_markdown = ${"\u2063"} || 'Best wishes, Ada' || ${"\u2064"}, subject = 'Re: Question',
        to_addresses = '[{"address":"customer@example.test"}]', cc_addresses = '[]', bcc_addresses = '[]'
        WHERE id = ${empty.id}::uuid`;
      await sql`UPDATE mail.drafts SET content_edited_at = NULL WHERE id = ${empty.id}::uuid`;
      expect(await migrate()).toMatchObject({ deletedDrafts: 1 });
      expect(unwrap(await drafts.getDraft(owner, mailboxId, edited.id)).state).toBe("draft");
      expect((await sql`SELECT state FROM mail.drafts WHERE id = ${empty.id}::uuid`)[0]?.state).toBe("discarded");
    });
  }
  for (const fixture of [
    "separate",
    "embedded reply",
    "embedded forward",
    "legacy German reply",
    "edited signature",
    "archived signature",
    "service-account signature",
  ] as const) {
    for (const scenario of ["older text", "both untouched", "signature only"] as const) {
      test(`F6 recognizes revision-1 body evidence (${scenario}, ${fixture})`, async () => {
        const source = await thread();
        const signatureName = `F6 ${scenario} ${fixture}`;
        const serviceAccount = fixture === "service-account signature";
        const signatureBody = serviceAccount ? "Private wishes, Ada" : "Best wishes, Ada";
        const [signature] = await sql<{ id: string }[]>`INSERT INTO mail.compose_templates
          (short_id, mailbox_id, kind, scope, owner_user_id, name, normalized_name, shortcut, body_template, created_by_actor_kind, created_by_actor_id)
          VALUES (${newShortId()}, ${mailboxId}::uuid, 'signature', ${serviceAccount ? "private" : "mailbox"},
            ${serviceAccount ? userId : null}::uuid, ${signatureName}, ${signatureName.toLowerCase()}, ${`f6_${newShortId().toLowerCase()}`},
            ${signatureBody}, 'user', ${userId}::uuid) RETURNING id`;
        const message = {
          from: [{ address: "customer@example.test" }],
          to: [{ address: "team@example.test" }],
          subject: "Question",
          internalDate: at,
          plainText: "Source",
        };
        const dateContext = { locale: fixture === "legacy German reply" ? "de" : "en", timeZone: "UTC" };
        const history =
          fixture === "embedded reply" || fixture === "legacy German reply"
            ? quoteReplyBody(message, "Source", dateContext)
            : fixture === "embedded forward"
              ? forwardMessageBody(message, dateContext)
              : "";
        const markedSignature = `\u2063${signatureBody}\u2064`;
        const olderHasText = scenario !== "both untouched";
        await beginLegacyMigration();
        const insert = async (body: string, createdAt: string, selectedSignature: boolean) => {
          const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
            (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id,
              author_kind, author_id, last_editor_kind, last_editor_id, edit_mode, revision, body_markdown,
              subject, to_addresses, signature_template_id, quote_source, created_at)
            VALUES (${newShortId()}, ${mailboxId}::uuid, ${source.conversationId}::uuid, ${source.sourceMessageId}::uuid,
               'reply', ${identityId}::uuid, ${serviceAccount ? "service_account" : "user"}, ${serviceAccount ? accountId : userId}::uuid,
              ${serviceAccount ? "service_account" : "user"}, ${serviceAccount ? accountId : userId}::uuid, 'lock', 1, ${body},
              'Re: Question', '[{"address":"customer@example.test"}]', ${selectedSignature && !serviceAccount ? signature!.id : null}::uuid,
              ${fixture === "separate"}, ${createdAt}::timestamptz) RETURNING id`;
          return row!.id;
        };
        // Before #967, appendSignature inserted a German reply's signature between attribution and quote.
        const legacyBody = (text: string) =>
          fixture === "legacy German reply"
            ? [text, history.replace("\n>", `\n\n${markedSignature}\n\n>`)].filter(Boolean).join("\n\n")
            : [text, markedSignature, history].filter(Boolean).join("\n\n");
        const olderBody = legacyBody(olderHasText ? "Yes, we can deliver on Friday." : "");
        const newerBody =
          scenario === "signature only" || fixture.endsWith("signature")
            ? markedSignature
            : fixture === "legacy German reply"
              ? legacyBody("")
              : history;
        const older = await insert(olderBody, "2026-11-01T09:00:00Z", false);
        const newer = await insert(newerBody, "2026-11-01T11:00:00Z", true);
        expect(
          await sql<
            { revision: number; content_edited_at: Date | null }[]
          >`SELECT revision::int, content_edited_at FROM mail.drafts WHERE id IN (${older}::uuid, ${newer}::uuid)`,
        ).toEqual([
          { revision: 1, content_edited_at: null },
          { revision: 1, content_edited_at: null },
        ]);
        // Templates can change after creation without editing the legacy draft itself.
        if (fixture === "edited signature")
          await sql`UPDATE mail.compose_templates SET body_template = 'A different current sign-off' WHERE id = ${signature!.id}::uuid`;
        if (fixture === "archived signature")
          await sql`UPDATE mail.compose_templates SET archived_at = '2026-11-02T09:00:00Z' WHERE id = ${signature!.id}::uuid`;
        expect(await migrate()).toEqual({ deletedDrafts: 1, affectedConversations: 1, completed: true });
        const survivor = olderHasText ? older : newer;
        const loser = olderHasText ? newer : older;
        expect(unwrap(await drafts.getDraft(owner, mailboxId, survivor))).toMatchObject({ state: "draft", consolidatedCount: 1 });
        expect((await sql`SELECT body_markdown FROM mail.drafts WHERE id = ${survivor}::uuid`)[0]?.body_markdown).toBe(
          olderHasText ? olderBody : newerBody,
        );
        expect((await sql`SELECT state, body_markdown FROM mail.drafts WHERE id = ${loser}::uuid`)[0]).toEqual({
          state: "discarded",
          body_markdown: "",
        });
      });
    }
  }
  test("two committed sends refuse before the F6 marker and preserve both sends", async () => {
    const first = await create();
    await sql`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${first.id}::uuid`;
    await submission(first.id, "scheduled");
    await beginLegacyMigration();
    const second = await legacySuggestion(first, "sending");
    const secondSend = await submission(second.id, "undo_window");
    await expect(migrate()).rejects.toThrow("2 committed sends. Let them send or cancel them with the previous Mail image");
    expect(await sql`SELECT version FROM mail.schema_migrations WHERE version = 4`).toHaveLength(0);
    expect(
      await sql`SELECT id FROM mail.drafts WHERE conversation_id = ${first.conversationId}::uuid AND state IN ('scheduled', 'sending')`,
    ).toHaveLength(2);
    // The previous image cancels the second send; retrying keeps the committed first one.
    await sql`UPDATE mail.outbox_submissions SET state = 'cancelled' WHERE id = ${secondSend}::uuid`;
    await sql`UPDATE mail.drafts SET state = 'draft' WHERE id = ${second.id}::uuid`;
    expect(await migrate()).toMatchObject({ deletedDrafts: 1 });
  });
  test("F6 handles multiple conversations in one bounded transaction", async () => {
    const first = await create();
    const second = await create();
    await beginLegacyMigration();
    const copies = [await legacySuggestion(first), await legacySuggestion(second)];
    expect(await migrate()).toMatchObject({ deletedDrafts: 2, affectedConversations: 2 });
    const transactions = await sql`SELECT DISTINCT xmin::text FROM mail.drafts
      WHERE id = ANY(${sql.array(
        copies.map((copy) => copy.id),
        "UUID",
      )}) AND state = 'discarded'`;
    expect(transactions).toHaveLength(1);
    expect(await sql`SELECT 1 FROM pg_indexes WHERE schemaname = 'mail' AND indexname = 'drafts_reply_consolidation_idx'`).toHaveLength(0);
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
    // Cross the 100-draft budget, including user-origin workflow review drafts.
    await sql`INSERT INTO mail.drafts (short_id, mailbox_id, conversation_id, source_message_id, intent,
      sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, origin, body_markdown, created_at)
      SELECT 'B1' || lpad(n::text, 4, '0'), ${mailboxId}::uuid, ${source.conversationId}::uuid,
        ${source.sourceMessageId}::uuid, 'forward', ${identityId}::uuid, 'workflow', ${crypto.randomUUID()}::uuid, 'workflow', ${crypto.randomUUID()}::uuid, 'user',
        'Old automated copy', '2026-10-01' FROM generate_series(1, 103) n`;
    // Emulate a database lock failure only after the first 100-deletion transaction commits.
    await sql`CREATE FUNCTION mail.test_f6_lock_timeout() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.metadata->>'reason' = 'reply_draft_consolidation' AND
          (SELECT count(*) FROM mail.drafts WHERE conversation_id = NEW.conversation_id AND state = 'discarded') > 100 THEN
          RAISE EXCEPTION 'simulated F6 lock timeout' USING ERRCODE = '55P03';
        END IF;
        RETURN NEW;
      END $$`.simple();
    await sql`CREATE TRIGGER test_f6_lock_timeout BEFORE INSERT ON mail.activity_events
      FOR EACH ROW EXECUTE FUNCTION mail.test_f6_lock_timeout()`.simple();
    try {
      await expect(migrate()).rejects.toThrow("simulated F6 lock timeout");
      expect((await sql`SELECT details FROM mail.schema_migrations WHERE version = 4`)[0]?.details).toEqual({
        deletedDrafts: 100,
        affectedConversations: 1,
        completed: false,
      });
      expect(
        await sql`SELECT id FROM mail.drafts WHERE conversation_id = ${source.conversationId}::uuid AND state = 'discarded'`,
      ).toHaveLength(100);
      expect(
        await sql`SELECT id FROM mail.activity_events WHERE conversation_id = ${source.conversationId}::uuid AND action = 'draft.discarded'`,
      ).toHaveLength(100);
    } finally {
      await sql`DROP TRIGGER test_f6_lock_timeout ON mail.activity_events`.simple();
      await sql`DROP FUNCTION mail.test_f6_lock_timeout()`.simple();
    }
    // Also interrupt finish after all erasures and the unique index have committed.
    await sql`CREATE FUNCTION mail.test_f6_finish_timeout() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.version = 4 AND (NEW.details->>'completed')::boolean THEN
          RAISE EXCEPTION 'simulated F6 finish timeout' USING ERRCODE = '55P03';
        END IF;
        RETURN NEW;
      END $$`.simple();
    await sql`CREATE TRIGGER test_f6_finish_timeout BEFORE UPDATE ON mail.schema_migrations
      FOR EACH ROW EXECUTE FUNCTION mail.test_f6_finish_timeout()`.simple();
    try {
      await expect(migrate()).rejects.toThrow("simulated F6 finish timeout");
      expect((await sql`SELECT details FROM mail.schema_migrations WHERE version = 4`)[0]?.details).toEqual({
        deletedDrafts: 104,
        affectedConversations: 1,
        completed: false,
      });
      expect(
        (await sql`SELECT indisvalid FROM pg_index WHERE indexrelid = 'mail.drafts_one_open_reply_idx'::regclass`)[0]?.indisvalid,
      ).toBeTrue();
    } finally {
      await sql`DROP TRIGGER test_f6_finish_timeout ON mail.schema_migrations`.simple();
      await sql`DROP FUNCTION mail.test_f6_finish_timeout()`.simple();
    }
    const result = await migrate();
    expect(result).toEqual({ deletedDrafts: 104, affectedConversations: 1, completed: true });
    const kept = unwrap(await drafts.getDraft(owner, mailboxId, older.id));
    expect(kept.consolidatedCount).toBe(104);
    expect(kept.body).toBe("My text");
    const activity = await sql<{ metadata: { count: number; reason: string } }[]>`SELECT metadata FROM mail.activity_events
      WHERE conversation_id = ${source.conversationId}::uuid AND action = 'draft.discarded'`;
    expect(activity).toHaveLength(104);
    expect(activity.every((event) => event.metadata.count === 1 && event.metadata.reason === "reply_draft_consolidation")).toBeTrue();
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
    expect((await drafts.acknowledgeDraftConsolidation({ context: gustav, mailboxId, draftId: older.id })).ok).toBeFalse();
    const acknowledged = unwrap(await drafts.acknowledgeDraftConsolidation({ context: owner, mailboxId, draftId: older.id }));
    expect(acknowledged.consolidatedCount).toBe(0);
    expect(acknowledged.revision).toBe(kept.revision);
    await sql`UPDATE mail.drafts SET state = 'sent' WHERE id = ${older.id}::uuid`;
    expect((await drafts.acknowledgeDraftConsolidation({ context: owner, mailboxId, draftId: older.id })).ok).toBeFalse();
    expect(await migrate()).toEqual(result);
  });
});
