import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { MAX_CONVERSATION_ACTION_MESSAGES } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { checkCommandKeepProtection, keepLastKeptPlacements, retireKeptCopyPlacements } from "./conversation-keep-rules";
import { getConversationKeep, keepConversation, releaseConversationKeep } from "./conversation-keeps";
import { mergeConversations, reassignConversationMessage, splitConversation } from "./conversations";
import { createMailbox } from "./mailboxes";
import { getConversationViewCounts, getMessage, listConversations } from "./messages";
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
  let writer: MailRequestContext;
  let reader: MailRequestContext;
  let mailboxId = "";
  let folderId = "";
  let nextUid = 1;
  beforeAll(async () => {
    await migrate();
    await migrate();
    for (const role of ["admin", "writer", "reader"]) {
      const [user] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`keep-${role}-${suffix}`}, 'local', 'user', ${`Keep ${role}`}, false) RETURNING id, uid`;
      if (!user) throw new Error("Keep fixture user missing");
      users.push(user);
    }
    admin = contextFor(users[0]!);
    writer = contextFor(users[1]!);
    reader = contextFor(users[2]!);
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
    for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
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

  test("read cannot keep; write keeps idempotently; only admin releases, with audit and timeline", async () => {
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
    expect(await releaseConversationKeep(scope(id))).toEqual({ ok: true, data: { conversationId: id, released: true } });
    expect(await releaseConversationKeep(scope(id))).toEqual({ ok: true, data: { conversationId: id, released: false } });
    const activity =
      await sql`SELECT action, actor_id, outcome, target_type FROM mail.activity_events WHERE conversation_id = ${id}::uuid ORDER BY id`;
    expect(activity).toEqual([
      { action: "conversation.kept", actor_id: users[1]!.id, outcome: "confirmed", target_type: "conversation" },
      { action: "conversation.keep_released", actor_id: users[0]!.id, outcome: "confirmed", target_type: "conversation" },
    ]);
    const audit = await sql`SELECT action, actor_user_id FROM audit.events WHERE target_id = ${id} ORDER BY id`;
    expect(audit).toEqual([
      { action: "mail.conversation.keep", actor_user_id: users[1]!.id },
      { action: "mail.conversation.keep.release", actor_user_id: users[0]!.id },
    ]);
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
    await releaseConversationKeep(scope(id));
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
    await releaseConversationKeep(scope(id));
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
      await retireKeptCopyPlacements(db, item.id, newRef!.id);
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
    await releaseConversationKeep(scope(id));
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
    await releaseConversationKeep(scope(id));
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
  });
});
