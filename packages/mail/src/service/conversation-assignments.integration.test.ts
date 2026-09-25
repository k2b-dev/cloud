import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { MAIL_CONVERSATION_BATCH_LIMIT } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { assignConversations, updateConversationCollaboration } from "./conversation-assignments";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

type TestUser = { id: string; uid: string; displayName: string };

const contextFor = (user: TestUser): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.displayName,
      givenName: user.displayName,
      sn: "Test",
      mail: `${user.uid}@example.com`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-assignment-${user.uid}`,
});

suite("mail conversation assignment", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  let owner: TestUser;
  let writer: TestUser;
  let reader: TestUser;
  let mailboxId = "";
  let conversations: Array<{ id: string; shortId: string }> = [];
  let foreignConversationShortId = "";

  const createUser = async (role: string): Promise<TestUser> => {
    const uid = `mail-assign-${role}-${suffix}`;
    const displayName = `${role[0]!.toUpperCase()}${role.slice(1)} Assignment`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${displayName}, false)
      RETURNING id
    `;
    userIds.push(row!.id);
    return { id: row!.id, uid, displayName };
  };
  const createFixtureMailbox = async (name: string): Promise<string> => {
    const mailbox = await createMailbox(contextFor(owner), { name: `${name} ${suffix}`, description: "Disposable assignment fixture" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxIds.push(mailbox.data.id);
    return mailbox.data.id;
  };
  const createConversation = async (inMailboxId: string, subject: string) => {
    const [row] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${inMailboxId}::uuid, ${subject}, 'customer@example.com', now())
      RETURNING id, short_id
    `;
    return { id: row!.id, shortId: row!.short_id };
  };
  const assigneesOf = async (ids: string[]) =>
    (
      await sql<{ id: string; assignee_user_id: string | null }[]>`
        SELECT id, assignee_user_id FROM mail.conversations
        WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb))
        ORDER BY id
      `
    ).map((row) => row.assignee_user_id);
  const assignmentNotices = (userId: string) =>
    sql<{ title: string; target_href: string | null; idempotency_key: string }[]>`
      SELECT title, target_href, idempotency_key FROM notifications.events
      WHERE definition_id = 'mail.conversationsAssigned' AND recipient_user_id = ${userId}::uuid
      ORDER BY created_at
    `;

  beforeAll(async () => {
    await migrate();
    owner = await createUser("owner");
    writer = await createUser("writer");
    reader = await createUser("reader");
    mailboxId = await createFixtureMailbox("Assignment");
    for (const [user, permission] of [
      [writer, "write"],
      [reader, "read"],
    ] as const) {
      const access = await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: user.id },
        permission,
      });
      if (!access.ok) throw new Error(access.error.message);
    }
    conversations = [
      await createConversation(mailboxId, "First"),
      await createConversation(mailboxId, "Second"),
      await createConversation(mailboxId, "Third"),
    ];
    const foreignMailboxId = await createFixtureMailbox("Other");
    foreignConversationShortId = (await createConversation(foreignMailboxId, "Elsewhere")).shortId;
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await sql`
        DELETE FROM notifications.events
        WHERE recipient_user_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))
      `;
    }
    for (const id of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
      for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("assigns many conversations, reports missing ones, audits each, and notifies once", async () => {
    const missingShortId = newShortId();
    const result = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [...conversations.map((conversation) => conversation.shortId), foreignConversationShortId, missingShortId],
      assigneeUserId: writer.id,
      locale: "de",
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.assignee?.id).toBe(writer.id);
    expect(result.data.results).toEqual([
      ...conversations.map((conversation) => ({ conversationId: conversation.shortId, status: "ok" as const })),
      { conversationId: foreignConversationShortId, status: "not_found" },
      { conversationId: missingShortId, status: "not_found" },
    ]);
    expect(await assigneesOf(conversations.map((conversation) => conversation.id))).toEqual([writer.id, writer.id, writer.id]);

    const activity = await sql<{ conversation_id: string; actor_id: string; metadata: { after: { assigneeUserId: string } } }[]>`
      SELECT conversation_id, actor_id, metadata FROM mail.activity_events
      WHERE mailbox_id = ${mailboxId}::uuid AND action = 'conversation.collaboration_updated'
    `;
    expect(activity.map((event) => event.conversation_id).sort()).toEqual(conversations.map((conversation) => conversation.id).sort());
    expect(activity.every((event) => event.actor_id === owner.id && event.metadata.after.assigneeUserId === writer.id)).toBeTrue();

    const notices = await assignmentNotices(writer.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe("3 Unterhaltungen wurden dir zugewiesen");
    expect(notices[0]!.target_href).toMatch(/^\/app\/mail\/[0-9A-Za-z]{6}\?view=mine$/);

    // Re-assigning the same person changes nothing and sends nothing new.
    const repeated = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [conversations[0]!.shortId],
      assigneeUserId: writer.id,
      locale: "en",
    });
    expect(repeated.ok && repeated.data.results).toEqual([{ conversationId: conversations[0]!.shortId, status: "ok" }]);
    expect(await assignmentNotices(writer.id)).toHaveLength(1);
  });

  test("unassigns and self-assigns without notifying anyone", async () => {
    const ids = conversations.map((conversation) => conversation.shortId);
    const unassigned = await assignConversations({
      context: contextFor(writer),
      mailboxId,
      conversationIds: ids,
      assigneeUserId: null,
      locale: "en",
    });
    expect(unassigned.ok && unassigned.data.assignee).toBeNull();
    expect(await assigneesOf(conversations.map((conversation) => conversation.id))).toEqual([null, null, null]);

    const selfAssigned = await assignConversations({
      context: contextFor(writer),
      mailboxId,
      conversationIds: [ids[0]!],
      assigneeUserId: writer.id,
      locale: "en",
    });
    expect(selfAssigned.ok).toBeTrue();
    expect(await assignmentNotices(writer.id)).toHaveLength(1);

    const single = await assignConversations({
      context: contextFor(writer),
      mailboxId,
      conversationIds: [ids[1]!],
      assigneeUserId: owner.id,
      locale: "en",
    });
    expect(single.ok).toBeTrue();
    const [notice] = await assignmentNotices(owner.id);
    expect(notice?.title).toBe("A conversation was assigned to you");
    expect(notice?.target_href).toMatch(new RegExp(`\\?conversation=${ids[1]}$`));
  });

  test("notifies on single assignment after commit and stays silent for self, unassignment, and unchanged assignees", async () => {
    const first = await createConversation(mailboxId, "Single assignment");
    const second = await createConversation(mailboxId, "Single assignment EN");
    const update = async (
      user: TestUser,
      conversation: { id: string },
      input: { assigneeUserId?: string | null; completion?: "done" },
      locale = "en",
    ) => {
      const [row] = await sql<{ revision: string | number }[]>`SELECT revision FROM mail.conversations WHERE id = ${conversation.id}::uuid`;
      const result = await updateConversationCollaboration({
        context: contextFor(user),
        mailboxId,
        conversationId: conversation.id,
        input: { expectedRevision: Number(row!.revision), ...input },
        locale,
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    };
    const noticesFor = async (userId: string, conversation: { shortId: string }) =>
      (await assignmentNotices(userId)).filter((notice) => notice.target_href?.endsWith(`?conversation=${conversation.shortId}`));

    const assigned = await update(owner, first, { assigneeUserId: writer.id }, "de");
    expect(assigned.assignee?.id).toBe(writer.id);
    const [notice] = await noticesFor(writer.id, first);
    expect(notice?.title).toBe("Dir wurde eine Unterhaltung zugewiesen");
    expect(notice?.idempotency_key).toMatch(/^assignment:\d+$/);

    // The same assignee alongside another change, then unassignment and self-assignment, send nothing.
    await update(owner, first, { assigneeUserId: writer.id, completion: "done" });
    await update(owner, first, { assigneeUserId: null });
    await update(writer, first, { assigneeUserId: writer.id });
    expect(await noticesFor(writer.id, first)).toHaveLength(1);

    await update(owner, second, { assigneeUserId: writer.id });
    const english = await noticesFor(writer.id, second);
    expect(english.map((item) => item.title)).toEqual(["A conversation was assigned to you"]);
  });

  test("denies readers and ineligible assignees as a whole and bounds the batch", async () => {
    const ids = conversations.map((conversation) => conversation.shortId);
    const before = await assigneesOf(conversations.map((conversation) => conversation.id));

    const denied = await assignConversations({
      context: contextFor(reader),
      mailboxId,
      conversationIds: ids,
      assigneeUserId: owner.id,
      locale: "en",
    });
    expect(!denied.ok && denied.error.status).toBe(403);

    const ineligible = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: ids,
      assigneeUserId: reader.id,
      locale: "en",
    });
    expect(!ineligible.ok && ineligible.error.status).toBe(400);
    expect(await assigneesOf(conversations.map((conversation) => conversation.id))).toEqual(before);

    const tooMany = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: Array.from({ length: MAIL_CONVERSATION_BATCH_LIMIT + 1 }, () => newShortId()),
      assigneeUserId: null,
      locale: "en",
    });
    expect(!tooMany.ok && tooMany.error.status).toBe(400);
  });
});
