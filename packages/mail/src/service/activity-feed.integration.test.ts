import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import type { MailActivityKind } from "../mail-activity-kinds";
import { resolveMailSearchRoute } from "../search-state";
import { grantMailboxAccess } from "./access";
import { MAIL_SENT_ACTIVITY_ACTION } from "./activity-feed";
import type { MailRequestContext } from "./auth";
import { createConversationComment, listActivity } from "./collaboration";
import { updateConversationCollaboration } from "./conversation-assignments";
import { createMailbox } from "./mailboxes";
import { loadMailboxPageData } from "./workspace";

const suite = suiteFor("database", "nats");

type User = { id: string; uid: string; displayName: string };

const contextFor = (user: User): MailRequestContext => ({
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
      mail: `${user.uid}@example.test`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-activity-feed-${user.uid}`,
});

suite("mail mailbox event feed", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: User[] = [];
  let mailboxId = "";
  let folderId = "";
  let nextUid = 1;
  let owner: User;
  let writer: User;
  let colleague: User;
  let reader: User;
  let assignedReader: User;
  let outsider: User;
  let assignedConversation = "";
  let otherConversation = "";

  const event = async (input: {
    action: string;
    actor?: { kind: "user" | "workflow" | "system"; id: string | null };
    conversationId?: string | null;
    metadata?: Record<string, unknown>;
    targetType?: string;
  }): Promise<string> => {
    const actor = input.actor ?? { kind: "user" as const, id: writer.id };
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mail.activity_events (mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, target_type, metadata)
      VALUES (${mailboxId}::uuid, ${input.conversationId === undefined ? otherConversation : input.conversationId}::uuid,
        ${actor.kind}, ${actor.id}::uuid, ${input.action}, 'confirmed', ${input.targetType ?? "conversation"}, ${input.metadata ?? {}}::jsonb)
      RETURNING id::text
    `;
    return row!.id;
  };

  const conversation = async (subject: string) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations (short_id, mailbox_id, subject, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, now()) RETURNING id`;
    const uid = nextUid++;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<feed-${uid}-${suffix}@example.test>`}, ${subject}, ${subject.toLowerCase()}, now(), 1,
        ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'complete', 'Invented feed fixture') RETURNING id`;
    const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${message!.id}::uuid, 1, ${uid}) RETURNING id`;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${ref!.id}::uuid, ${folderId}::uuid, ${message!.id}::uuid)`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position) VALUES (${row!.id}::uuid, ${message!.id}::uuid, ${uid})`;
    return row!.id;
  };

  const feed = async (
    context: MailRequestContext,
    filter: { kinds?: MailActivityKind[]; actorId?: string; mine?: boolean; cursor?: string; limit?: number; conversationId?: string } = {},
  ) => listActivity({ context, mailboxId, ...filter });

  const items = async (...args: Parameters<typeof feed>) => {
    const result = await feed(...args);
    if (!result.ok) throw new Error(result.error.message);
    return result.data.items;
  };

  beforeAll(async () => {
    const createUser = async (role: string) => {
      const uid = `mail-feed-${role}-${suffix}`;
      const displayName = `${role[0]!.toUpperCase()}${role.slice(1)} Feed`;
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${displayName}, false) RETURNING id
      `;
      const user = { id: row!.id, uid, displayName };
      users.push(user);
      return user;
    };
    owner = await createUser("owner");
    writer = await createUser("writer");
    colleague = await createUser("colleague");
    reader = await createUser("reader");
    assignedReader = await createUser("assigned");
    outsider = await createUser("outsider");
    const mailbox = await createMailbox(contextFor(owner), { name: `Feed ${suffix}`, description: "Invented feed fixture" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    for (const [user, permission, scope] of [
      [writer, "write", "mailbox"],
      [colleague, "write", "mailbox"],
      [reader, "read", "mailbox"],
      [assignedReader, "write", "assigned"],
    ] as const) {
      const grant = await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: user.id },
        permission,
        scope,
      });
      if (!grant.ok) throw new Error(grant.error.message);
    }
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"e".repeat(64)}, 'active') RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'feed-inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
    folderId = folder!.id;
    assignedConversation = await conversation("Invoice 4711");
    otherConversation = await conversation("Return label");
  });

  afterAll(async () => {
    const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    await sql`DELETE FROM audit.events WHERE metadata->>'mailboxId' = ${mailboxId}`;
    for (const user of users) {
      await sql`DELETE FROM audit.events WHERE request_id = ${contextFor(user).requestId}`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
    }
  });

  test("each kind lists only its events, from real assignments, completions and comments, and names people and subjects", async () => {
    const assigned = await updateConversationCollaboration({
      locale: "en",
      context: contextFor(writer),
      mailboxId,
      conversationId: assignedConversation,
      input: { expectedRevision: 1, assigneeUserIds: [writer.id, assignedReader.id] },
    });
    if (!assigned.ok) throw new Error(assigned.error.message);
    const done = await updateConversationCollaboration({
      locale: "en",
      context: contextFor(colleague),
      mailboxId,
      conversationId: otherConversation,
      input: { expectedRevision: 1, completion: "done" },
    });
    if (!done.ok) throw new Error(done.error.message);
    const comment = await createConversationComment({
      context: contextFor(colleague),
      mailboxId,
      conversationId: assignedConversation,
      input: { body: "Invented internal note" },
    });
    if (!comment.ok) throw new Error(comment.error.message);
    await event({ action: "draft.created", targetType: "draft" });
    await event({ action: "draft.discarded", targetType: "draft" });
    await event({ action: "draft.derived", targetType: "draft", conversationId: null });
    await event({ action: "draft.attachment_added", targetType: "draft" });
    await event({ action: MAIL_SENT_ACTIVITY_ACTION, targetType: "outbox_submission", metadata: { result: "failed", intent: "reply" } });
    await event({
      action: "conversation.local_tags_added",
      actor: { kind: "workflow", id: crypto.randomUUID() },
      targetType: "local_tag",
    });
    // Reading, flagging and moving are commands; a person's own tag change is no feed event either.
    await event({ action: "command.execute", targetType: "command" });
    await event({ action: "command.move", targetType: "command" });
    await event({ action: "conversation.local_tags_added", targetType: "local_tag" });

    const context = contextFor(reader);
    const actions = async (kinds: MailActivityKind[]) => (await items(context, { kinds })).map((item) => item.action).sort();
    expect(await actions(["assignment"])).toEqual(["conversation.collaboration_updated"]);
    expect(await actions(["status"])).toEqual(["conversation.collaboration_updated"]);
    expect(await actions(["draft"])).toEqual(["draft.created", "draft.derived", "draft.discarded"]);
    expect(await actions(["comment"])).toEqual(["conversation.comment_created"]);
    expect(await actions(["sent"])).toEqual([MAIL_SENT_ACTIVITY_ACTION]);
    expect(await actions(["automation"])).toEqual(["conversation.local_tags_added"]);
    expect(await actions(["assignment", "status", "draft", "comment", "sent", "automation"])).toEqual([
      "conversation.collaboration_updated",
      "conversation.collaboration_updated",
      "conversation.comment_created",
      "conversation.local_tags_added",
      "draft.created",
      "draft.derived",
      "draft.discarded",
      MAIL_SENT_ACTIVITY_ACTION,
    ]);

    const [assignment] = await items(context, { kinds: ["assignment"] });
    expect(assignment?.conversationSubject).toBe("Invoice 4711");
    expect(assignment?.assignees?.before).toEqual([]);
    expect(assignment?.assignees?.after.map((person) => person.displayName)).toEqual([writer.displayName, assignedReader.displayName]);
    // Assignees stay principal references in the public metadata instead of turning into null.
    expect((assignment?.metadata.after as { assigneeUserIds: string[] }).assigneeUserIds).toEqual([writer.id, assignedReader.id]);
    const [completion] = await items(context, { kinds: ["status"] });
    expect(completion?.assignees).toBeNull();
    expect(completion?.conversationSubject).toBe("Return label");
  });

  test("person and concerns-me filters apply on the server", async () => {
    const context = contextFor(reader);
    const all: MailActivityKind[] = ["assignment", "status", "draft", "comment", "sent", "automation"];
    const byColleague = await items(context, { kinds: all, actorId: colleague.id });
    expect(byColleague.map((item) => item.action).sort()).toEqual(["conversation.collaboration_updated", "conversation.comment_created"]);
    expect(byColleague.every((item) => item.actor.id === colleague.id)).toBe(true);

    // The colleague's comment concerns the assigned reader: it is on a conversation assigned to them.
    const assignedReaderMine = await items(contextFor(assignedReader), { kinds: all, mine: true, conversationId: assignedConversation });
    expect(assignedReaderMine.map((item) => item.action).sort()).toEqual([
      "conversation.collaboration_updated",
      "conversation.comment_created",
    ]);
    // The colleague's own events concern them, and nothing that assigns someone else does.
    const colleagueMine = await items(contextFor(colleague), { kinds: all, mine: true });
    expect(colleagueMine.map((item) => item.action).sort()).toEqual(["conversation.collaboration_updated", "conversation.comment_created"]);
    expect(colleagueMine.find((item) => item.action === "conversation.collaboration_updated")?.conversationSubject).toBe("Return label");
    expect(await items(contextFor(owner), { kinds: all, mine: true })).toEqual([]);
  });

  test("filters run before the page limit and the cursor pages them without gaps across filter changes", async () => {
    const sends: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      sends.push(await event({ action: MAIL_SENT_ACTIVITY_ACTION, targetType: "outbox_submission", metadata: { result: "sent" } }));
    }
    // Two hundred newer reads and moves would fill every page if the filter ran after the limit.
    await sql`
      INSERT INTO mail.activity_events (mailbox_id, actor_kind, actor_id, action, outcome, target_type)
      SELECT ${mailboxId}::uuid, 'user', ${writer.id}::uuid, CASE WHEN step % 2 = 0 THEN 'command.execute' ELSE 'command.move' END,
        'confirmed', 'command'
      FROM generate_series(1, 200) step
    `;
    const context = contextFor(reader);
    const draftPage = await items(context, { kinds: ["draft"], limit: 50 });
    expect(draftPage.map((item) => item.action).sort()).toEqual(["draft.created", "draft.derived", "draft.discarded"]);

    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await feed(context, { kinds: ["sent"], limit: 50, cursor });
      if (!page.ok) throw new Error(page.error.message);
      sizes.push(page.data.items.length);
      seen.push(...page.data.items.map((item) => item.id));
      cursor = page.data.nextCursor ?? undefined;
    } while (cursor);
    expect(sizes).toEqual([50, 50, 21]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 120)).toEqual([...sends].reverse());

    // A cursor from one filter still pages another one strictly below it.
    const first = await feed(context, { kinds: ["sent"], limit: 50 });
    if (!first.ok || !first.data.nextCursor) throw new Error("The first page has no cursor");
    const switched = await items(context, { kinds: ["draft", "sent"], limit: 100, cursor: first.data.nextCursor });
    const boundary = BigInt(first.data.items.at(-1)!.id);
    expect(switched.every((item) => BigInt(item.id) < boundary)).toBe(true);
    expect(switched.map((item) => item.action)).toContain("draft.created");
  });

  test("a send shows to people who see only assigned conversations only while they see the sent message", async () => {
    const messageOf = async (conversationId: string) => {
      const [row] = await sql<{ message_id: string }[]>`
        SELECT message_id FROM mail.conversation_messages WHERE conversation_id = ${conversationId}::uuid LIMIT 1`;
      return row!.message_id;
    };
    const visible = await event({
      action: MAIL_SENT_ACTIVITY_ACTION,
      conversationId: assignedConversation,
      targetType: "outbox_submission",
      metadata: { result: "sent", intent: "reply", outboundMessageId: await messageOf(assignedConversation) },
    });
    // The sent message moved to a conversation they do not see: its send leaves their timeline too.
    const moved = await event({
      action: MAIL_SENT_ACTIVITY_ACTION,
      conversationId: assignedConversation,
      targetType: "outbox_submission",
      metadata: { result: "sent", intent: "reply", outboundMessageId: await messageOf(otherConversation) },
    });
    const ids = (await items(contextFor(assignedReader), { kinds: ["sent"], conversationId: assignedConversation })).map((item) => item.id);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(moved);
    // People who see the whole mailbox see both.
    const all = (await items(contextFor(reader), { kinds: ["sent"], conversationId: assignedConversation })).map((item) => item.id);
    expect(all).toEqual(expect.arrayContaining([visible, moved]));
  });

  test("the mailbox feed needs the collaboration read permission; people who see only assigned items get none", async () => {
    const forbidden = await feed(contextFor(assignedReader), { kinds: ["assignment"] });
    expect(forbidden.ok ? 200 : forbidden.error.status).toBe(403);
    const outside = await feed(contextFor(outsider), { kinds: ["assignment"] });
    expect(outside.ok).toBe(false);
    expect((await feed(contextFor(reader), { kinds: ["assignment"] })).ok).toBe(true);

    // Within a conversation they see, assigned people keep their filtered timeline; others stay hidden.
    const own = await items(contextFor(assignedReader), { kinds: ["assignment"], conversationId: assignedConversation });
    expect(own).toHaveLength(1);
    const hidden = await feed(contextFor(assignedReader), { kinds: ["status"], conversationId: otherConversation });
    expect(hidden.ok).toBe(false);

    // The workspace's Events tab shows the refusal as its error and lists no events.
    const page = await loadMailboxPageData({
      context: contextFor(assignedReader),
      mailboxId,
      requestUrl: new URL(`http://mail.test/app/mail/${mailboxId}?view=events`),
      search: resolveMailSearchRoute(new URL("http://mail.test/")),
      publicSearch: resolveMailSearchRoute(new URL("http://mail.test/")),
      locale: "en",
    });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.eventsMode).toBe(true);
    expect(page.data.eventsPage).toBeNull();
    expect(page.data.eventsError).not.toBeNull();
    expect(page.data.listItems).toEqual([]);

    const readerPage = await loadMailboxPageData({
      context: contextFor(reader),
      mailboxId,
      requestUrl: new URL(`http://mail.test/app/mail/${mailboxId}?view=events&eventKind=comment`),
      search: resolveMailSearchRoute(new URL("http://mail.test/")),
      publicSearch: resolveMailSearchRoute(new URL("http://mail.test/")),
      locale: "en",
    });
    if (!readerPage.ok) throw new Error(readerPage.error.message);
    expect(readerPage.data.eventsPage?.filter).toEqual({ kind: "comment", actorId: null, mine: false });
    expect(readerPage.data.eventsPage?.items.map((item) => item.action)).toEqual(["conversation.comment_created"]);
    expect(readerPage.data.eventsPage?.people.map((person) => person.displayName)).toEqual(
      expect.arrayContaining([writer.displayName, colleague.displayName]),
    );
  });
});
