import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { writeConversationAssignees } from "./collaboration";
import { listFocusConversations, listMailboxCounts } from "./focus";
import { createMailbox } from "./mailboxes";
import { getConversationViewCounts, listConversations } from "./messages";
import { searchMessages } from "./search";

const suite = suiteFor("database", "nats");

const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: "Mail",
      sn: "Focus",
      mail: `${user.uid}@example.com`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
});

suite("cross-mailbox focus", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  let owner: { id: string; uid: string };
  let outsider: { id: string; uid: string };
  let ownerContext: MailRequestContext;
  let outsiderContext: MailRequestContext;

  const createUser = async (label: string) => {
    const uid = `mail-focus-${label}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    if (!row) throw new Error("Failed to create focus test user");
    userIds.push(row.id);
    return { id: row.id, uid };
  };

  const createFixtureMailbox = async (context: MailRequestContext, name: string) => {
    const created = await createMailbox(context, { name });
    if (!created.ok) throw new Error(created.error.message);
    mailboxIds.push(created.data.id);
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${created.data.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'active')
      RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`focus-${suffix}-${mailboxIds.length}`}, 'Inbox', 'inbox', 'current')
      RETURNING id
    `;
    return { id: created.data.id, name, folderId: folder!.id };
  };

  const createConversation = async (params: {
    mailboxId: string;
    folderId: string;
    subject: string;
    date: Date;
    status: "needs_action" | "waiting" | "done";
    assigneeUserIds: string[];
  }) => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text
      ) VALUES (
        ${newShortId()}, ${params.mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.com>`}, ${params.subject},
        ${params.subject.toLowerCase()}, ${params.date}, 128, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'complete',
        ${`Preview for ${params.subject}`}
      ) RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${message!.id}::uuid, 'from', 0, 'Customer', 'customer@example.com', 'customer@example.com')
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${params.folderId}::uuid, ${message!.id}::uuid, 1, ${Math.floor(Math.random() * 1_000_000) + 1})
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${remoteRef!.id}::uuid, ${params.folderId}::uuid, ${message!.id}::uuid, ARRAY[]::text[], ARRAY[]::text[])
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (
        short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status
      ) VALUES (
        ${newShortId()}, ${params.mailboxId}::uuid, ${params.subject}, 'Customer', ${params.date}, ${params.status}
      ) RETURNING id
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, ${params.date.getTime()}, 'headers')
    `;
    await sql.begin((tx) =>
      writeConversationAssignees(tx, { mailboxId: params.mailboxId, conversationId: conversation!.id, userIds: params.assigneeUserIds }),
    );
    return conversation!.id;
  };

  beforeAll(async () => {
    await migrate();
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    ownerContext = contextFor(owner);
    outsiderContext = contextFor(outsider);
    const support = await createFixtureMailbox(ownerContext, `Support ${suffix}`);
    const finance = await createFixtureMailbox(ownerContext, `Finance ${suffix}`);
    const hidden = await createFixtureMailbox(outsiderContext, `Hidden ${suffix}`);
    const now = Date.now();
    await createConversation({
      mailboxId: support.id,
      folderId: support.folderId,
      subject: "Assigned support",
      date: new Date(now - 1_000),
      status: "needs_action",
      assigneeUserIds: [outsider.id, owner.id],
    });
    await createConversation({
      mailboxId: finance.id,
      folderId: finance.folderId,
      subject: "Unassigned finance",
      date: new Date(now - 2_000),
      status: "needs_action",
      assigneeUserIds: [],
    });
    await createConversation({
      mailboxId: support.id,
      folderId: support.folderId,
      subject: "Waiting support",
      date: new Date(now - 3_000),
      status: "waiting",
      assigneeUserIds: [owner.id],
    });
    await createConversation({
      mailboxId: hidden.id,
      folderId: hidden.folderId,
      subject: "Hidden mail",
      date: new Date(now),
      status: "needs_action",
      assigneeUserIds: [outsider.id],
    });
  });

  afterAll(async () => {
    if (mailboxIds.length > 0) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access
        WHERE mailbox_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxIds}::jsonb))
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxIds}::jsonb))`;
      if (access.length > 0) {
        await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))`;
      }
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("pages Focus timestamps with microseconds and accepts legacy millisecond cursors", async () => {
    const user = await createUser("cursor");
    const context = contextFor(user);
    const mailbox = await createFixtureMailbox(context, `Cursor ${suffix}`);
    const expected: string[] = [];
    try {
      for (const micros of [100, 200, 200, 300, 400]) {
        const id = await createConversation({
          mailboxId: mailbox.id,
          folderId: mailbox.folderId,
          subject: "Focus cursor precision",
          date: new Date("2026-01-01T00:00:00.000Z"),
          status: "waiting",
          assigneeUserIds: [user.id],
        });
        expected.push(id);
        await sql`UPDATE mail.conversations SET latest_message_at = ${`2026-01-01T00:00:00.000${micros}Z`}::timestamptz WHERE id = ${id}::uuid`;
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < expected.length; page++) {
        const result = await listFocusConversations({ context, view: "waiting", limit: 2, cursor });
        if (!result.ok) throw new Error(result.error.message);
        seen.push(...result.data.items.map((item) => item.id));
        expect(result.data.items.every((item) => item.latestMessageAt === "2026-01-01T00:00:00.000Z")).toBe(true);
        cursor = result.data.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(cursor).toBeUndefined();
      expect(seen.toSorted()).toEqual(expected.toSorted());
      expect(new Set(seen).size).toBe(expected.length);
      const legacy = Buffer.from(
        JSON.stringify({ version: 1, view: "waiting", userId: user.id, date: "2027-01-01T00:00:00.000Z", id: crypto.randomUUID() }),
      ).toString("base64url");
      const result = await listFocusConversations({ context, view: "waiting", limit: 2, cursor: legacy });
      expect(result.ok && result.data.items.length).toBe(2);
    } finally {
      await sql`DELETE FROM mail.message_contents WHERE mailbox_id = ${mailbox.id}::uuid`;
      await sql`DELETE FROM mail.conversations WHERE mailbox_id = ${mailbox.id}::uuid`;
    }
  });

  test("aggregates readable mailboxes, personal queues, counts, and scoped cursors", async () => {
    const mine = await listFocusConversations({ context: ownerContext, view: "mine", limit: 1 });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    expect(mine.data.items.map((item) => item.subject)).toEqual(["Assigned support"]);
    expect(mine.data.counts).toEqual({ mine: 1, unassigned: 1, waiting: 1, all: 3 });
    expect(mine.data.mailboxCounts).toEqual(
      expect.arrayContaining([
        { mailboxId: mailboxIds[0], unread: 2, needsAction: 1 },
        { mailboxId: mailboxIds[1], unread: 1, needsAction: 1 },
      ]),
    );
    expect(mine.data.items[0]?.assigneeUserIds).toEqual([outsider.id, owner.id]);
    expect(mine.data.items[0]?.mailboxName).toBe(`Support ${suffix}`);
    expect(mine.data.items[0]?.revision).toBeGreaterThan(0);
    const mailboxCounts = await listMailboxCounts(ownerContext);
    expect(mailboxCounts).toEqual({ ok: true, data: mine.data.mailboxCounts });
    expect(JSON.stringify(mine.data)).not.toContain("Hidden mail");

    const all = await listFocusConversations({ context: ownerContext, view: "all", limit: 2 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.items).toHaveLength(2);
    expect(all.data.nextCursor).not.toBeNull();
    const next = await listFocusConversations({ context: ownerContext, view: "all", limit: 2, cursor: all.data.nextCursor! });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.data.items.map((item) => item.subject)).toEqual(["Waiting support"]);

    const wrongScope = await listFocusConversations({ context: ownerContext, view: "unassigned", cursor: all.data.nextCursor! });
    expect(wrongScope.ok).toBe(false);
    if (!wrongScope.ok) expect(wrongScope.error.status).toBe(400);

    const outsiderPage = await listFocusConversations({ context: outsiderContext, view: "mine" });
    expect(outsiderPage.ok).toBe(true);
    if (outsiderPage.ok) expect(outsiderPage.data.items.map((item) => item.subject)).toEqual(["Hidden mail"]);
  });

  test("leaves hidden mailboxes out of the list and view counts but keeps their mailbox counts", async () => {
    const [support, finance] = mailboxIds;
    const page = await listFocusConversations({ context: ownerContext, view: "all", excludedMailboxIds: [finance!] });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.items.map((item) => item.subject)).toEqual(["Assigned support", "Waiting support"]);
    expect(page.data.counts).toEqual({ mine: 1, unassigned: 0, waiting: 1, all: 2 });
    expect(page.data.mailboxCounts).toEqual(
      expect.arrayContaining([
        { mailboxId: support, unread: 2, needsAction: 1 },
        { mailboxId: finance, unread: 1, needsAction: 1 },
      ]),
    );
    // Hiding a mailbox this person cannot read changes nothing.
    const outsiderPage = await listFocusConversations({ context: outsiderContext, view: "mine", excludedMailboxIds: [support!] });
    expect(outsiderPage.ok && outsiderPage.data.items.map((item) => item.subject)).toEqual(["Hidden mail"]);
  });

  test("leaves Trash and Junk out of follow-up and treats assignees without access as unassigned", async () => {
    const lead = await createUser("lead");
    const former = await createUser("former");
    const expired = await createUser("expired");
    const leadContext = contextFor(lead);
    const team = await createFixtureMailbox(leadContext, `Team ${suffix}`);
    const [inbox] = await sql<
      { remote_resource_id: string }[]
    >`SELECT remote_resource_id FROM mail.folders WHERE id = ${team.folderId}::uuid`;
    const folder = async (name: string, role: string) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${newShortId()}, ${inbox!.remote_resource_id}::uuid, ${`focus-${suffix}-${name}`}, ${name}, ${role}, 'current')
        RETURNING id
      `;
      return row!.id;
    };
    const junkFolderId = await folder("Junk", "junk");
    const trashFolderId = await folder("Deleted", "other");
    // The mailbox uses its own Trash folder instead of the provider's.
    await sql`INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id) VALUES (${team.id}::uuid, 'trash', ${trashFolderId}::uuid)`;
    for (const user of [former, expired]) {
      const access = await grantMailboxAccess({
        context: leadContext,
        mailboxId: team.id,
        principal: { type: "user", userId: user.id },
        permission: "write",
      });
      if (!access.ok) throw new Error(access.error.message);
      if (user === former) {
        const revoked = await revokeMailboxAccess({ context: leadContext, mailboxId: team.id, accessId: access.data.id });
        if (!revoked.ok) throw new Error(revoked.error.message);
      }
    }
    await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${expired.id}::uuid`;

    const now = Date.now();
    const open = { mailboxId: team.id, status: "needs_action" as const, assigneeUserIds: [] };
    await createConversation({ ...open, folderId: team.folderId, subject: "Open question", date: new Date(now - 1_000) });
    await createConversation({
      ...open,
      folderId: team.folderId,
      subject: "Left by a former colleague",
      date: new Date(now - 2_000),
      assigneeUserIds: [former.id],
    });
    await createConversation({
      ...open,
      folderId: team.folderId,
      subject: "Left by an expired account",
      date: new Date(now - 3_000),
      assigneeUserIds: [expired.id],
    });
    const spamId = await createConversation({ ...open, folderId: junkFolderId, subject: "Win a prize", date: new Date(now) });
    await createConversation({ ...open, folderId: trashFolderId, subject: "Deleted request", date: new Date(now - 500) });
    const openSubjects = ["Open question", "Left by a former colleague", "Left by an expired account"];

    const focus = await listFocusConversations({ context: leadContext, view: "unassigned" });
    expect(focus.ok).toBe(true);
    if (!focus.ok) return;
    expect(focus.data.items.map((item) => item.subject)).toEqual(openSubjects);
    expect(focus.data.counts).toEqual({ mine: 0, unassigned: 3, waiting: 0, all: 3 });
    expect(focus.data.mailboxCounts).toEqual([{ mailboxId: team.id, unread: 3, needsAction: 3 }]);

    for (const view of ["needs_action", "unassigned"] as const) {
      const list = await listConversations({ context: leadContext, mailboxId: team.id, view });
      expect(list.ok && list.data.items.map((item) => item.subject)).toEqual(openSubjects);
    }
    const counts = await getConversationViewCounts({ context: leadContext, mailboxId: team.id });
    expect(counts.ok && counts.data).toMatchObject({ needs_action: 3, unassigned: 3, recently_active: 5 });
    // The message list and search find the same unassigned conversations.
    const unassignedMessages = await searchMessages({
      context: leadContext,
      mailboxId: team.id,
      groupByConversation: false,
      excludedFolderIds: [junkFolderId, trashFolderId],
      request: { expression: { type: "assignee", userId: null }, sort: "newest", limit: 10 },
    });
    expect(unassignedMessages.ok && unassignedMessages.data.items.map((item) => item.subject)).toEqual(openSubjects);

    // Moving the spam back out of Junk shows it again with its work state.
    await sql`
      UPDATE mail.message_placements
      SET folder_id = ${team.folderId}::uuid
      WHERE message_id = (SELECT message_id FROM mail.conversation_messages WHERE conversation_id = ${spamId}::uuid)
    `;
    const rescued = await listConversations({ context: leadContext, mailboxId: team.id, view: "needs_action" });
    expect(rescued.ok && rescued.data.items.map((item) => item.subject)).toEqual(["Win a prize", ...openSubjects]);
  });
});
