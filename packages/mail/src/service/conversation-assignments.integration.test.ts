import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { MAIL_CONVERSATION_ASSIGNEE_LIMIT, MAIL_CONVERSATION_BATCH_LIMIT } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import {
  listAssignableUsers,
  loadConversationAssigneeIds,
  updateConversationCollaborationInTransaction,
  writeConversationAssignees,
} from "./collaboration";
import { currentEligibleAssigneeIds, isUnassignedConversation, listLapsedAssignees } from "./collaborators";
import { assignConversation, assignConversations, updateConversationCollaboration } from "./conversation-assignments";
import { mergeConversations } from "./conversations";
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
  const groupIds: string[] = [];
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
  const assigneesOf = async (ids: string[]) => {
    const rows = await sql<
      { id: string }[]
    >`SELECT id FROM mail.conversations WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb)) ORDER BY id`;
    return Promise.all(rows.map((row) => loadConversationAssigneeIds(sql, row.id)));
  };
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
      const access = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid UNION ALL SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
      for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    if (groupIds.length > 0)
      await sql`DELETE FROM auth.groups WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${groupIds}::jsonb))`;
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
      assigneeUserIds: [writer.id],
      mode: "replace",
      locale: "de",
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.assignees[0]?.id).toBe(writer.id);
    expect(result.data.results).toEqual([
      ...conversations.map((conversation) => ({ conversationId: conversation.shortId, status: "ok" as const })),
      { conversationId: foreignConversationShortId, status: "not_found" },
      { conversationId: missingShortId, status: "not_found" },
    ]);
    expect(await assigneesOf(conversations.map((conversation) => conversation.id))).toEqual([[writer.id], [writer.id], [writer.id]]);

    const activity = await sql<{ conversation_id: string; actor_id: string; metadata: { after: { assigneeUserIds: string[] } } }[]>`
      SELECT conversation_id, actor_id, metadata FROM mail.activity_events
      WHERE mailbox_id = ${mailboxId}::uuid AND action = 'conversation.collaboration_updated'
    `;
    expect(activity.map((event) => event.conversation_id).sort()).toEqual(conversations.map((conversation) => conversation.id).sort());
    expect(activity.every((event) => event.actor_id === owner.id && event.metadata.after.assigneeUserIds.includes(writer.id))).toBeTrue();

    const notices = await assignmentNotices(writer.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe("3 Unterhaltungen wurden dir zugewiesen");
    expect(notices[0]!.target_href).toMatch(/^\/app\/mail\/[0-9A-Za-z]{6}\?view=mine$/);

    // Re-assigning the same person changes nothing and sends nothing new.
    const repeated = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [conversations[0]!.shortId],
      assigneeUserIds: [writer.id],
      mode: "replace",
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
      assigneeUserIds: [],
      mode: "replace",
      locale: "en",
    });
    expect(unassigned.ok && unassigned.data.assignees).toEqual([]);
    expect(await assigneesOf(conversations.map((conversation) => conversation.id))).toEqual([[], [], []]);

    const selfAssigned = await assignConversations({
      context: contextFor(writer),
      mailboxId,
      conversationIds: [ids[0]!],
      assigneeUserIds: [writer.id],
      mode: "replace",
      locale: "en",
    });
    expect(selfAssigned.ok).toBeTrue();
    expect(await assignmentNotices(writer.id)).toHaveLength(1);

    const single = await assignConversations({
      context: contextFor(writer),
      mailboxId,
      conversationIds: [ids[1]!],
      assigneeUserIds: [owner.id],
      mode: "replace",
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
      input: { assigneeUserIds?: string[]; completion?: "done" },
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

    const assigned = await update(owner, first, { assigneeUserIds: [writer.id] }, "de");
    expect(assigned.assignees[0]?.id).toBe(writer.id);
    const [notice] = await noticesFor(writer.id, first);
    expect(notice?.title).toBe("Dir wurde eine Unterhaltung zugewiesen");
    expect(notice?.idempotency_key).toMatch(/^assignment:\d+:[0-9a-f-]+$/);

    // The same assignee alongside another change, then unassignment and self-assignment, send nothing.
    await update(owner, first, { assigneeUserIds: [writer.id], completion: "done" });
    await update(owner, first, { assigneeUserIds: [] });
    await update(writer, first, { assigneeUserIds: [writer.id] });
    expect(await noticesFor(writer.id, first)).toHaveLength(1);

    await update(owner, second, { assigneeUserIds: [writer.id] });
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
      assigneeUserIds: [owner.id],
      mode: "replace",
      locale: "en",
    });
    expect(!denied.ok && denied.error.status).toBe(403);

    const ineligible = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: ids,
      assigneeUserIds: [reader.id],
      mode: "replace",
      locale: "en",
    });
    expect(!ineligible.ok && ineligible.error.status).toBe(400);
    expect(await assigneesOf(conversations.map((conversation) => conversation.id))).toEqual(before);

    const tooMany = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: Array.from({ length: MAIL_CONVERSATION_BATCH_LIMIT + 1 }, () => newShortId()),
      assigneeUserIds: [],
      mode: "replace",
      locale: "en",
    });
    expect(!tooMany.ok && tooMany.error.status).toBe(400);
  });
  test("adds, removes, and replaces sets while preserving times, mirroring legacy state, and notifying only added users", async () => {
    const first = await createConversation(mailboxId, "Multiple assignees");
    const second = await createConversation(mailboxId, "Mixed existing assignees");
    const add = (ids: string[], mode: "add" | "remove" | "replace", conversationIds = [first.shortId, second.shortId]) =>
      assignConversations({
        context: contextFor(reader),
        mailboxId,
        conversationIds,
        assigneeUserIds: ids,
        mode,
        locale: "en",
      });
    // A mailbox-wide reader remains forbidden to assign.
    expect(!(await add([writer.id], "add")).ok).toBeTrue();
    const change = (ids: string[], mode: "add" | "remove" | "replace", conversationIds = [first.shortId, second.shortId]) =>
      assignConversations({
        context: contextFor(owner),
        mailboxId,
        conversationIds,
        assigneeUserIds: ids,
        mode,
        locale: "en",
      });
    const third = await createUser("second-writer");
    const grant = await grantMailboxAccess({
      context: contextFor(owner),
      mailboxId,
      principal: { type: "user", userId: third.id },
      permission: "write",
    });
    if (!grant.ok) throw new Error(grant.error.message);
    expect((await change([writer.id, writer.id], "replace", [first.shortId])).ok).toBeTrue();
    const [original] = await sql<
      { assigned_at: Date }[]
    >`SELECT assigned_at FROM mail.conversation_assignees WHERE conversation_id = ${first.id}::uuid AND user_id = ${writer.id}::uuid`;
    const writerBefore = (await assignmentNotices(writer.id)).length;
    const thirdBefore = (await assignmentNotices(third.id)).length;
    expect((await change([writer.id, third.id], "add")).ok).toBeTrue();
    expect(await loadConversationAssigneeIds(sql, first.id)).toEqual([writer.id, third.id]);
    const [kept] = await sql<
      { assigned_at: Date }[]
    >`SELECT assigned_at FROM mail.conversation_assignees WHERE conversation_id = ${first.id}::uuid AND user_id = ${writer.id}::uuid`;
    expect(kept?.assigned_at).toEqual(original?.assigned_at);
    expect(await assignmentNotices(writer.id)).toHaveLength(writerBefore + 1);
    expect(await assignmentNotices(third.id)).toHaveLength(thirdBefore + 1);
    const [writerNotice] = (await assignmentNotices(writer.id)).slice(-1);
    const [thirdNotice] = (await assignmentNotices(third.id)).slice(-1);
    expect(writerNotice?.target_href).toEndWith(`?conversation=${second.shortId}`);
    expect(thirdNotice?.title).toBe("2 conversations were assigned to you");
    expect(writerNotice?.idempotency_key.replace(/:[^:]+$/, "")).toBe(thirdNotice?.idempotency_key.replace(/:[^:]+$/, ""));
    expect(writerNotice?.idempotency_key).toEndWith(`:${writer.id}`);
    expect((await change([writer.id], "remove")).ok).toBeTrue();
    expect(await loadConversationAssigneeIds(sql, first.id)).toEqual([third.id]);
    const [mirror] = await sql<
      { assignee_user_id: string | null }[]
    >`SELECT assignee_user_id FROM mail.conversations WHERE id = ${first.id}::uuid`;
    expect(mirror?.assignee_user_id).toBe(third.id);
    expect((await change([], "replace")).ok).toBeTrue();
    const [cleared] = await sql<
      { assignee_user_id: string | null }[]
    >`SELECT assignee_user_id FROM mail.conversations WHERE id = ${first.id}::uuid`;
    expect(cleared?.assignee_user_id).toBeNull();
    expect(await loadConversationAssigneeIds(sql, first.id)).toEqual([]);
    expect(await assignmentNotices(writer.id)).toHaveLength(writerBefore + 1);
    expect(await assignmentNotices(third.id)).toHaveLength(thirdBefore + 1);
    expect((await change([reader.id], "remove")).ok).toBeTrue();
  });

  test("assigns one conversation through the capability modes without a revision and returns its final set", async () => {
    const conversation = await createConversation(mailboxId, "Single assignment modes");
    const apply = (assigneeUserIds: string[], mode: "add" | "remove" | "replace") =>
      assignConversation({
        context: contextFor(owner),
        mailboxId,
        conversationId: conversation.shortId,
        assigneeUserIds,
        mode,
        locale: "en",
      });
    const replaced = await apply([writer.id, owner.id], "replace");
    expect(replaced.ok && replaced.data.assignees.map((user) => user.id)).toEqual([writer.id, owner.id]);
    const removed = await apply([owner.id], "remove");
    expect(removed.ok && removed.data.assignees.map((user) => user.id)).toEqual([writer.id]);
    const added = await apply([owner.id], "add");
    expect(added.ok && added.data.assignees.map((user) => user.id)).toEqual([writer.id, owner.id]);
    const cleared = await apply([], "replace");
    expect(cleared.ok && cleared.data.assignees).toEqual([]);
    const missing = await assignConversation({
      context: contextFor(owner),
      mailboxId,
      conversationId: foreignConversationShortId,
      assigneeUserIds: [],
      mode: "replace",
      locale: "en",
    });
    expect(!missing.ok && missing.error.status).toBe(404);
  });

  test("keeps a lapsed assignee while others are added or removed, and never adds one", async () => {
    const lapsed = await createUser("lapsed");
    const grant = await grantMailboxAccess({
      context: contextFor(owner),
      mailboxId,
      principal: { type: "user", userId: lapsed.id },
      permission: "write",
    });
    if (!grant.ok) throw new Error(grant.error.message);
    const conversation = await createConversation(mailboxId, "Lapsed assignee");
    const other = await createConversation(mailboxId, "Lapsed assignee elsewhere");
    const assigned = await assignConversation({
      context: contextFor(owner),
      mailboxId,
      conversationId: conversation.shortId,
      assigneeUserIds: [lapsed.id],
      mode: "replace",
      locale: "en",
    });
    if (!assigned.ok) throw new Error(assigned.error.message);
    await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${lapsed.id}::uuid`;
    const patch = (assigneeUserIds: string[], expectedRevision: number, target = conversation.id) =>
      updateConversationCollaboration({
        context: contextFor(owner),
        mailboxId,
        conversationId: target,
        input: { expectedRevision, assigneeUserIds },
        locale: "en",
      });
    // The details panel sends the whole set, which still names the lapsed assignee.
    const added = await patch([lapsed.id, writer.id], assigned.data.revision);
    if (!added.ok) throw new Error(added.error.message);
    expect(added.data.assignees.map((user) => user.id)).toEqual([lapsed.id, writer.id]);
    const removed = await patch([lapsed.id], added.data.revision);
    if (!removed.ok) throw new Error(removed.error.message);
    expect(removed.data.assignees.map((user) => user.id)).toEqual([lapsed.id]);
    const replaced = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [conversation.shortId],
      assigneeUserIds: [lapsed.id, owner.id],
      mode: "replace",
      locale: "en",
    });
    expect(replaced.ok).toBe(true);
    expect(await loadConversationAssigneeIds(sql, conversation.id)).toEqual([lapsed.id, owner.id]);

    const [otherRevision] = await sql<{ revision: number }[]>`SELECT revision FROM mail.conversations WHERE id = ${other.id}::uuid`;
    const newlyAdded = await patch([lapsed.id], Number(otherRevision!.revision), other.id);
    expect(!newlyAdded.ok && newlyAdded.error.status).toBe(400);
    const batchAdded = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [conversation.shortId, other.shortId],
      assigneeUserIds: [lapsed.id],
      mode: "add",
      locale: "en",
    });
    expect(!batchAdded.ok && batchAdded.error.status).toBe(400);
    expect(await assigneesOf([other.id])).toEqual([[]]);
  });

  test("assigned-only direct and nested-group grants make active users eligible but never allow them to assign", async () => {
    const direct = await createUser("assigned-direct");
    const nested = await createUser("assigned-nested");
    const expired = await createUser("expired");
    const admin = await createUser("platform-admin");
    await sql`UPDATE auth.users SET admin = true WHERE id = ${admin.id}::uuid`;
    await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${expired.id}::uuid`;
    const groups = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups (cn, provider, name) VALUES (${`assign-parent-${suffix}`}, 'local', 'Assignment parent'), (${`assign-child-${suffix}`}, 'local', 'Assignment child') RETURNING id`;
    groupIds.push(...groups.map((group) => group.id));
    const parent = groups[0]!.id;
    const child = groups[1]!.id;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${nested.id}::uuid, ${child}::uuid)`;
    const directGrant = await grantMailboxAccess({
      context: contextFor(owner),
      mailboxId,
      principal: { type: "user", userId: direct.id },
      permission: "read",
      scope: "assigned",
    });
    const nestedGrant = await grantMailboxAccess({
      context: contextFor(owner),
      mailboxId,
      principal: { type: "group", groupId: parent },
      permission: "write",
      scope: "assigned",
    });
    const expiredGrant = await grantMailboxAccess({
      context: contextFor(owner),
      mailboxId,
      principal: { type: "user", userId: expired.id },
      permission: "write",
    });
    if (!directGrant.ok || !nestedGrant.ok || !expiredGrant.ok) throw new Error("Eligibility grants failed");
    const eligible = await currentEligibleAssigneeIds({
      mailboxId,
      userIds: [direct.id, nested.id, expired.id, admin.id, reader.id, writer.id],
    });
    expect([...eligible].sort()).toEqual([direct.id, nested.id, writer.id].sort());
    const users = await listAssignableUsers({ context: contextFor(owner), mailboxId, limit: 200 });
    if (!users.ok) throw new Error(users.error.message);
    expect(users.data.find((user) => user.id === direct.id)?.scope).toBe("assigned");
    expect(users.data.find((user) => user.id === writer.id)?.scope).toBe("mailbox");
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${writer.id}::uuid, ${child}::uuid)`;
    const searched = await listAssignableUsers({ context: contextFor(owner), mailboxId, search: "Assignment parent" });
    expect(searched.ok && searched.data.find((user) => user.id === writer.id)?.scope).toBe("mailbox");
    const conversation = await createConversation(mailboxId, "Assigned access eligibility");
    const assigned = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [conversation.shortId],
      assigneeUserIds: [direct.id, nested.id],
      mode: "replace",
      locale: "en",
    });
    expect(assigned.ok).toBeTrue();
    for (const actor of [direct, nested]) {
      const denied = await assignConversations({
        context: contextFor(actor),
        mailboxId,
        conversationIds: [conversation.shortId],
        assigneeUserIds: [],
        mode: "replace",
        locale: "en",
      });
      expect(!denied.ok && denied.error.status).toBe(403);
      const patch = await updateConversationCollaboration({
        context: contextFor(actor),
        mailboxId,
        conversationId: conversation.id,
        input: { expectedRevision: 2, assigneeUserIds: [] },
        locale: "en",
      });
      expect(!patch.ok && patch.error.status).toBe(403);
    }
    const unassigned = async () => {
      const lapsed = await listLapsedAssignees({ mailboxIds: [mailboxId] });
      const [row] = await sql<
        { unassigned: boolean }[]
      >`SELECT ${isUnassignedConversation(lapsed)} AS unassigned FROM mail.conversations c WHERE c.id = ${conversation.id}::uuid`;
      return row?.unassigned;
    };
    expect(await unassigned()).toBeFalse();
    expect((await revokeMailboxAccess({ context: contextFor(owner), mailboxId, accessId: directGrant.data.id })).ok).toBeTrue();
    expect(await unassigned()).toBeFalse();
    expect((await revokeMailboxAccess({ context: contextFor(owner), mailboxId, accessId: nestedGrant.data.id })).ok).toBeTrue();
    expect(await unassigned()).toBeTrue();
    const removeLapsed = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [conversation.shortId],
      assigneeUserIds: [direct.id, nested.id],
      mode: "remove",
      locale: "en",
    });
    expect(removeLapsed.ok).toBeTrue();
  });

  test("checks every final set against the limit before modifying any conversation", async () => {
    const users = [owner.id, writer.id];
    for (let index = 0; index < MAIL_CONVERSATION_ASSIGNEE_LIMIT - 1; index++) {
      const user = await createUser(`limit-${index}`);
      users.push(user.id);
      const grant = await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: user.id },
        permission: "read",
        scope: "assigned",
      });
      if (!grant.ok) throw new Error(grant.error.message);
    }
    const full = await createConversation(mailboxId, "Full assignment set");
    const empty = await createConversation(mailboxId, "Must stay unchanged");
    await sql.begin((tx) =>
      writeConversationAssignees(tx, { mailboxId, conversationId: full.id, userIds: users.slice(0, MAIL_CONVERSATION_ASSIGNEE_LIMIT) }),
    );
    const failed = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [empty.shortId, full.shortId],
      assigneeUserIds: [users.at(-1)!],
      mode: "add",
      locale: "en",
    });
    expect(!failed.ok && failed.error.status).toBe(400);
    expect(!failed.ok && failed.error.message).toContain(String(MAIL_CONVERSATION_ASSIGNEE_LIMIT));
    expect(await loadConversationAssigneeIds(sql, empty.id)).toEqual([]);
    expect(await loadConversationAssigneeIds(sql, full.id)).toHaveLength(MAIL_CONVERSATION_ASSIGNEE_LIMIT);
    const oversized = await updateConversationCollaboration({
      context: contextFor(owner),
      mailboxId,
      conversationId: empty.id,
      input: { expectedRevision: 1, assigneeUserIds: users },
      locale: "en",
    });
    expect(!oversized.ok && oversized.error.status).toBe(400);
    const exact = await assignConversations({
      context: contextFor(owner),
      mailboxId,
      conversationIds: [empty.shortId],
      assigneeUserIds: users.slice(0, MAIL_CONVERSATION_ASSIGNEE_LIMIT),
      mode: "replace",
      locale: "en",
    });
    expect(exact.ok).toBeTrue();
  });

  test("rejects a merge whose union exceeds the assignee limit before changing either conversation", async () => {
    const source = await createConversation(mailboxId, "Merge limit source");
    const target = await createConversation(mailboxId, "Merge limit target");
    const users: string[] = [];
    for (let index = 0; index <= MAIL_CONVERSATION_ASSIGNEE_LIMIT; index++) users.push((await createUser(`merge-limit-${index}`)).id);
    await sql.begin(async (tx) => {
      await writeConversationAssignees(tx, {
        mailboxId,
        conversationId: target.id,
        userIds: users.slice(0, MAIL_CONVERSATION_ASSIGNEE_LIMIT),
      });
      await writeConversationAssignees(tx, { mailboxId, conversationId: source.id, userIds: [users.at(-1)!] });
    });
    const before = await assigneesOf([source.id, target.id]);
    const result = await mergeConversations({
      context: contextFor(owner),
      mailboxId,
      targetConversationId: target.id,
      input: { sourceConversationId: source.id, expectedTargetRevision: 1, expectedSourceRevision: 1, confirm: true },
    });
    expect(!result.ok && result.error.status).toBe(400);
    expect(!result.ok && result.error.message).toContain(String(MAIL_CONVERSATION_ASSIGNEE_LIMIT));
    expect(await assigneesOf([source.id, target.id])).toEqual(before);
    expect(await sql`SELECT 1 FROM mail.activity_events WHERE conversation_id IN (${source.id}::uuid, ${target.id}::uuid)`).toHaveLength(0);
  });

  test("publishes a removed user's invalidation in the same transaction", async () => {
    const conversation = await createConversation(mailboxId, "Removed live subscriber");
    await sql.begin(async (tx) => {
      await writeConversationAssignees(tx, { mailboxId, conversationId: conversation.id, userIds: [writer.id, owner.id] });
      const removed = await updateConversationCollaborationInTransaction({
        context: contextFor(owner),
        mailboxId,
        conversationId: conversation.id,
        input: { expectedRevision: 1, assigneeUserIds: [owner.id] },
        db: tx,
      });
      if (!removed.ok) throw new Error(removed.error.message);
      const rows = await tx<{ payload: { k: string; d: { conversationId: string } } }[]>`
        SELECT payload FROM events.outbox WHERE app_id = 'mail' AND kind = 'live' AND ordering_key = ${`${mailboxId}:${writer.id}`}
          AND payload->'d'->>'conversationId' = ${conversation.shortId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.d).toEqual({ conversationId: conversation.shortId });
    });
  });
});
