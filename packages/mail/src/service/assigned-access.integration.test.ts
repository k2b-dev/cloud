import { afterAll, beforeAll, expect, test } from "bun:test";
import type { LiveViewer } from "@k2b/cloud/events";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import {
  getMailboxAccess,
  getMailboxAccesses,
  getMailboxPermission,
  grantMailboxAccess,
  listMailboxAccess,
  type MailboxAccess,
  requireMailboxAccess,
  requireMailboxPermission,
  requireVisibleConversation,
  requireVisibleMessages,
  revokeMailboxAccess,
  updateMailboxAccess,
} from "./access";
import type { MailRequestContext } from "./auth";
import { mailLiveChannels } from "./live-channels";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

type TestUser = { id: string; uid: string; context: MailRequestContext; viewer: LiveViewer };

/**
 * Access to assigned conversations only: who holds it, what it may become, and that every path
 * which asks for mailbox-wide permission refuses it. The per-path proofs live next to each path.
 */
suite("mail access to assigned conversations", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const groupIds: string[] = [];
  let owner: TestUser;
  let assignedReader: TestUser;
  let groupMember: TestUser;
  let outsider: TestUser;
  let groupId = "";
  let mailboxId = "";
  const conversations: Array<{ id: string; messageId: string }> = [];

  const createUser = async (role: string): Promise<TestUser> => {
    const uid = `mail-assigned-${role}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${role}, false)
      RETURNING id
    `;
    userIds.push(row!.id);
    const actor = {
      kind: "user",
      user: { id: row!.id, uid, provider: "local", profile: "user", displayName: role, roles: ["user"], memberofGroupIds: [] },
    } as unknown as MailRequestContext["actor"];
    const accessSubject = { type: "user", userId: row!.id } as const;
    return {
      id: row!.id,
      uid,
      context: { actor, accessSubject, requestId: `mail-assigned-${role}` },
      viewer: { id: `user:${row!.id}`, actor, accessSubject, scopes: [] },
    };
  };

  const createConversation = async (subject: string) => {
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, 'customer@example.com', now())
      RETURNING id
    `;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.com>`}, ${subject}, now(), 1, ${new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex")}, 'complete')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 0)
    `;
    return { id: conversation!.id, messageId: message!.id };
  };

  const assign = (conversationId: string, userId: string) =>
    sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${conversationId}::uuid, ${userId}::uuid)`;

  beforeAll(async () => {
    await migrate();
    owner = await createUser("owner");
    assignedReader = await createUser("reader");
    groupMember = await createUser("member");
    outsider = await createUser("outsider");
    const groupName = `mail-assigned-${suffix}`;
    const [group] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name) VALUES (${groupName}, 'local', ${groupName}) RETURNING id
    `;
    groupId = group!.id;
    groupIds.push(groupId);
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${groupMember.id}::uuid, ${groupId}::uuid)`;
    const mailbox = await createMailbox(owner.context, { name: `Assigned ${suffix}`, description: "Disposable access fixture" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    conversations.push(await createConversation("Assigned"), await createConversation("Not assigned"));
  });

  afterAll(async () => {
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    await sql`
      DELETE FROM auth.access
      WHERE user_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))
         OR group_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${groupIds}::jsonb))
    `;
    await sql`DELETE FROM auth.groups WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${groupIds}::jsonb))`;
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  });

  test("an assigned-only grant is no mailbox-wide permission, and resolves to its person's assignments", async () => {
    const granted = await grantMailboxAccess({
      context: owner.context,
      mailboxId,
      principal: { type: "user", userId: assignedReader.id },
      permission: "read",
      scope: "assigned",
    });
    expect(granted.ok && granted.data.scope).toBe("assigned");
    const viaGroup = await grantMailboxAccess({
      context: owner.context,
      mailboxId,
      principal: { type: "group", groupId },
      permission: "write",
      scope: "assigned",
    });
    expect(viaGroup.ok).toBe(true);

    expect(await getMailboxPermission(assignedReader.context, mailboxId)).toBe("none");
    expect((await requireMailboxPermission(assignedReader.context, mailboxId, "read")).ok).toBe(false);
    expect(await getMailboxAccess(assignedReader.context, mailboxId)).toEqual({
      scope: "assigned",
      permission: "read",
      userId: assignedReader.id,
    });
    expect((await requireMailboxAccess(assignedReader.context, mailboxId, "write")).ok).toBe(false);
    expect(await getMailboxAccess(groupMember.context, mailboxId)).toEqual({
      scope: "assigned",
      permission: "write",
      userId: groupMember.id,
    });
    expect(await getMailboxAccess(outsider.context, mailboxId)).toBeNull();
    expect(await getMailboxAccess(owner.context, mailboxId)).toEqual({ scope: "mailbox", permission: "admin" });

    const listed = await listMailboxAccess(owner.context, mailboxId);
    if (!listed.ok) throw new Error(listed.error.message);
    // Managers first; assigned-only grants after every mailbox-wide one.
    expect(listed.data.map((entry) => [entry.permission, entry.scope ?? "mailbox"])).toEqual([
      ["admin", "mailbox"],
      ["write", "assigned"],
      ["read", "assigned"],
    ]);
    // Only managers list access; an assigned-only grant never manages.
    expect((await listMailboxAccess(groupMember.context, mailboxId)).ok).toBe(false);
  });

  test("assigned-only grants allow read or write for people and groups, once per principal", async () => {
    const admin = await grantMailboxAccess({
      context: owner.context,
      mailboxId,
      principal: { type: "user", userId: outsider.id },
      permission: "admin",
      scope: "assigned",
    });
    expect(admin.ok ? null : admin.error.status).toBe(400);
    const everyone = await grantMailboxAccess({
      context: owner.context,
      mailboxId,
      principal: { type: "authenticated" },
      permission: "read",
      scope: "assigned",
    });
    expect(everyone.ok ? null : everyone.error.status).toBe(400);
    // The principal already holds an assigned-only grant; a second grant in the other scope conflicts.
    const twice = await grantMailboxAccess({
      context: owner.context,
      mailboxId,
      principal: { type: "user", userId: assignedReader.id },
      permission: "write",
    });
    expect(twice.ok ? null : twice.error.status).toBe(409);
    // An assigned-only grant cannot add or change access.
    const byAssigned = await grantMailboxAccess({
      context: groupMember.context,
      mailboxId,
      principal: { type: "user", userId: outsider.id },
      permission: "read",
      scope: "assigned",
    });
    expect(byAssigned.ok).toBe(false);
  });

  test("a grant moves between scopes, and the last administrator cannot move to assigned conversations", async () => {
    const entries = async () => {
      const listed = await listMailboxAccess(owner.context, mailboxId);
      if (!listed.ok) throw new Error(listed.error.message);
      return listed.data;
    };
    const readerEntry = (await entries()).find((entry) => entry.principal.type === "user" && entry.principal.userId === assignedReader.id)!;
    const ownerEntry = (await entries()).find((entry) => entry.principal.type === "user" && entry.principal.userId === owner.id)!;

    expect(
      (await updateMailboxAccess({ context: owner.context, mailboxId, accessId: readerEntry.id, permission: "write", scope: "mailbox" }))
        .ok,
    ).toBe(true);
    expect(await getMailboxAccess(assignedReader.context, mailboxId)).toEqual({ scope: "mailbox", permission: "write" });
    // Omitting the scope keeps it.
    expect((await updateMailboxAccess({ context: owner.context, mailboxId, accessId: readerEntry.id, permission: "read" })).ok).toBe(true);
    expect(await getMailboxAccess(assignedReader.context, mailboxId)).toEqual({ scope: "mailbox", permission: "read" });
    const tooMuch = await updateMailboxAccess({
      context: owner.context,
      mailboxId,
      accessId: readerEntry.id,
      permission: "admin",
      scope: "assigned",
    });
    expect(tooMuch.ok).toBe(false);
    expect(
      (await updateMailboxAccess({ context: owner.context, mailboxId, accessId: readerEntry.id, permission: "read", scope: "assigned" }))
        .ok,
    ).toBe(true);
    expect(await getMailboxAccess(assignedReader.context, mailboxId)).toEqual({
      scope: "assigned",
      permission: "read",
      userId: assignedReader.id,
    });

    const lastAdmin = await updateMailboxAccess({
      context: owner.context,
      mailboxId,
      accessId: ownerEntry.id,
      permission: "write",
      scope: "assigned",
    });
    expect(lastAdmin.ok).toBe(false);
    expect(await getMailboxAccess(owner.context, mailboxId)).toEqual({ scope: "mailbox", permission: "admin" });

    const [rows] = await sql<{ mailbox: number; assigned: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid) AS mailbox,
        (SELECT COUNT(*)::int FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid) AS assigned
    `;
    expect(rows).toEqual({ mailbox: 1, assigned: 2 });
  });

  test("visibility follows the assignment: only assigned conversations and their messages", async () => {
    const [assigned, other] = conversations as [{ id: string; messageId: string }, { id: string; messageId: string }];
    const access = (await getMailboxAccess(assignedReader.context, mailboxId)) as MailboxAccess;
    expect((await requireVisibleConversation(access, assigned.id)).ok).toBe(false);
    await assign(assigned.id, assignedReader.id);
    expect((await requireVisibleConversation(access, assigned.id)).ok).toBe(true);
    const hidden = await requireVisibleConversation(access, other.id);
    // Not found, never forbidden: a reader of assigned conversations learns nothing about the others.
    expect(hidden.ok ? null : hidden.error.status).toBe(404);
    expect((await requireVisibleMessages(access, [assigned.messageId])).ok).toBe(true);
    expect((await requireVisibleMessages(access, [assigned.messageId, other.messageId])).ok).toBe(false);
    // Another person's assignment shows nothing to this one.
    const memberAccess = (await getMailboxAccess(groupMember.context, mailboxId)) as MailboxAccess;
    expect((await requireVisibleConversation(memberAccess, assigned.id)).ok).toBe(false);
    // Mailbox-wide access sees everything.
    expect((await requireVisibleConversation({ scope: "mailbox", permission: "read" }, other.id)).ok).toBe(true);
  });

  test("live updates: assigned-only readers follow their own key, never the mailbox key", async () => {
    const viewers = [owner.viewer, assignedReader.viewer, groupMember.viewer, outsider.viewer];
    const accesses = await getMailboxAccesses(mailboxId, viewers);
    expect(accesses).toEqual([
      { scope: "mailbox", permission: "admin" },
      { scope: "assigned", permission: "read", userId: assignedReader.id },
      { scope: "assigned", permission: "write", userId: groupMember.id },
      null,
    ]);
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    const scope = { mailbox: mailbox!.short_id };
    expect(await mailLiveChannels.mailbox.keys(scope, owner.viewer)).toEqual([mailboxId]);
    expect(await mailLiveChannels.mailbox.keys(scope, assignedReader.viewer)).toEqual([
      `${mailboxId}:${assignedReader.id}`,
      `${mailboxId}:assigned`,
    ]);
    expect(await mailLiveChannels.mailbox.keys(scope, outsider.viewer)).toBeNull();
    const admitted = async (key: string) => [...(await mailLiveChannels.mailbox.authorize(key, viewers))].sort();
    expect(await admitted(mailboxId)).toEqual([owner.viewer.id]);
    expect(await admitted(`${mailboxId}:${assignedReader.id}`)).toEqual([assignedReader.viewer.id]);
    expect(await admitted(`${mailboxId}:assigned`)).toEqual([assignedReader.viewer.id, groupMember.viewer.id].sort());
    // A forged key of another mailbox or person admits nobody.
    expect(await admitted(`${mailboxId}:${groupMember.id}`)).toEqual([groupMember.viewer.id]);
    expect(await admitted(`${crypto.randomUUID()}:${assignedReader.id}`)).toEqual([]);
  });

  test("live updates of a conversation reach its assignees' keys; mailbox-wide updates the shared key", async () => {
    const [assigned] = conversations as [{ id: string; messageId: string }];
    const [conversation] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.conversations WHERE id = ${assigned.id}::uuid`;
    // No dispatcher runs here, so earlier changes of this mailbox still wait in the outbox.
    await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key LIKE ${`${mailboxId}%`}`;
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT mail.enqueue_live_invalidation(${mailboxId}::uuid, ${assigned.id}::uuid)`;
      await tx`SELECT mail.enqueue_live_invalidation(${mailboxId}::uuid)`;
      return tx<{ ordering_key: string; payload: unknown }[]>`
        SELECT ordering_key, payload FROM events.outbox
        WHERE app_id = 'mail' AND ordering_key LIKE ${`${mailboxId}%`}
        ORDER BY ordering_key
      `;
    });
    await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key LIKE ${`${mailboxId}%`}`;
    const byKey = Object.fromEntries(rows.map((row) => [row.ordering_key, row.payload]));
    expect(byKey[`${mailboxId}:${assignedReader.id}`]).toEqual({
      v: 1,
      k: `${mailboxId}:${assignedReader.id}`,
      d: { conversationId: conversation!.short_id },
    });
    expect(byKey[`${mailboxId}:assigned`]).toEqual({ v: 1, k: `${mailboxId}:assigned`, d: { conversationId: null } });
    // The other conversation has no assignee, so no person's key names it.
    expect(
      rows
        .filter((row) => row.ordering_key.startsWith(`${mailboxId}:`))
        .map((row) => row.ordering_key)
        .sort(),
    ).toEqual([`${mailboxId}:${assignedReader.id}`, `${mailboxId}:assigned`].sort());
  });

  test("revoking an assigned-only grant ends its access", async () => {
    const listed = await listMailboxAccess(owner.context, mailboxId);
    if (!listed.ok) throw new Error(listed.error.message);
    const entry = listed.data.find((candidate) => candidate.principal.type === "group")!;
    expect((await revokeMailboxAccess({ context: owner.context, mailboxId, accessId: entry.id })).ok).toBe(true);
    expect(await getMailboxAccess(groupMember.context, mailboxId)).toBeNull();
    const [left] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM auth.access WHERE id = ${entry.id}::uuid`;
    expect(left).toEqual({ count: 0 });
  });
});
