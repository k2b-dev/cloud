import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { listFocusConversations } from "./focus";
import { createMailbox } from "./mailboxes";

const suite = process.env.MAIL_INTEGRATION_TESTS === "1" ? describe : describe.skip;

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
    assigneeUserId: string | null;
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
        short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status, assignee_user_id
      ) VALUES (
        ${newShortId()}, ${params.mailboxId}::uuid, ${params.subject}, 'Customer', ${params.date}, ${params.status},
        ${params.assigneeUserId}::uuid
      ) RETURNING id
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, ${params.date.getTime()}, 'headers')
    `;
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
      assigneeUserId: owner.id,
    });
    await createConversation({
      mailboxId: finance.id,
      folderId: finance.folderId,
      subject: "Unassigned finance",
      date: new Date(now - 2_000),
      status: "needs_action",
      assigneeUserId: null,
    });
    await createConversation({
      mailboxId: support.id,
      folderId: support.folderId,
      subject: "Waiting support",
      date: new Date(now - 3_000),
      status: "waiting",
      assigneeUserId: owner.id,
    });
    await createConversation({
      mailboxId: hidden.id,
      folderId: hidden.folderId,
      subject: "Hidden mail",
      date: new Date(now),
      status: "needs_action",
      assigneeUserId: outsider.id,
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
    expect(mine.data.items[0]?.mailboxName).toBe(`Support ${suffix}`);
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
});
