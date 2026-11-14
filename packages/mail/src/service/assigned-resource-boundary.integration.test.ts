import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { accounts, oauthTokens } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { unwrap } from "@k2b/stdlib";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type MailApiContext, resolveMailboxParam, resolveMailboxResourceParam } from "../api/public-resource-boundary";
import { mailCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";

import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";

Bun.plugin(createConfig({ dev: true, rootDir: import.meta.dir }).plugin());
const { router } = await import("../router");

const suite = suiteFor("database", "nats", "valkey");
const at = "2026-10-20T06:00:00.000Z";

suite("Mail assigned resource and SSR boundaries", () => {
  const ctx: Record<string, CapabilityExecutionContext> = {};
  const users: Record<string, User> = {};
  let mailboxId = "";
  let mailboxShortId = "";
  let conversationShortId = "";
  let deliveryShortId = "";
  let conversationId = "";
  let accountId = "";
  let senderShortId = "";
  let reminderShortId = "";
  let messageShortId = "";

  const createUser = async (name: string) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail, admin)
      VALUES (${`g36w-probe-${newShortId()}`}, 'local', 'user', ${name}, ${`${name}-${newShortId()}@internal.test`}, ${name === "admin"}) RETURNING id`;
    if (!row) throw new Error("Missing boundary user");
    const user = await accounts.users.get({ id: row.id });
    if (!user) throw new Error("Missing boundary user");
    users[name] = user;
    ctx[name] = {
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: row!.id },
      user,
      requestId: `g36w-${name}`,
      origin: "assistant",
      locale: "en",
      signal: new AbortController().signal,
    };
  };
  const mc = (c: CapabilityExecutionContext): MailRequestContext => ({
    actor: c.actor,
    accessSubject: c.accessSubject,
    requestId: c.requestId,
  });

  beforeAll(async () => {
    setSystemTime(new Date(at));
    for (const name of ["owner", "reader", "outsider", "assignedRead", "assignedWrite", "admin"]) await createUser(name);
    const mailbox = unwrap(await createMailbox(mc(ctx.owner!), { name: "Boundary", description: "Assigned resource boundary" }));
    mailboxId = mailbox.id;
    mailboxShortId = (await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`)[0]!.short_id;
    for (const [name, permission, scope] of [
      ["reader", "read", undefined],
      ["assignedRead", "read", "assigned"],
      ["assignedWrite", "write", "assigned"],
    ] as const) {
      const grant = await grantMailboxAccess({
        context: mc(ctx.owner!),
        mailboxId,
        principal: { type: "user", userId: users[name]!.id },
        permission,
        scope,
      });
      if (!grant.ok) throw new Error(grant.error.message);
    }
    const [conversation] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Hidden', 'x@outside.test', ${at}) RETURNING id, short_id`;
    conversationShortId = conversation!.short_id;
    conversationId = conversation!.id;
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES ('Boundary scoped admin', 'standalone') RETURNING id`;
    accountId = account!.id;
    const [message] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${newShortId()}@example.test>`}, 'Hidden', ${at}, 1,
        ${new Bun.CryptoHasher("sha256").update(`probe-${mailboxId}`).digest("hex")}, 'complete') RETURNING id, short_id`;
    messageShortId = message!.short_id;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 0)`;
    const ownerId = users.owner!.id;
    const [reminder] = await sql<{ short_id: string }[]>`INSERT INTO mail.conversation_reminders
      (short_id, mailbox_id, conversation_id, user_id, due_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${conversationId}::uuid, ${ownerId}::uuid, ${"2026-12-01T00:00:00.000Z"}) RETURNING short_id`;
    reminderShortId = reminder!.short_id;
    const [identity] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Team', 'Team', 'team@internal.test', 'verified') RETURNING id, short_id`;
    senderShortId = identity!.short_id;
    const [draft] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, subject, body_markdown, revision, created_at, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${identity!.id}::uuid, 'user', ${ownerId}::uuid, 'user', ${ownerId}::uuid, 'S', 'B', 1, ${at}, ${at})
      RETURNING id`;
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
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${draft!.id}::uuid, ${command!.id}::uuid, ${identity!.id}::uuid,
        ${binding!.id}::uuid, ${`<${newShortId()}@internal.test>`}, 'scheduled', ${at}, ${at}, ${at},
        ${{ to: [], cc: [], bcc: [], subject: "Scheduled", body: "Body", renderedText: "Body" }}::jsonb, ${at}, ${at}) RETURNING short_id`;
    deliveryShortId = delivery!.short_id;
  }, 60_000);

  afterAll(async () => {
    setSystemTime();
    if (accountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
    if (mailboxId) {
      const links = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
        UNION SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${links.map((l) => l.access_id)}::jsonb))`;
    }
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${Object.values(users).map((u) => u.id)}::jsonb))`;
  }, 60_000);

  const refusal = async (call: Promise<{ ok: boolean; error?: unknown }>) => {
    const result = await call;
    expect(result.ok).toBeFalse();
    return result.error;
  };
  const conversationCalls = () => {
    const m = mailboxShortId;
    const queries = mailCapabilities.queries;
    const actions = mailCapabilities.actions;
    type Call = (id: string, context: CapabilityExecutionContext) => Promise<{ ok: boolean; error?: unknown }>;
    const calls: Record<string, Call> = {
      related: (id, c) =>
        queries["conversation.related"].run(queries["conversation.related"].input.parse({ mailboxId: m, conversationId: id }), c),
      read: (id, c) => queries["conversation.read"].run({ id }, c),
    };
    calls["message.list"] = (id, c) =>
      queries["message.list"].run(queries["message.list"].input.parse({ mailboxId: m, conversationId: id }), c);
    calls["conversation.comment.list"] = (id, c) =>
      queries["conversation.comment.list"].run(queries["conversation.comment.list"].input.parse({ mailboxId: m, conversationId: id }), c);
    calls["conversation.activity.list"] = (id, c) =>
      queries["conversation.activity.list"].run(queries["conversation.activity.list"].input.parse({ mailboxId: m, conversationId: id }), c);
    calls["conversation.reminder.get"] = (id, c) =>
      queries["conversation.reminder.get"].run(queries["conversation.reminder.get"].input.parse({ mailboxId: m, conversationId: id }), c);
    for (const phase of ["review", "run"] as const) {
      calls[`tag.${phase}`] = (id, c) =>
        actions["conversation.tag.update"][phase](
          { mailboxId: m, conversationId: id, expectedRevision: 1, addTagIds: [], removeTagIds: [] },
          c,
        );
      calls[`summary.${phase}`] = (id, c) =>
        actions["conversation.summary.write"][phase](
          { mailboxId: m, conversationId: id, expectedRevision: 1, expectedSummaryRevision: 0, summary: "Prepared" },
          c,
        );
      calls[`reference.${phase}`] = (id, c) => actions["conversation.reference.ensure"][phase]({ mailboxId: m, conversationId: id }, c);
      calls[`conversation.status.update.${phase}`] = (id, c) =>
        actions["conversation.status.update"][phase](
          actions["conversation.status.update"].input.parse({ mailboxId: m, conversationId: id, expectedRevision: 1, status: "done" }),
          c,
        );
      calls[`conversation.assign.${phase}`] = (id, c) =>
        actions["conversation.assign"][phase](
          actions["conversation.assign"].input.parse({
            mailboxId: m,
            conversationId: id,
            expectedRevision: 1,
            mode: "replace",
            assigneeUserIds: [],
          }),
          c,
        );
      calls[`conversation.snooze.${phase}`] = (id, c) =>
        actions["conversation.snooze"][phase](
          actions["conversation.snooze"].input.parse({
            mailboxId: m,
            conversationId: id,
            expectedRevision: 1,
            snoozedUntil: "2026-12-01T00:00:00.000Z",
          }),
          c,
        );
      calls[`conversation.keep.${phase}`] = (id, c) =>
        actions["conversation.keep"][phase](actions["conversation.keep"].input.parse({ mailboxId: m, conversationId: id }), c);
      calls[`conversation.reminder.set.${phase}`] = (id, c) =>
        actions["conversation.reminder.set"][phase](
          actions["conversation.reminder.set"].input.parse({
            mailboxId: m,
            conversationId: id,
            dueAt: "2026-12-01T00:00:00.000Z",
            expectedRevision: null,
          }),
          c,
        );
      calls[`conversation.comment.create.${phase}`] = (id, c) =>
        actions["conversation.comment.create"][phase](
          actions["conversation.comment.create"].input.parse({ mailboxId: m, conversationId: id, body: "Note" }),
          c,
        );
      calls[`conversation.mark.${phase}`] = (id, c) =>
        actions["conversation.mark"][phase](
          actions["conversation.mark"].input.parse({ mailboxId: m, target: { conversationId: id, sourceFolderId: "Fold01" }, read: true }),
          c,
        );
      calls[`conversation.assign.batch.${phase}`] = (id, c) =>
        actions["conversation.assign.batch"][phase](
          actions["conversation.assign.batch"].input.parse({ mailboxId: m, conversationIds: [id], mode: "replace", assigneeUserIds: [] }),
          c,
        );
      calls[`draft.create.${phase}`] = (id, c) =>
        actions["draft.create"][phase](
          actions["draft.create"].input.parse({ mailboxId: m, conversationId: id, senderIdentityId: senderShortId, intent: "reply" }),
          c,
        );
    }
    return calls;
  };
  for (const who of ["assignedRead", "assignedWrite", "outsider"] as const) {
    test(`${who}: conversation queries, reviews and runs conceal hidden conversations`, async () => {
      for (const [name, call] of Object.entries(conversationCalls())) {
        const context = { ...ctx[who]!, idempotencyKey: `boundary-${newShortId()}` };
        const result = await call(conversationShortId, context);
        expect({ name, ok: result.ok }).toEqual({ name, ok: false });
        const hidden = result.error;
        const unknown = await refusal(call(newShortId(), context));
        expect({ name, hidden }).toEqual({ name, hidden: unknown });
        expect(hidden).toMatchObject({ code: expect.stringMatching(/^(NOT_FOUND|FORBIDDEN)$/) });
      }
    });
    for (const phase of ["review", "run"] as const) {
      test(`${who}: delivery.cancel ${phase} conceals hidden deliveries`, async () => {
        const call = (id: string) =>
          mailCapabilities.actions["delivery.cancel"][phase](
            { mailboxId: mailboxShortId, deliveryId: id, disposition: "draft" },
            { ...ctx[who]!, idempotencyKey: `boundary-${newShortId()}` },
          );
        const hidden = await refusal(call(deliveryShortId));
        expect(hidden).toEqual(await refusal(call(newShortId())));
        expect(hidden).toMatchObject({ code: "NOT_FOUND", status: 404 });
      });
    }
  }

  test("both status batch aliases conceal hidden assigned conversations in review and execution", async () => {
    for (const who of ["assignedRead", "assignedWrite", "outsider"] as const) {
      for (const name of ["conversation.status.update.batch", "conversation.status.set.batch"] as const) {
        for (const phase of ["review", "run"] as const) {
          const action = mailCapabilities.actions[name];
          const call = (id: string) =>
            action[phase](action.input.parse({ mailboxId: mailboxShortId, conversationIds: [id], status: "done" }), ctx[who]!);
          const unknownId = newShortId();
          const hidden = await call(conversationShortId);
          const unknown = await call(unknownId);
          // A batch echoes the supplied ID even for not_found; compare everything except that echo.
          expect(JSON.stringify(hidden).replaceAll(conversationShortId, "<requested-id>")).toEqual(
            JSON.stringify(unknown).replaceAll(unknownId, "<requested-id>"),
          );
          if (hidden.ok && phase === "run") expect(hidden).toMatchObject({ data: { data: { results: [{ status: "not_found" }] } } });
        }
      }
    }
  });

  const request = async (who: string, path: string, method = "GET", body?: unknown) => {
    const spy = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user = users[token];
      return user ? { kind: "user", payload: {}, user, scopes: ["read", "write"] } : null;
    });
    try {
      return await router.request(path, {
        method,
        headers: {
          authorization: `Bearer ${who}`,
          "x-forwarded-for": uniqueCallerAddress(),
          "content-type": "application/json",
          "accept-language": "en",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally {
      spy.mockRestore();
    }
  };
  const answer = async (response: Response | Promise<Response>) => {
    const r = await response;
    return { status: r.status, body: await r.text(), location: r.headers.get("location") };
  };
  for (const selector of ["", "folder", "savedView"] as const) {
    test(`SSR conceals unreadable mailboxes before ${selector || "default view"} resolution`, async () => {
      const query = selector ? `?${selector}=${newShortId()}` : "";
      const hidden = await answer(request("outsider", `/app/mail/${mailboxShortId}${query}`));
      const unknown = await answer(request("outsider", `/app/mail/${newShortId()}${query}`));
      expect(hidden.status).toBe(404);
      // The error page may contain the requested URL; status and redirect must never depend on existence.
      expect({ status: hidden.status, location: hidden.location }).toEqual({ status: unknown.status, location: unknown.location });
      if (selector) expect((await request("reader", `/app/mail/${mailboxShortId}${query}`)).status).toBe(302);
    });
  }
  for (const who of ["assignedRead", "assignedWrite"] as const) {
    test(`${who}: every conversation REST route hides assigned-only resources before validation`, async () => {
      const api = `/api/mail/mailboxes/${mailboxShortId}/conversations`;
      const cases: Array<[string, string, unknown?]> = [
        ...["context", "related", "messages", "collaboration", "keep", "comments", "preview", "drafts"].map((suffix): [string, string] => [
          suffix,
          "GET",
        ]),
        ["comments", "POST", {}],
        ["comments?limit=invalid", "GET"],
        ["context?limit=invalid", "GET"],
      ];
      for (const [suffix, method, body] of cases) {
        const hidden = await answer(request(who, `${api}/${conversationShortId}/${suffix}`, method, body));
        expect({ suffix, method, hidden }).toEqual({
          suffix,
          method,
          hidden: await answer(request(who, `${api}/${newShortId()}/${suffix}`, method, body)),
        });
        expect(hidden.status).toBe(404);
      }
    });
    test(`${who}: draft source references conceal unreadable messages in review and run`, async () => {
      for (const phase of ["review", "run"] as const) {
        const action = mailCapabilities.actions["draft.create"];
        const call = (id: string) =>
          action[phase](
            action.input.parse({ mailboxId: mailboxShortId, sourceMessageId: id, senderIdentityId: senderShortId, intent: "reply" }),
            { ...ctx[who]!, idempotencyKey: `source-${newShortId()}` },
          );
        expect(await refusal(call(messageShortId))).toEqual(await refusal(call(newShortId())));
      }
    });
    test(`${who}: draft body and seed references conceal hidden child IDs`, async () => {
      const prefix = `/api/mail/mailboxes/${mailboxShortId}`;
      const content = { senderIdentityId: senderShortId, intent: "reply", subject: "Reply", body: "Body" };
      for (const field of ["conversationId", "sourceMessageId"] as const) {
        const known = field === "conversationId" ? conversationShortId : messageShortId;
        const body = (id: string) => ({ ...content, [field]: id });
        for (const route of ["drafts", "draft-seeds"]) {
          const input = (id: string) => (route === "drafts" ? body(id) : { origin: { kind: "compose", input: body(id) } });
          const hidden = await answer(request(who, `${prefix}/${route}`, "POST", input(known)));
          expect(hidden.status).toBe(404);
          expect(hidden).toEqual(await answer(request(who, `${prefix}/${route}`, "POST", input(newShortId()))));
        }
      }
      const derived = (id: string) => ({
        origin: {
          kind: "derive",
          messageId: id,
          input: { kind: "edit_as_new", senderIdentityId: senderShortId, includeAttachments: false },
        },
      });
      const hidden = await answer(request(who, `${prefix}/draft-seeds`, "POST", derived(messageShortId)));
      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(await answer(request(who, `${prefix}/draft-seeds`, "POST", derived(newShortId()))));
    });
    test(`${who}: reminder target resolution conceals a hidden reminder`, async () => {
      const path = (id: string) => `/api/mail/mailboxes/${mailboxShortId}/notification-targets/reminder/${id}`;
      const hidden = await answer(request(who, path(reminderShortId)));
      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(await answer(request(who, path(newShortId()))));
      expect((await request("owner", path(reminderShortId))).status).toBe(302);
    });
    test(`${who}: REST scheduled cancellation resolves visibility before write permission or body validation`, async () => {
      for (const body of [{ disposition: "draft" }, {}]) {
        const path = (id: string) => `/api/mail/mailboxes/${mailboxShortId}/scheduled-sends/${id}/cancel`;
        const hidden = await answer(request(who, path(deliveryShortId), "POST", body));
        expect(hidden).toEqual(await answer(request(who, path(newShortId()), "POST", body)));
        expect(hidden.status).toBe(404);
      }
    });
  }
  test("readable resources retain successful reads, validation errors and precise write refusals", async () => {
    expect(
      (
        await mailCapabilities.queries["conversation.related"].run(
          { mailboxId: mailboxShortId, conversationId: conversationShortId, limit: 10 },
          ctx.reader!,
        )
      ).ok,
    ).toBeTrue();
    expect(
      (
        await mailCapabilities.actions["delivery.cancel"].review(
          { mailboxId: mailboxShortId, deliveryId: deliveryShortId, disposition: "draft" },
          ctx.owner!,
        )
      ).ok,
    ).toBeTrue();
    expect(
      await refusal(
        mailCapabilities.actions["delivery.cancel"].review(
          { mailboxId: mailboxShortId, deliveryId: deliveryShortId, disposition: "draft" },
          ctx.reader!,
        ),
      ),
    ).toMatchObject({ code: "FORBIDDEN", status: 403 });
    const api = `/api/mail/mailboxes/${mailboxShortId}/conversations/${conversationShortId}`;
    expect((await request("reader", `${api}/context`)).status).toBe(200);
    expect((await request("reader", `${api}/comments`, "POST", {})).status).toBe(400);
    // An assigned conversation must still resolve for both assigned roles.
    for (const who of ["assignedRead", "assignedWrite"] as const) {
      await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id)
        VALUES (${conversationId}::uuid, ${users[who]!.id}::uuid)`;
      try {
        expect((await mailCapabilities.queries["conversation.read"].run({ id: conversationShortId }, ctx[who]!)).ok).toBeTrue();
        expect(
          await refusal(
            mailCapabilities.queries["conversation.related"].run(
              { mailboxId: mailboxShortId, conversationId: conversationShortId, limit: 10 },
              ctx[who]!,
            ),
          ),
        ).toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect((await request(who, `${api}/context`)).status).toBe(403);
      } finally {
        await sql`DELETE FROM mail.conversation_assignees WHERE conversation_id = ${conversationId}::uuid AND principal_id = ${users[who]!.id}::uuid`;
      }
    }
  });
  test("delivery resource visibility is independent of its scheduling or failure state", async () => {
    const app = new Hono<MailApiContext>();
    app.use("*", async (c, next) => {
      const who = c.req.header("x-boundary-actor") ?? "assignedRead";
      c.set("actor", ctx[who]!.actor);
      c.set("accessSubject", ctx[who]!.accessSubject);
      c.set("internalMailboxId", mailboxId);
      await next();
    });
    app.get("/:scheduledSendId", resolveMailboxResourceParam("deliveries", "scheduledSendId", "Scheduled send"), (c) =>
      c.json({ visible: true }),
    );
    const get = (who: string, id: string) => app.request(`/${id}`, { headers: { "x-boundary-actor": who } });
    await sql`UPDATE mail.drafts SET intent = 'reply', conversation_id = ${conversationId}::uuid, source_message_id = (SELECT id FROM mail.message_contents WHERE short_id = ${messageShortId}) WHERE mailbox_id = ${mailboxId}::uuid`;
    try {
      for (const state of ["scheduled", "failed", "needs_attention", "unknown", "cancelled"]) {
        await sql`UPDATE mail.outbox_submissions SET state = ${state} WHERE short_id = ${deliveryShortId}`;
        for (const who of ["assignedRead", "assignedWrite"] as const) {
          const hidden = await answer(get(who, deliveryShortId));
          expect(hidden.status).toBe(404);
          expect(hidden).toEqual(await answer(get(who, newShortId())));
          await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${conversationId}::uuid, ${users[who]!.id}::uuid)`;
          try {
            expect((await get(who, deliveryShortId)).status).toBe(200);
          } finally {
            await sql`DELETE FROM mail.conversation_assignees WHERE conversation_id = ${conversationId}::uuid AND principal_id = ${users[who]!.id}::uuid`;
          }
        }
      }
    } finally {
      await sql`UPDATE mail.outbox_submissions SET state = 'scheduled' WHERE short_id = ${deliveryShortId}`;
      await sql`UPDATE mail.drafts SET intent = 'new', conversation_id = NULL, source_message_id = NULL WHERE mailbox_id = ${mailboxId}::uuid`;
    }
  });
  test("platform administration resolves mailboxes only within the credential scope", async () => {
    for (const scopes of [[], ["mail:read"], ["mail:write"], ["mail:admin"]]) {
      const app = new Hono<MailApiContext>();
      app.use("*", async (c, next) => {
        c.set("actor", {
          kind: "service_account",
          serviceAccount: {
            id: accountId,
            name: "Boundary admin",
            kind: "standalone",
            status: "active",
            delegatedUserId: null,
            appId: null,
            resourceType: null,
            resourceId: null,
            createdBy: null,
            createdAt: at,
          },
          delegatedUser: users.admin!,
          scopes,
        });
        c.set("accessSubject", { type: "service_account", serviceAccountId: accountId });
        await next();
      });
      app.get("/:mailboxId", resolveMailboxParam, (c) => c.json({ resolved: true }));
      const hidden = await answer(app.request(`/${mailboxShortId}`));
      if (scopes.includes("mail:admin")) expect(hidden.status).toBe(200);
      else {
        expect(hidden.status).toBe(404);
        expect(hidden).toEqual(await answer(app.request(`/${newShortId()}`)));
      }
    }
  });
});
