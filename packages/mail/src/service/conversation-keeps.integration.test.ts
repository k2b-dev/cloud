import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { KeptConversationExportSchema, MAX_CONVERSATION_ACTION_MESSAGES } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { checkCommandKeepProtection, keepLastKeptPlacements, retireKeptCopyPlacements } from "./conversation-keep-rules";
import { canLiftConversationKeeps, getConversationKeep, keepConversation, releaseConversationKeep } from "./conversation-keeps";
import { mergeConversations, reassignConversationMessage, splitConversation } from "./conversations";
import { exportKeptConversations, getKeptConversation, listKeptConversations } from "./kept-conversations";
import { createMailbox } from "./mailboxes";
import { createBlobReadable } from "./message-blobs";
import { hydrateMessageFromSource } from "./message-hydration";
import { openMessageSource } from "./message-inspector";
import { getConversationViewCounts, getMessage, listConversations, openAttachment } from "./messages";
import { removeUnsentOutboundMessage } from "./outbound-message-projection";
import { searchMessages } from "./search";
import * as syncRuntime from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");
const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      ...user,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: "Mail",
      sn: "Test",
      mail: `${user.uid}@example.test`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-keep-${user.uid}`,
});

suite("Mail conversation keeps", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: Array<{ id: string; uid: string }> = [];
  let admin: MailRequestContext;
  let cloudAdmin: MailRequestContext;
  const serviceAccounts: string[] = [];
  let writer: MailRequestContext;
  let reader: MailRequestContext;
  let mailboxId = "";
  let folderId = "";
  let nextUid = 1;
  const blobIds: string[] = [];
  beforeAll(async () => {
    await migrate();
    await migrate();
    for (const role of ["admin", "writer", "reader", "cloud-admin"]) {
      const [user] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`keep-${role}-${suffix}`}, 'local', 'user', ${`Keep ${role}`}, ${role === "cloud-admin"}) RETURNING id, uid`;
      if (!user) throw new Error("Keep fixture user missing");
      users.push(user);
    }
    admin = contextFor(users[0]!);
    writer = contextFor(users[1]!);
    reader = contextFor(users[2]!);
    cloudAdmin = contextFor(users[3]!);
    if (cloudAdmin.actor.kind === "user") cloudAdmin.actor.user.roles = ["user", "admin"];
    const mailbox = await createMailbox(admin, { name: `Keeps ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    for (const [context, permission] of [
      [writer, "write"],
      [reader, "read"],
    ] as const) {
      const grant = await grantMailboxAccess({ context: admin, mailboxId, principal: context.accessSubject, permission });
      if (!grant.ok) throw new Error(grant.error.message);
    }
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'active') RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, display)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${suffix}, 'Hidden evidence', 'other', 'hidden') RETURNING id`;
    folderId = folder!.id;
  });
  afterAll(async () => {
    const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (blobIds.length)
      await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${blobIds}::jsonb))`;
    for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    await sql`DELETE FROM audit.events WHERE metadata->>'mailboxId' = ${mailboxId}`;
    for (const id of serviceAccounts) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    for (const user of users) {
      await sql`DELETE FROM audit.events WHERE request_id = ${contextFor(user).requestId}`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
    }
  });
  const conversation = async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations (short_id, mailbox_id, subject, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Evidence', now()) RETURNING id`;
    return row!.id;
  };
  const message = async (conversationId: string) => {
    const uid = nextUid++;
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<keep-${uid}-${suffix}@example.test>`}, 'Evidence', 'evidence', now(), 1, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'complete', 'Evidence body') RETURNING id`;
    const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${row!.id}::uuid, 1, ${uid}) RETURNING id`;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id) VALUES (${ref!.id}::uuid, ${folderId}::uuid, ${row!.id}::uuid)`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position) VALUES (${conversationId}::uuid, ${row!.id}::uuid, ${uid})`;
    return { id: row!.id, refId: ref!.id };
  };
  const scope = (conversationId: string, context = admin) => ({ context, mailboxId, conversationId });

  test("read cannot keep; write keeps idempotently; only a Cloud admin releases, with audit and timeline", async () => {
    const id = await conversation();
    await message(id);
    expect(await getConversationKeep(scope(id, reader))).toEqual({ ok: true, data: null });
    expect(await keepConversation(scope(id, reader))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const kept = await keepConversation(scope(id, writer));
    expect(kept).toMatchObject({
      ok: true,
      data: { conversationId: id, keptBy: { kind: "user", id: users[1]!.id, displayName: "Keep writer" } },
    });
    expect(await keepConversation(scope(id))).toEqual(kept);
    expect(await releaseConversationKeep(scope(id, writer))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await releaseConversationKeep(scope(id, reader))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await releaseConversationKeep(scope(id, cloudAdmin))).toEqual({ ok: true, data: { conversationId: id, released: true } });
    expect(await releaseConversationKeep(scope(id, cloudAdmin))).toEqual({ ok: true, data: { conversationId: id, released: false } });
    const activity =
      await sql`SELECT action, actor_id, outcome, target_type FROM mail.activity_events WHERE conversation_id = ${id}::uuid ORDER BY id`;
    expect(activity).toEqual([
      { action: "conversation.kept", actor_id: users[1]!.id, outcome: "confirmed", target_type: "conversation" },
      { action: "conversation.keep_released", actor_id: users[3]!.id, outcome: "confirmed", target_type: "conversation" },
    ]);
    const audit = await sql`SELECT action, outcome, actor_user_id FROM audit.events WHERE target_id = ${id} ORDER BY id`;
    expect(audit).toEqual([
      { action: "mail.conversation.keep", outcome: "denied", actor_user_id: users[2]!.id },
      { action: "mail.conversation.keep", outcome: "allowed", actor_user_id: users[1]!.id },
      { action: "mail.conversation.keep.release", outcome: "denied", actor_user_id: users[1]!.id },
      { action: "mail.conversation.keep.release", outcome: "denied", actor_user_id: users[2]!.id },
      { action: "mail.conversation.keep.release", outcome: "allowed", actor_user_id: users[3]!.id },
    ]);
  });

  const serviceContext = async (kind: "agent" | "standalone" | "user_delegated" | "resource_bound"): Promise<MailRequestContext> => {
    const user = cloudAdmin.actor.kind === "user" ? cloudAdmin.actor.user : null;
    if (!user) throw new Error("Cloud admin fixture missing");
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind, delegated_user_id, app_id, resource_type, resource_id)
      VALUES (${`Keep ${kind} ${suffix}`}, ${kind}, ${kind === "user_delegated" ? user.id : null}::uuid,
        ${kind === "resource_bound" ? "mail" : null}, ${kind === "resource_bound" ? "mailbox" : null},
        ${kind === "resource_bound" ? mailboxId : null}::uuid) RETURNING id`;
    if (!row) throw new Error("Service account fixture missing");
    serviceAccounts.push(row.id);
    return {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: row.id,
          name: `Keep ${kind} ${suffix}`,
          kind,
          status: "active",
          delegatedUserId: kind === "user_delegated" ? user.id : null,
          appId: kind === "resource_bound" ? "mail" : null,
          resourceType: kind === "resource_bound" ? "mailbox" : null,
          resourceId: kind === "resource_bound" ? mailboxId : null,
          createdBy: null,
          createdAt: "2026-10-09T10:00:00.000Z",
        },
        delegatedUser: kind === "user_delegated" ? user : null,
        scopes: kind === "user_delegated" ? [] : ["mail:admin"],
      },
      accessSubject: kind === "user_delegated" ? { type: "user", userId: user.id } : { type: "service_account", serviceAccountId: row.id },
      requestId: `mail-keep-service-${kind}-${suffix}`,
    };
  };

  test("only current person-backed Cloud admins lift keeps, without any mailbox grant; mandates never do", async () => {
    const id = await conversation();
    await message(id);
    const kept = await keepConversation(scope(id, writer));
    expect(kept).toMatchObject({ ok: true, data: { canLift: false } });
    const agent = await serviceContext("agent");
    const grant = await grantMailboxAccess({ context: admin, mailboxId, principal: agent.accessSubject, permission: "admin" });
    expect(grant.ok).toBeTrue();
    const standalone = await serviceContext("standalone");
    const resourceBound = await serviceContext("resource_bound");
    const oauth: MailRequestContext = {
      ...admin,
      actor: {
        ...admin.actor,
        delegation: { kind: "invocation", callingAppId: "mail", credentialKind: "oauth", invocationId: "keep-oauth-test" },
      },
    };
    const mandate: MailRequestContext = {
      ...cloudAdmin,
      actor: {
        ...cloudAdmin.actor,
        delegation: { kind: "invocation", callingAppId: "workflows", credentialKind: "mandate", invocationId: "keep-mandate-test" },
      },
    };
    for (const context of [admin, writer, agent, standalone, resourceBound, oauth, mandate]) {
      expect(await canLiftConversationKeeps(context)).toBeFalse();
      expect(await releaseConversationKeep(scope(id, context))).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Only a Cloud administrator can stop keeping a conversation",
        },
      });
    }
    expect(await listKeptConversations(mandate)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const grants =
      await sql`SELECT 1 FROM mail.mailbox_access mailbox_access JOIN auth.access access ON access.id = mailbox_access.access_id
      WHERE mailbox_access.mailbox_id = ${mailboxId}::uuid AND access.user_id = ${users[3]!.id}::uuid`;
    expect(grants).toHaveLength(0);
    expect(await canLiftConversationKeeps(cloudAdmin)).toBeTrue();
    expect(await releaseConversationKeep(scope(id, cloudAdmin))).toMatchObject({ ok: true, data: { released: true } });
    await keepConversation(scope(id, writer));
    const personalKey = await serviceContext("user_delegated");
    expect(await canLiftConversationKeeps(personalKey)).toBeTrue();
    expect(await releaseConversationKeep(scope(id, personalKey))).toMatchObject({ ok: true, data: { released: true } });
    for (const [context, actorUserId, outcome] of [
      [agent, null, "denied"],
      [personalKey, users[3]!.id, "allowed"],
    ] as const) {
      const rows = await sql`SELECT actor_user_id, outcome, target_id, metadata FROM audit.events
        WHERE request_id = ${context.requestId} AND action = 'mail.conversation.keep.release'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: actorUserId,
        outcome,
        target_id: id,
        metadata: {
          mailboxId,
          principal: {
            kind: "service_account",
            serviceAccountId: context.actor.kind === "service_account" ? context.actor.serviceAccount.id : "",
          },
        },
      });
    }

    await sql`UPDATE auth.users SET admin = false WHERE id = ${users[3]!.id}::uuid`;
    try {
      expect(await canLiftConversationKeeps(cloudAdmin)).toBeFalse();
    } finally {
      await sql`UPDATE auth.users SET admin = true WHERE id = ${users[3]!.id}::uuid`;
    }
  });

  test("keep, denied lift, view, export and lift write one audit event each with identity, target and reason", async () => {
    const id = await conversation();
    await message(id);
    const withRequest = (context: MailRequestContext, step: string): MailRequestContext => ({
      ...context,
      requestId: `keep-audit-${suffix}-${step}`,
    });
    const verify = async (context: MailRequestContext, action: string, outcome: string, reason: string | null = null) => {
      const rows =
        await sql`SELECT action, outcome, actor_user_id, target_type, target_id, metadata FROM audit.events WHERE request_id = ${context.requestId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action,
        outcome,
        actor_user_id: context.actor.kind === "user" ? context.actor.user.id : context.actor.delegatedUser?.id,
        target_type: "conversation",
        target_id: id,
        metadata: { mailboxId, principal: { kind: context.actor.kind } },
      });
      if (action === "mail.conversation.keep.release") expect(rows[0].metadata.reason).toBe(reason);
    };
    const deniedKeeper = withRequest(reader, "keep-denied");
    await keepConversation(scope(id, deniedKeeper));
    await verify(deniedKeeper, "mail.conversation.keep", "denied");
    const deniedViewer = withRequest(admin, "view-denied");
    await getKeptConversation(deniedViewer, { mailboxId, conversationId: id });
    await verify(deniedViewer, "mail.conversation.keep.view", "denied");
    const deniedExporter = withRequest(admin, "export-denied");
    await exportKeptConversations(deniedExporter, [{ mailboxId, conversationId: id }]);
    await verify(deniedExporter, "mail.conversation.keep.export", "denied");
    const keeper = withRequest(writer, "keep");
    await keepConversation(scope(id, keeper));
    await verify(keeper, "mail.conversation.keep", "allowed");
    const denied = withRequest(admin, "denied");
    await releaseConversationKeep(scope(id, denied));
    await verify(denied, "mail.conversation.keep.release", "denied");
    const viewer = withRequest(cloudAdmin, "view");
    const detail = await getKeptConversation(viewer, { mailboxId, conversationId: id });
    expect(detail).toMatchObject({
      ok: true,
      data: {
        document: { conversations: [{ subject: "Evidence" }] },
        history: expect.arrayContaining([expect.objectContaining({ outcome: "denied", actor: { label: "Keep admin" } })]),
      },
    });
    await verify(viewer, "mail.conversation.keep.view", "allowed");
    const exporter = withRequest(cloudAdmin, "export");
    const exported = await exportKeptConversations(exporter, [{ mailboxId, conversationId: id }]);
    if (!exported.ok) throw new Error(exported.error.message);
    await new Response(exported.data).text();
    await verify(exporter, "mail.conversation.keep.export", "allowed");
    const releaser = withRequest(cloudAdmin, "release");
    expect(await releaseConversationKeep({ ...scope(id, releaser), reason: "x".repeat(501) })).toMatchObject({
      ok: false,
      error: { code: "BAD_INPUT" },
    });
    expect(await releaseConversationKeep({ ...scope(id, releaser), reason: "  Legal review completed  " })).toMatchObject({
      ok: true,
      data: { released: true },
    });
    await verify(releaser, "mail.conversation.keep.release", "allowed", "Legal review completed");
    const [activity] =
      await sql`SELECT metadata FROM mail.activity_events WHERE conversation_id = ${id}::uuid AND action = 'conversation.keep_released'`;
    expect(activity.metadata.reason).toBe("Legal review completed");
    expect(await exportKeptConversations(cloudAdmin, [{ mailboxId, conversationId: id }])).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  test("admin list paginates ties, escapes search, rejects non-admins and includes soft-deleted mailboxes", async () => {
    const ids = [await conversation(), await conversation(), await conversation()];
    for (const id of ids) {
      await message(id);
      await keepConversation(scope(id));
    }
    await sql`UPDATE mail.conversation_keeps SET kept_at = '2026-10-09T10:00:00.123456Z'::timestamptz WHERE mailbox_id = ${mailboxId}::uuid`;
    expect(await listKeptConversations(admin)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await getKeptConversation(writer, { mailboxId, conversationId: ids[0]! })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await exportKeptConversations(writer, [{ mailboxId, conversationId: ids[0]! }])).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const first = await listKeptConversations(cloudAdmin, { q: suffix, limit: 2 });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.data.items).toHaveLength(2);
    expect(first.data.total).toBe(3);
    expect(first.data.nextCursor).not.toBeNull();
    // Each page of the list is a view of subjects and senders, so it is logged with the conversations it showed.
    const [listed] = await sql<{ outcome: string; actor_user_id: string; metadata: { query: string; conversations: unknown[] } }[]>`
      SELECT outcome, actor_user_id, metadata FROM audit.events
      WHERE request_id = ${cloudAdmin.requestId} AND action = 'mail.conversation.keep.list' ORDER BY id DESC LIMIT 1`;
    expect(listed).toMatchObject({ outcome: "allowed", actor_user_id: users[3]!.id, metadata: { query: suffix } });
    expect(listed!.metadata.conversations).toHaveLength(2);
    const second = await listKeptConversations(cloudAdmin, { q: suffix, limit: 2, cursor: first.data.nextCursor! });
    if (!second.ok) throw new Error(second.error.message);
    expect(second.data.items).toHaveLength(1);
    expect(second.data.nextCursor).toBeNull();
    expect(new Set([...first.data.items, ...second.data.items].map((item) => item.conversationId)).size).toBe(3);
    expect(await listKeptConversations(cloudAdmin, { q: "%" })).toMatchObject({ ok: true, data: { total: 0 } });
    await sql`UPDATE mail.conversations SET subject = 'Unique kept search' WHERE id = ${ids[0]}::uuid`;
    expect(await listKeptConversations(cloudAdmin, { q: "Unique kept search" })).toMatchObject({ ok: true, data: { total: 1 } });
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      SELECT message_id, 'from', 0, 'Witness Sender', 'witness@example.test', 'witness@example.test'
      FROM mail.conversation_messages WHERE conversation_id = ${ids[1]}::uuid`;
    expect(await listKeptConversations(cloudAdmin, { q: "witness@example.test" })).toMatchObject({
      ok: true,
      data: { total: 1, items: [{ sender: { name: "Witness Sender", address: "witness@example.test" } }] },
    });
    await sql`UPDATE mail.mailboxes SET deleted_at = now() WHERE id = ${mailboxId}::uuid`;
    try {
      expect(await listKeptConversations(cloudAdmin, { q: suffix })).toMatchObject({
        ok: true,
        data: { items: expect.arrayContaining([expect.objectContaining({ mailboxDeleted: true })]) },
      });
      expect((await getKeptConversation(cloudAdmin, { mailboxId, conversationId: ids[0]! })).ok).toBeTrue();
      for (const id of ids)
        expect(await releaseConversationKeep(scope(id, cloudAdmin))).toMatchObject({ ok: true, data: { released: true } });
    } finally {
      await sql`UPDATE mail.mailboxes SET deleted_at = NULL WHERE id = ${mailboxId}::uuid`;
    }
    expect(await listKeptConversations(cloudAdmin, { cursor: "bad" })).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
  });

  test("admin detail is bounded while full JSON export crosses message keyset batches", async () => {
    const id = await conversation();
    for (let position = 0; position < 51; position++) await message(id);
    await keepConversation(scope(id, writer));
    try {
      const detail = await getKeptConversation(cloudAdmin, { mailboxId, conversationId: id });
      expect(detail).toMatchObject({ ok: true, data: { messageCount: 51, messagesTruncated: true } });
      if (!detail.ok) throw new Error(detail.error.message);
      expect(detail.data.document.conversations[0]?.messages).toHaveLength(50);
      const exported = await exportKeptConversations(cloudAdmin, [{ mailboxId, conversationId: id }]);
      if (!exported.ok) throw new Error(exported.error.message);
      const document = KeptConversationExportSchema.parse(await new Response(exported.data).json());
      expect(document.conversations[0]?.messages).toHaveLength(51);
      expect(new Set(document.conversations[0]?.messages.map((item) => item.id)).size).toBe(51);
      expect(document.conversations[0]?.messages.every((message) => message.delivery === null)).toBeTrue();
      // A merge between two message batches must fail the download, never end it as valid but incomplete JSON.
      const moving = await exportKeptConversations(cloudAdmin, [{ mailboxId, conversationId: id }]);
      if (!moving.ok) throw new Error(moving.error.message);
      const reader = moving.data.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while ((text.match(/"messageId"/g)?.length ?? 0) < 10) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Export ended before the merge");
        text += decoder.decode(chunk.value);
      }
      const target = await conversation();
      await sql`UPDATE mail.conversation_messages SET conversation_id = ${target}::uuid WHERE conversation_id = ${id}::uuid`;
      try {
        let failure: unknown = null;
        try {
          while (!(await reader.read()).done);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
      } finally {
        await sql`UPDATE mail.conversation_messages SET conversation_id = ${id}::uuid WHERE conversation_id = ${target}::uuid`;
        await releaseConversationKeep(scope(target, cloudAdmin));
      }
      const missing = await conversation();
      expect(
        await exportKeptConversations(cloudAdmin, [
          { mailboxId, conversationId: id },
          { mailboxId, conversationId: missing },
        ]),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    } finally {
      await releaseConversationKeep(scope(id, cloudAdmin));
    }
  });

  test("canceling an unsent outgoing message preserves its kept contents and keep row", async () => {
    const id = await conversation();
    const original = await message(id);
    const item = await message(id);
    await sql`UPDATE mail.message_contents SET internal_date = '2026-10-09T10:00:00Z' WHERE id = ${original.id}::uuid`;
    await sql`UPDATE mail.message_contents SET hydration_status = 'body', internal_date = '2026-10-10T10:00:00Z' WHERE id = ${item.id}::uuid`;
    await sql`UPDATE mail.conversations SET latest_message_at = '2026-10-10T10:00:00Z' WHERE id = ${id}::uuid`;
    await keepConversation(scope(id, writer));
    const [beforeCancel] = await sql<{ revision: string | number }[]>`SELECT revision FROM mail.conversations WHERE id = ${id}::uuid`;
    const rollback = new Error("Rollback outbound cancellation fixture");
    await expect(
      sql.begin(async (db) => {
        await db`DELETE FROM mail.remote_message_refs WHERE id = ${item.refId}::uuid`;
        const [resource] = await db<
          { remote_resource_id: string }[]
        >`SELECT remote_resource_id FROM mail.folders WHERE id = ${folderId}::uuid`;
        const [connection] = await db<{ id: string }[]>`INSERT INTO mail.provider_connections
        (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, status)
        VALUES (${mailboxId}::uuid, 'Keep fixture', 'sender@example.test', 'sender', 'imap.example.test', 993, 'implicit', 'smtp.example.test', 465, 'implicit', 'password', 'revoked') RETURNING id`;
        const [binding] = await db<{ id: string }[]>`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, remote_locator)
        VALUES (${resource!.remote_resource_id}::uuid, ${connection!.id}::uuid, '{}'::jsonb) RETURNING id`;
        const [identity] = await db<{ id: string }[]>`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, from_address)
        VALUES (${newShortId()}, ${mailboxId}::uuid, 'Keep fixture', 'sender@example.test') RETURNING id`;
        const [draft] = await db<
          { id: string }[]
        >`INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${identity!.id}::uuid, 'user', ${users[1]!.id}::uuid, 'user', ${users[1]!.id}::uuid) RETURNING id`;
        const [command] = await db<{ id: string }[]>`INSERT INTO mail.commands
        (mailbox_id, kind, actor_kind, actor_id, access_subject_kind, access_subject_id, idempotency_key, request_hash, target, payload)
        VALUES (${mailboxId}::uuid, 'send', 'user', ${users[1]!.id}::uuid, 'user', ${users[1]!.id}::uuid, ${`kept-outbound-${suffix}`}, ${"a".repeat(64)}, '{}'::jsonb, '{}'::jsonb) RETURNING id`;
        const [outbox] = await db<{ id: string }[]>`INSERT INTO mail.outbox_submissions
        (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id, message_id, requested_at, mime_date)
        SELECT ${newShortId()}, ${mailboxId}::uuid, ${draft!.id}::uuid, command.id, ${identity!.id}::uuid, ${binding!.id}::uuid,
          '<kept-unsent@example.test>', ${item.id}::uuid, command.created_at, command.created_at FROM mail.commands command WHERE command.id = ${command!.id}::uuid RETURNING id`;
        await db`UPDATE mail.outbox_submissions SET state = 'cancelled' WHERE id = ${outbox!.id}::uuid`;
        await removeUnsentOutboundMessage(db, outbox!.id);
        const [afterCancel] = await db<
          { revision: string | number; latest_message_at: Date }[]
        >`SELECT revision, latest_message_at FROM mail.conversations WHERE id = ${id}::uuid`;
        expect(Number(afterCancel!.revision)).toBe(Number(beforeCancel!.revision) + 1);
        expect(afterCancel!.latest_message_at.toISOString()).toBe("2026-10-09T10:00:00.000Z");
        expect(await db`SELECT 1 FROM mail.conversation_keeps WHERE conversation_id = ${id}::uuid`).toHaveLength(1);
        expect(await db`SELECT 1 FROM mail.message_contents WHERE id = ${item.id}::uuid`).toHaveLength(1);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    await releaseConversationKeep(scope(id, cloudAdmin));
  });

  test("keep prioritizes only the bounded newest incomplete messages", async () => {
    const id = await conversation();
    const rows = Array.from({ length: MAX_CONVERSATION_ACTION_MESSAGES + 1 }, (_, index) => ({
      short_id: newShortId(),
      mailbox_id: mailboxId,
      subject: "Hydration evidence",
      internal_date: new Date(Date.UTC(2026, 9, 9, 10, 0, index)),
      size_bytes: 1,
      content_hash: crypto.randomUUID().replaceAll("-", "").repeat(2),
      hydration_status: "envelope",
    }));
    const inserted = await sql<
      { id: string; internal_date: Date }[]
    >`INSERT INTO mail.message_contents ${sql(rows, "short_id", "mailbox_id", "subject", "internal_date", "size_bytes", "content_hash", "hydration_status")} RETURNING id, internal_date`;
    for (const [position, row] of inserted.entries())
      await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position) VALUES (${id}::uuid, ${row.id}::uuid, ${position})`;
    const enqueue = spyOn(syncRuntime, "enqueueMessageHydration").mockResolvedValue(undefined);
    try {
      expect((await keepConversation(scope(id))).ok).toBeTrue();
      const expected = inserted
        .sort((left, right) => right.internal_date.getTime() - left.internal_date.getTime())
        .slice(0, MAX_CONVERSATION_ACTION_MESSAGES)
        .map((row) => row.id);
      expect(enqueue.mock.calls.map((call) => call[0])).toEqual(expected);
    } finally {
      enqueue.mockRestore();
    }
    await releaseConversationKeep(scope(id, cloudAdmin));
  });

  test("keeping gives a message whose loading failed its tries back, but not one over the size limit", async () => {
    const id = await conversation();
    const failed = await message(id);
    const tooLarge = await message(id);
    for (const [item, code] of [
      [failed, "NoConnection"],
      [tooLarge, "MESSAGE_TOO_LARGE"],
    ] as const)
      await sql`UPDATE mail.message_contents SET hydration_status = 'failed', hydration_attempt = 5, hydration_error_code = ${code}, plain_text = NULL
        WHERE id = ${item.id}::uuid`;
    const enqueue = spyOn(syncRuntime, "enqueueMessageHydration").mockResolvedValue(undefined);
    try {
      expect((await keepConversation(scope(id))).ok).toBeTrue();
      expect(enqueue.mock.calls.map((call) => call[0])).toEqual([failed.id]);
    } finally {
      enqueue.mockRestore();
    }
    const states = await sql`SELECT id, hydration_status, hydration_attempt, hydration_error_code FROM mail.message_contents
      WHERE id IN (${failed.id}::uuid, ${tooLarge.id}::uuid)`;
    expect(states).toContainEqual({ id: failed.id, hydration_status: "envelope", hydration_attempt: 0, hydration_error_code: null });
    expect(states).toContainEqual({
      id: tooLarge.id,
      hydration_status: "failed",
      hydration_attempt: 5,
      hydration_error_code: "MESSAGE_TOO_LARGE",
    });
    await releaseConversationKeep(scope(id, cloudAdmin));
  });

  test("a kept message's original source and attachment stay downloadable after the server deleted it", async () => {
    const id = await conversation();
    const item = await message(id);
    const [content] = await sql<{ message_id: string }[]>`SELECT message_id FROM mail.message_contents WHERE id = ${item.id}::uuid`;
    const attachment = `Signed order ${suffix}`;
    const source = Buffer.from(
      [
        `Message-ID: ${content!.message_id}`,
        "Date: Fri, 09 Oct 2026 10:00:00 +0000",
        "From: Customer <customer@example.test>",
        "To: Team <team@example.test>",
        "Subject: Evidence",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="keep-boundary"',
        "",
        "--keep-boundary",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "The customer was informed.",
        "--keep-boundary",
        'Content-Type: text/plain; name="order.txt"',
        'Content-Disposition: attachment; filename="order.txt"',
        "",
        attachment,
        "--keep-boundary--",
        "",
      ].join("\r\n"),
    );
    await sql`UPDATE mail.message_contents SET hydration_status = 'envelope', plain_text = NULL WHERE id = ${item.id}::uuid`;
    // Envelope ingestion stores addresses; body hydration deliberately keeps that envelope unchanged.
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${item.id}::uuid, 'from', 0, 'Customer', 'customer@example.test', 'customer@example.test')`;
    expect((await hydrateMessageFromSource({ messageId: item.id, source: Readable.from([source]) })).status).toBe("hydrated");
    blobIds.push(
      ...(
        await sql<{ id: string }[]>`
          SELECT source_blob_id AS id FROM mail.message_contents WHERE id = ${item.id}::uuid AND source_blob_id IS NOT NULL
          UNION SELECT blob_id FROM mail.message_parts WHERE message_id = ${item.id}::uuid AND blob_id IS NOT NULL
          UNION SELECT blob_id FROM mail.attachments WHERE message_id = ${item.id}::uuid`
      ).map((row) => row.id),
    );
    expect((await keepConversation(scope(id))).ok).toBeTrue();
    await sql.begin(async (db) => {
      await db`UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${item.refId}::uuid`;
      await db`UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${item.refId}::uuid`;
      await keepLastKeptPlacements(db, [item.refId]);
    });
    const read = async (blobId: string) => {
      const chunks: Buffer[] = [];
      for await (const chunk of createBlobReadable(blobId)) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    };
    const exported = await openMessageSource({ context: reader, mailboxId, messageId: item.id });
    if (!exported.ok) throw new Error(exported.error.message);
    expect((await read(exported.data.blobId)).equals(source)).toBeTrue();
    const [stored] = await sql<{ id: string }[]>`SELECT id FROM mail.attachments WHERE message_id = ${item.id}::uuid`;
    setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    try {
      const exported = await exportKeptConversations(cloudAdmin, [{ mailboxId, conversationId: id }]);
      if (!exported.ok) throw new Error(exported.error.message);
      const text = await new Response(exported.data).text();
      const document = KeptConversationExportSchema.parse(JSON.parse(text));
      expect(document.exportedAt).toBe("2026-10-09T12:00:00.000Z");
      expect(document.conversations).toHaveLength(1);
      expect(document.conversations[0]?.messages[0]?.attachments).toEqual([
        {
          id: expect.stringMatching(/^[A-Za-z0-9]{6}$/),
          filename: "order.txt",
          contentType: "text/plain",
          size: Buffer.byteLength(attachment),
          inline: false,
          contentId: null,
        },
      ]);
      expect(document.conversations[0]?.messages[0]?.from).toEqual([{ name: "Customer", address: "customer@example.test" }]);
      for (const internalId of [id, mailboxId, item.id, stored!.id, ...blobIds]) expect(text).not.toContain(internalId);
      expect(text).not.toContain('"bytes"');
      expect(text).not.toContain('"blobId"');
    } finally {
      setSystemTime();
    }
    const opened = await openAttachment({ context: reader, mailboxId, messageId: item.id, attachmentId: stored!.id });
    if (!opened.ok) throw new Error(opened.error.message);
    expect((await read(opened.data.blobId)).toString("utf8")).toBe(attachment);
    expect(await getMessage({ context: reader, mailboxId, messageId: item.id })).toMatchObject({
      ok: true,
      data: { deletedOnServer: true, plainText: expect.stringContaining("The customer was informed.") },
    });
    await releaseConversationKeep(scope(id, cloudAdmin));
  });

  test("kept view, counts and structured search include hidden folders", async () => {
    const id = await conversation();
    await message(id);
    expect((await keepConversation(scope(id))).ok).toBeTrue();
    const listed = await listConversations({ context: reader, mailboxId, view: "kept" });
    expect(listed).toMatchObject({ ok: true, data: { items: [{ id, kept: true }] } });
    expect(await getConversationViewCounts({ context: reader, mailboxId })).toMatchObject({ ok: true, data: { kept: 1 } });
    const found = await searchMessages({
      context: reader,
      mailboxId,
      request: { expression: { type: "kept" }, sort: "newest", limit: 50 },
    });
    expect(found).toMatchObject({ ok: true, data: { items: [{ conversationId: id, kept: true }] } });
    await releaseConversationKeep(scope(id, cloudAdmin));
  });

  test("the last vanished placement stays visible, reappearing copy retires it, release hides it without deleting contents", async () => {
    const id = await conversation();
    const item = await message(id);
    await keepConversation(scope(id));
    await sql.begin(async (db) => {
      await db`UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${item.refId}::uuid`;
      await db`UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${item.refId}::uuid`;
      await keepLastKeptPlacements(db, [item.refId]);
    });
    expect(await getMessage({ context: reader, mailboxId, messageId: item.id })).toMatchObject({
      ok: true,
      data: { deletedOnServer: true, plainText: "Evidence body" },
    });
    const [newRef] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${item.id}::uuid, 1, ${nextUid++}) RETURNING id`;
    await sql.begin(async (db) => {
      await db`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id) VALUES (${newRef!.id}::uuid, ${folderId}::uuid, ${item.id}::uuid)`;
      await retireKeptCopyPlacements(db, [{ messageId: item.id, remoteRefId: newRef!.id }]);
    });
    expect(await getMessage({ context: reader, mailboxId, messageId: item.id })).toMatchObject({
      ok: true,
      data: { deletedOnServer: false },
    });
    const [old] =
      await sql`SELECT deleted_at IS NOT NULL AS hidden FROM mail.message_placements WHERE remote_message_ref_id = ${item.refId}::uuid`;
    expect(old.hidden).toBeTrue();
    await sql.begin(async (db) => {
      await db`UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${newRef!.id}::uuid`;
      await db`UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${newRef!.id}::uuid`;
      await keepLastKeptPlacements(db, [newRef!.id]);
    });
    await releaseConversationKeep(scope(id, cloudAdmin));
    const live = await sql`SELECT 1 FROM mail.message_placements WHERE message_id = ${item.id}::uuid AND deleted_at IS NULL`;
    expect(live).toHaveLength(0);
    expect(await sql<{ plain_text: string }[]>`SELECT plain_text FROM mail.message_contents WHERE id = ${item.id}::uuid`).toEqual([
      { plain_text: "Evidence body" },
    ]);
  });

  test("later replies are protected and raw queued state additions cannot mark them deleted", async () => {
    const id = await conversation();
    await message(id);
    await keepConversation(scope(id));
    const reply = await message(id);
    expect(
      await sql.begin((db) => checkCommandKeepProtection(db, { kind: "delete", target: { remoteMessageRefId: reply.refId }, payload: {} })),
    ).toMatchObject({ ok: false, error: { code: "CONVERSATION_KEPT" } });
    expect(
      await sql.begin((db) =>
        checkCommandKeepProtection(db, {
          kind: "change_message_state",
          target: { remoteMessageRefId: reply.refId },
          payload: { addFlags: ["\\dElEtEd"] },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "CONVERSATION_KEPT" } });
    await releaseConversationKeep(scope(id, cloudAdmin));
  });

  test("restoring a kept message reads only its own rows, also while statistics lag behind a bulk import or cleanup", async () => {
    const id = await conversation();
    const importedItem = await message(id);
    const refilledItem = await message(id);
    const other = await message(await conversation());
    expect((await keepConversation(scope(id))).ok).toBeTrue();
    const rollback = new Error("Roll back the bulk import");
    const checkShape = async (
      shape: "imported after ANALYZE" | "emptied and refilled after ANALYZE",
      item: Awaited<ReturnType<typeof message>>,
    ) => {
      let rowsRead = Infinity;
      let visible = false;
      const transaction = sql.begin(async (db) => {
        const insertBulk = async (uidOffset: number) => {
          await db`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
            SELECT ${folderId}::uuid, ${other.id}::uuid, 1, ${uidOffset} + item FROM generate_series(1, 25000) AS item`;
          await db`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
            SELECT id, folder_id, message_id FROM mail.remote_message_refs WHERE folder_id = ${folderId}::uuid AND uid > ${uidOffset}`;
        };
        if (shape === "emptied and refilled after ANALYZE") {
          await insertBulk(1000000);
          await db`DELETE FROM mail.message_placements placement USING mail.remote_message_refs ref
            WHERE placement.remote_message_ref_id = ref.id AND ref.folder_id = ${folderId}::uuid AND ref.uid > 1000000`;
          await db`DELETE FROM mail.remote_message_refs WHERE folder_id = ${folderId}::uuid AND uid > 1000000`;
        }
        // Statistics taken before the import or after the emptying, as autovacuum leaves them until
        // it gets to the table. It cannot see this transaction's rows, so they stay that way.
        await db.unsafe("ANALYZE mail.remote_message_refs");
        await db.unsafe("ANALYZE mail.message_placements");
        await insertBulk(shape === "imported after ANALYZE" ? 1000000 : 2000000);
        await db`UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${item.refId}::uuid`;
        await db`UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${item.refId}::uuid`;
        const reads = async () => {
          const [row] = await db<{ rows: number }[]>`
            SELECT sum(seq_tup_read + idx_tup_fetch)::int AS rows FROM pg_stat_xact_user_tables
            WHERE schemaname = 'mail' AND relname IN ('message_placements', 'remote_message_refs')`;
          return row!.rows;
        };
        const before = await reads();
        await keepLastKeptPlacements(db, [item.refId]);
        rowsRead = (await reads()) - before;
        const [placement] = await db<{ visible: boolean }[]>`
          SELECT deleted_at IS NULL AS visible FROM mail.message_placements WHERE remote_message_ref_id = ${item.refId}::uuid`;
        visible = placement!.visible;
        // Roll back so the run database keeps no bulk rows.
        throw rollback;
      });
      await expect(transaction).rejects.toBe(rollback);
      expect(rowsRead).toBeLessThan(100);
      expect(visible).toBe(true);
    };
    await checkShape("imported after ANALYZE", importedItem);
    await checkShape("emptied and refilled after ANALYZE", refilledItem);
    await releaseConversationKeep(scope(id, cloudAdmin));
  });

  test("split, merge and reassign carry the original keeper and timestamp", async () => {
    const source = await conversation();
    const first = await message(source);
    const second = await message(source);
    await message(source);
    const kept = await keepConversation(scope(source, writer));
    if (!kept.ok) throw new Error(kept.error.message);
    const split = await splitConversation({
      ...scope(source, writer),
      input: { messageIds: [second.id], expectedRevision: 1, confirm: true },
    });
    if (!split.ok) throw new Error(split.error.message);
    expect(await getConversationKeep(scope(split.data.created.id))).toEqual({
      ok: true,
      data: { ...kept.data, conversationId: split.data.created.id },
    });
    const target = await conversation();
    await message(target);
    const merged = await mergeConversations({
      context: writer,
      mailboxId,
      targetConversationId: target,
      input: { sourceConversationId: split.data.created.id, expectedTargetRevision: 1, expectedSourceRevision: 1, confirm: true },
    });
    if (!merged.ok) throw new Error(merged.error.message);
    expect(await getConversationKeep(scope(target))).toEqual({ ok: true, data: { ...kept.data, conversationId: target } });
    expect(await sql`SELECT 1 FROM mail.conversation_keeps WHERE conversation_id = ${split.data.created.id}::uuid`).toHaveLength(0);
    const destination = await conversation();
    await message(destination);
    const moved = await reassignConversationMessage({
      context: writer,
      mailboxId,
      sourceConversationId: source,
      messageId: first.id,
      input: {
        targetConversationId: destination,
        expectedSourceRevision: split.data.source.revision,
        expectedTargetRevision: 1,
        confirm: true,
      },
    });
    if (!moved.ok) throw new Error(moved.error.message);
    expect(await getConversationKeep(scope(destination))).toEqual({ ok: true, data: { ...kept.data, conversationId: destination } });
    // Each conversation the keep reached names who moved the kept messages there, and from where. The split's
    // conversation was merged later, so its activity moved along into the merge target.
    const carried = async (conversationId: string) =>
      sql<{ actor_id: string; carried_from: string }[]>`SELECT actor_id, metadata->>'carriedFrom' AS carried_from
        FROM mail.activity_events
        WHERE conversation_id = ${conversationId}::uuid AND action = 'conversation.kept' AND metadata ? 'carriedFrom'
        ORDER BY id`;
    expect(await carried(target)).toEqual([
      { actor_id: users[1]!.id, carried_from: source },
      { actor_id: users[1]!.id, carried_from: split.data.created.id },
    ]);
    expect(await carried(destination)).toEqual([{ actor_id: users[1]!.id, carried_from: source }]);
    for (const [conversationId, carriedFrom] of [
      [split.data.created.id, source],
      [target, split.data.created.id],
      [destination, source],
    ] as const) {
      expect(
        await sql<
          { actor_user_id: string; carried_from: string }[]
        >`SELECT actor_user_id, metadata->>'carriedFrom' AS carried_from FROM audit.events
          WHERE target_id = ${conversationId} AND action = 'mail.conversation.keep'`,
      ).toEqual([{ actor_user_id: users[1]!.id, carried_from: carriedFrom }]);
    }
  });
});
