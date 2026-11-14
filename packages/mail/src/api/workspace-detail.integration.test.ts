import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import type { InferResponseType } from "hono/client";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { MAIL_WORKSPACE_HINT_IDS, type MailWorkspacePreference, type SenderConversationsPage } from "../contracts";
import { messageForwardTextOf } from "../forward-text";
import { newShortId } from "../lib/short-id";
import * as access from "../service/access";
import type { MailRequestContext } from "../service/auth";
import * as collaboration from "../service/collaboration";
import { listSenderConversations } from "../service/conversation-context";
import { mailLive } from "../service/live";
import * as mailboxPreferences from "../service/mailbox-preferences";
import * as mailboxes from "../service/mailboxes";
import * as messages from "../service/messages";
import { loadMailboxConversationDetail, type MailboxPageData, type MailConversationDetailData } from "../service/workspace";
import app from ".";
import type { apiClient } from "./client";

// The inferred browser client must expose these exact response contracts.
type SenderResponse = InferResponseType<(typeof apiClient.mailboxes)[":mailboxId"]["sender-conversations"]["$get"], 200>;
type PreferenceResponse = InferResponseType<(typeof apiClient.mailboxes)[":mailboxId"]["workspace-preference"]["$patch"], 200>;
const senderPage = (data: SenderResponse): SenderConversationsPage => data;
const workspacePreference = (data: PreferenceResponse): MailWorkspacePreference => data;

const suite = suiteFor("database", "nats", "valkey");
const anchor = new Date("2026-10-01T12:00:00.000Z");
// Budgets between the measured sizes of this fixture: workspace-detail 45,244 B after the forwardText trim and
// 61,906 B on origin/main before it; workspace-route 48,661 B after and 65,323 B before.
const WORKSPACE_DETAIL_MAX_BYTES = 50_000;
const WORKSPACE_ROUTE_MAX_BYTES = 54_000;
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: null,
});

// The return type requires every MailSelectionDetail field, even when that field is null or empty.
const selectionPart = (page: MailboxPageData): MailConversationDetailData => {
  if (!page.selectedConversationId) throw new Error("Snapshot did not select the fixture conversation");
  return {
    conversationId: page.selectedConversationId,
    localTags: page.localTags,
    selectedSubject: page.selectedSubject,
    detailMessages: page.detailMessages,
    conversationRowState: page.conversationRowState,
    conversationSummary: page.conversationSummary,
    conversationDrafts: page.conversationDrafts,
    detailError: page.detailError,
    collaborationState: page.collaborationState,
    conversationLocalTags: page.conversationLocalTags,
    comments: page.comments,
    commentsCursor: page.commentsCursor,
    assignableUsers: page.assignableUsers,
    activity: page.activity,
    reminder: page.reminder,
    keep: page.keep,
    collaborationError: page.collaborationError,
    detailErrors: page.detailErrors,
    selectedReference: page.selectedReference,
  };
};

type Folder = { id: string; shortId: string };
type Conversation = { id: string; shortId: string; messageShortIds: string[] };

suite("Mail workspace conversation detail", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: User[] = [];
  const mailboxIds: string[] = [];
  let owner: User;
  let reader: User;
  let revokedReader: User;
  let tokenSpy: ReturnType<typeof spyOn<typeof oauthTokens, "verifyAccessToken">> | undefined;
  let mailboxId = "";
  let mailboxShortId = "";
  let revokedGrantId = "";
  let folderA: Folder;
  let folderB: Folder;
  let foreignFolder: Folder;
  let visible: Conversation;
  let hidden: Conversation;

  const createUser = async (role: string): Promise<User> => {
    const uid = `mail-detail-${role}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${role}, false) RETURNING id`;
    if (!row) throw new Error("User fixture was not created");
    const user: User = {
      id: row.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: role,
      sn: "Test",
      displayName: role,
      mail: `${uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    users.push(user);
    return user;
  };
  const createFolder = async (resourceId: string, key: string): Promise<Folder> => {
    const shortId = newShortId();
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.folders
      (short_id, remote_resource_id, stable_key, name, sync_status)
      VALUES (${shortId}, ${resourceId}::uuid, ${key}, ${key}, 'current') RETURNING id`;
    if (!row) throw new Error("Folder fixture was not created");
    return { id: row.id, shortId };
  };
  const createResource = async (id: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${id}::uuid, '{}', '{}', ${"c".repeat(64)}, 'active') RETURNING id`;
    if (!row) throw new Error("Resource fixture was not created");
    return row.id;
  };
  const createConversation = async (
    label: string,
    messageCount: number,
    uidBase = label === "Visible thread" ? 1 : 100,
  ): Promise<Conversation> => {
    const shortId = newShortId();
    const [conversation] = await sql<{ id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at, summary, created_at, updated_at)
      VALUES (${shortId}, ${mailboxId}::uuid, ${label}, 'Customer', ${anchor}, 'Fixture summary', ${anchor}, ${anchor}) RETURNING id`;
    if (!conversation) throw new Error("Conversation fixture was not created");
    const messageShortIds: string[] = [];
    for (let i = 0; i < messageCount; i++) {
      const date = new Date(anchor.getTime() - (messageCount - i) * 60_000);
      const messageShortId = newShortId();
      messageShortIds.push(messageShortId);
      // Three plain, three hydrated HTML, and two HTML-only alternatives (null and blank plain text).
      const body = `Fixture message ${i}. A fixed readable body for forwarding and preview. `.repeat(40);
      const plainText = i === 6 ? null : i === 7 ? "  \n" : body;
      const html = i >= 3 ? `<p>${body}</p>` : null;
      const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
        (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, sent_at,
         size_bytes, content_hash, hydration_status, plain_text, sanitized_html)
        VALUES (${messageShortId}, ${mailboxId}::uuid, ${`<${shortId}-${i}@example.test>`}, ${label}, ${label.toLowerCase()},
          ${date}, ${date}, ${body.length}, ${new Bun.CryptoHasher("sha256").update(`${label}:${body}`).digest("hex")}, 'complete', ${plainText}, ${html}) RETURNING id`;
      if (!message) throw new Error("Message fixture was not created");
      await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation.id}::uuid, ${message.id}::uuid, ${i}, 'headers')`;
      for (const folder of [folderA, folderB]) {
        const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
          VALUES (${folder.id}::uuid, ${message.id}::uuid, 1, ${uidBase + i}) RETURNING id`;
        if (!ref) throw new Error("Remote reference fixture was not created");
        await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
          VALUES (${ref.id}::uuid, ${folder.id}::uuid, ${message.id}::uuid, ARRAY[]::text[])`;
      }
    }
    return { id: conversation.id, shortId, messageShortIds };
  };
  const request = (path: string, token = "owner") =>
    app.request(`/mailboxes/${mailboxShortId}/${path}`, {
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": uniqueCallerAddress() },
    });
  const detailRequest = (conversation = visible, folder?: Folder, token = "owner") =>
    request(`workspace-detail/${conversation.shortId}${folder ? `?folder=${folder.shortId}` : ""}`, token);
  const routeRequest = (folder: Folder, token = "owner", selection: Record<string, string> = { conversation: visible.shortId }) => {
    const href = `/app/mail/${mailboxShortId}?${new URLSearchParams({ folder: folder.shortId, ...selection })}`;
    return request(`workspace-route?${new URLSearchParams({ href })}`, token);
  };

  beforeAll(async () => {
    setSystemTime(anchor);
    owner = await createUser("owner");
    reader = await createUser("reader");
    revokedReader = await createUser("revoked");
    tokenSpy = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user =
        token === "owner" || token === "owner-write" ? owner : token === "reader" ? reader : token === "revoked" ? revokedReader : null;
      return user ? { kind: "user", payload: {}, user, scopes: token === "owner-write" ? ["read", "write"] : [] } : null;
    });
    mailboxId = unwrap(await mailboxes.createMailbox(contextFor(owner), { name: "Workspace detail fixture" })).id;
    mailboxIds.push(mailboxId);
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (!mailbox) throw new Error("Mailbox fixture was not created");
    mailboxShortId = mailbox.short_id;
    unwrap(
      await access.grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: reader.id },
        permission: "read",
        scope: "assigned",
      }),
    );
    revokedGrantId = unwrap(
      await access.grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: revokedReader.id },
        permission: "read",
      }),
    ).id;
    const resourceId = await createResource(mailboxId);
    folderA = await createFolder(resourceId, "Folder A");
    folderB = await createFolder(resourceId, "Folder B");
    const foreignMailbox = unwrap(await mailboxes.createMailbox(contextFor(owner), { name: "Foreign folder fixture" }));
    mailboxIds.push(foreignMailbox.id);
    foreignFolder = await createFolder(await createResource(foreignMailbox.id), "Foreign");
    visible = await createConversation("Visible thread", 8);
    hidden = await createConversation("Hidden thread", 1);
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id, assigned_at)
      VALUES (${visible.id}::uuid, ${reader.id}::uuid, ${anchor})`;
    await sql`INSERT INTO mail.conversation_comments
      (short_id, conversation_id, body_markdown, author_kind, author_id, created_at, updated_at)
      VALUES (${newShortId()}, ${visible.id}::uuid, 'Fixture comment', 'user', ${owner.id}::uuid, ${anchor}, ${anchor})`;
    const [tag] = await sql<{ id: string }[]>`INSERT INTO mail.local_tags
      (short_id, mailbox_id, name, normalized_name, color, created_by_actor_kind, created_by_actor_id, created_at, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Fixture tag', 'fixture tag', '#3366ff', 'user', ${owner.id}::uuid, ${anchor}, ${anchor}) RETURNING id`;
    if (!tag) throw new Error("Tag fixture was not created");
    await sql`INSERT INTO mail.conversation_local_tags
      (mailbox_id, conversation_id, tag_id, assigned_by_actor_kind, assigned_by_actor_id, created_at)
      VALUES (${mailboxId}::uuid, ${visible.id}::uuid, ${tag.id}::uuid, 'user', ${owner.id}::uuid, ${anchor})`;
  }, 30_000);

  afterAll(async () => {
    tokenSpy?.mockRestore();
    try {
      for (const id of mailboxIds) await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
      for (const user of users) await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
    } finally {
      setSystemTime();
    }
  });

  test("workspace preferences validate, persist separately per person, and arrive in the first snapshot", async () => {
    const mutate = (path: string, method: string, value: unknown) =>
      app.request(`/mailboxes/${mailboxShortId}/${path}`, {
        method,
        headers: { authorization: "Bearer owner-write", "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
        body: JSON.stringify(value),
      });
    const prefPath = "workspace-preference";
    expect(await (await request(prefPath)).json()).toEqual({ listShare: null, seenHints: [] });
    for (const listShare of [-0.01, 1.01, "0.4"]) expect((await mutate(prefPath, "PATCH", { listShare })).status).toBe(400);
    expect((await mutate(prefPath, "PATCH", {})).status).toBe(400);
    expect((await mutate(`${prefPath}/seen-hints`, "PUT", { hintId: "unknown" })).status).toBe(400);
    const shared = await mutate(prefPath, "PATCH", { listShare: 0.55 });
    expect(shared.status).toBe(200);
    expect(workspacePreference(await shared.json())).toEqual({ listShare: 0.55, seenHints: [] });
    await Promise.all(MAIL_WORKSPACE_HINT_IDS.map((hintId) => mutate(`${prefPath}/seen-hints`, "PUT", { hintId })));
    const repeated = await mutate(`${prefPath}/seen-hints`, "PUT", { hintId: "filters-moved" });
    expect(await repeated.json()).toEqual({ listShare: 0.55, seenHints: [...MAIL_WORKSPACE_HINT_IDS] });
    const snapshot: MailboxPageData = await (await routeRequest(folderA)).json();
    expect(snapshot.workspacePreference).toEqual({ listShare: 0.55, seenHints: [...MAIL_WORKSPACE_HINT_IDS] });
    expect(await (await request(prefPath, "reader")).json()).toEqual({ listShare: null, seenHints: [] });
    // Pin cleanup must not remove a saved width or seen hint.
    unwrap(await mailboxPreferences.setMailboxPreference(contextFor(owner), mailboxId, { pinned: false }));
    expect(unwrap(await mailboxPreferences.getMailboxWorkspacePreference(contextFor(owner), mailboxId))).toEqual(
      snapshot.workspacePreference,
    );
    unwrap(await mailboxPreferences.setMailboxWorkspacePreference(contextFor(reader), mailboxId, { listShare: 0 }));
    expect((await (await routeRequest(folderA, "reader")).json()).workspacePreference.listShare).toBe(0);
    const restored = await mutate(prefPath, "PATCH", { listShare: null });
    expect(await restored.json()).toEqual({ listShare: null, seenHints: [...MAIL_WORKSPACE_HINT_IDS] });
    expect((await mutate(prefPath, "PATCH", { listShare: 1 })).status).toBe(200);
    // Avoid changing later fixture assertions.
    await sql`DELETE FROM mail.personal_mailbox_preferences WHERE mailbox_id = ${mailboxId}::uuid`;
  });

  test("sender history filters From, mailbox, active messages, and assigned visibility before its count and limit", async () => {
    const created: Conversation[] = [];
    const email = `sender-${suffix}@example.test`;
    const source = await createConversation("Sender current", 1, 2000);
    created.push(source);
    try {
      const addAddress = async (conversation: Conversation, role: "from" | "to" = "from") => {
        await sql`INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
          SELECT message_id, ${role}, 0, ${email}, ${email} FROM mail.conversation_messages
          WHERE conversation_id = ${conversation.id}::uuid`;
      };
      await addAddress(source);
      const expected: Conversation[] = [];
      for (let index = 0; index < 7; index++) {
        const conversation = await createConversation(`Sender history ${index}`, 1, 2010 + index);
        created.push(conversation);
        expected.unshift(conversation);
        await addAddress(conversation);
        await sql`UPDATE mail.conversations SET latest_message_at = ${new Date(anchor.getTime() + index * 60_000)}
          WHERE id = ${conversation.id}::uuid`;
      }
      // Two assigned matches, including one outside the mailbox-wide first five.
      for (const conversation of [expected[0]!, expected[6]!]) {
        await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id)
          VALUES (${conversation.id}::uuid, ${reader.id}::uuid)`;
      }
      const recipientOnly = await createConversation("Only a recipient", 1, 2030);
      created.push(recipientOnly);
      await addAddress(recipientOnly, "to");
      const removed = await createConversation("Deleted sender message", 1, 2031);
      created.push(removed);
      await addAddress(removed);
      await sql`UPDATE mail.message_placements SET deleted_at = ${anchor} WHERE message_id IN
        (SELECT message_id FROM mail.conversation_messages WHERE conversation_id = ${removed.id}::uuid)`;
      const foreign = await createConversation("Other mailbox", 1, 2032);
      created.push(foreign);
      await addAddress(foreign);
      await sql`UPDATE mail.conversations SET mailbox_id = ${mailboxIds[1]!}::uuid WHERE id = ${foreign.id}::uuid`;
      const query = new URLSearchParams({ email: email.toUpperCase(), excludeConversationId: source.shortId });
      const response = await request(`sender-conversations?${query}`);
      expect(response.status).toBe(200);
      const page = senderPage(await response.json());
      expect(page.total).toBe(7);
      expect(page.items.map((item) => item.id)).toEqual(expected.slice(0, 5).map((item) => item.shortId));
      expect(page.items.every((item) => item.preview && item.latestMessageAt)).toBe(true);
      const restricted: SenderConversationsPage = await (
        await request(`sender-conversations?${new URLSearchParams({ email })}`, "reader")
      ).json();
      expect(restricted.total).toBe(2);
      expect(restricted.items.map((item) => item.id)).toEqual([expected[0]!.shortId, expected[6]!.shortId]);
      expect((await request(`sender-conversations?${query}`, "reader")).status).toBe(404);
      expect((await request(`sender-conversations?${new URLSearchParams({ email, limit: "6" })}`)).status).toBe(400);
      expect((await request("sender-conversations?email=invalid")).status).toBe(400);
      const none = unwrap(await listSenderConversations({ context: contextFor(owner), mailboxId, email: "missing@example.test" }));
      expect(none).toEqual({ items: [], total: 0 });
    } finally {
      for (const conversation of created) {
        await sql`DELETE FROM mail.message_contents WHERE id IN
          (SELECT message_id FROM mail.conversation_messages WHERE conversation_id = ${conversation.id}::uuid)`;
        await sql`DELETE FROM mail.conversations WHERE id = ${conversation.id}::uuid`;
      }
    }
  });

  test("internal notes reload in the reader with permissions, tombstones, cursors, and live invalidations, without outgoing mail", async () => {
    const readerContext = contextFor(reader);
    const base = { mailboxId, conversationId: visible.id };
    const outgoing = async () => {
      const [row] = await sql`SELECT
        (SELECT count(*)::int FROM mail.drafts WHERE mailbox_id = ${mailboxId}::uuid) AS drafts,
        (SELECT count(*)::int FROM mail.outbox_submissions WHERE mailbox_id = ${mailboxId}::uuid) AS outgoing,
        (SELECT count(*)::int FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid) AS messages,
        (SELECT count(*)::int FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid AND kind = 'send') AS sends`;
      return row;
    };
    const initialOutgoing = await outgoing();
    const wake = spyOn(mailLive, "wake");
    const comments: string[] = [];
    const assertInvalidation = async (mutate: () => Promise<void>) => {
      const [before] = await sql<{ seq: string }[]>`SELECT COALESCE(MAX(seq), 0)::text AS seq FROM events.outbox`;
      await mutate();
      for (const key of [mailboxId, `${mailboxId}:${reader.id}`]) {
        const rows = await sql<{ payload: { d: { conversationId: string } } }[]>`SELECT payload FROM events.outbox
          WHERE app_id = 'mail' AND kind = 'live' AND ordering_key = ${key} AND seq > ${before!.seq}::bigint`;
        expect(rows.map((row) => row.payload.d.conversationId)).toContain(visible.shortId);
      }
    };
    try {
      let note: collaboration.ConversationComment | undefined;
      await assertInvalidation(async () => {
        note = unwrap(
          await collaboration.createConversationComment({
            context: readerContext,
            ...base,
            input: { body: "Internal only: <b>plain text</b> @someone" },
          }),
        );
        comments.push(note.id);
      });
      if (!note) throw new Error("Note missing");
      const noteId = note.id;
      const snapshot: MailboxPageData = await (await routeRequest(folderA, "reader")).json();
      const initialNote = snapshot.comments.find((item) => item.author.id === reader.id)!;
      expect(initialNote).toMatchObject({
        body: "Internal only: <b>plain text</b> @someone",
        canEdit: true,
        canDelete: true,
        author: { displayName: "reader", avatarHash: null },
        editedAt: null,
        deletedAt: null,
        createdAt: note.createdAt,
      });
      expect(
        (await (await detailRequest(visible, folderA, "owner")).json()).comments.find(
          (item: collaboration.ConversationComment) => item.id === initialNote.id,
        ),
      ).toMatchObject({ canEdit: false, canDelete: false });
      await assertInvalidation(async () => {
        unwrap(
          await collaboration.updateConversationComment({
            context: readerContext,
            ...base,
            commentId: noteId,
            input: { expectedRevision: 1, body: "Edited internal note" },
          }),
        );
      });
      const edited: MailConversationDetailData = await (await detailRequest(visible, folderA, "reader")).json();
      expect(edited.comments.find((item) => item.id === initialNote.id)).toMatchObject({
        body: "Edited internal note",
        editedAt: expect.any(String),
      });
      setSystemTime(new Date(new Date(note.createdAt).getTime() + collaboration.COMMENT_MUTATION_WINDOW_MS + 1));
      const expired: MailConversationDetailData = await (await detailRequest(visible, folderA, "reader")).json();
      expect(expired.comments.find((item) => item.id === initialNote.id)).toMatchObject({ canEdit: false, canDelete: false });
      setSystemTime(anchor);
      await assertInvalidation(async () => {
        unwrap(
          await collaboration.deleteConversationComment({
            context: readerContext,
            ...base,
            commentId: noteId,
            input: { expectedRevision: 2 },
          }),
        );
      });
      const deleted: MailConversationDetailData = await (await detailRequest(visible, folderA, "reader")).json();
      expect(deleted.comments.find((item) => item.id === initialNote.id)).toMatchObject({
        body: null,
        deletedAt: expect.any(String),
        canEdit: false,
        canDelete: false,
      });
      expect(wake).toHaveBeenCalledTimes(3);
      expect(await outgoing()).toEqual(initialOutgoing);
      // Exercise the reader's real 100-note budget, not just the comment service's configurable limit.
      const olderNotes = await sql<{ id: string }[]>`INSERT INTO mail.conversation_comments
        (short_id, conversation_id, body_markdown, author_kind, author_id, created_at)
        SELECT lpad(to_hex(item), 6, '0'), ${visible.id}::uuid, 'Earlier internal note', 'user', ${owner.id}::uuid,
          ${anchor}::timestamptz + item * interval '1 millisecond'
        FROM generate_series(1, 101) AS item RETURNING id`;
      comments.push(...olderNotes.map((item) => item.id));
      const bounded: MailConversationDetailData = await (await detailRequest(visible, folderA, "reader")).json();
      expect(bounded.comments).toHaveLength(100);
      expect(bounded.commentsCursor).not.toBeNull();
      const times = bounded.comments.map((item) => item.createdAt);
      expect(times).toEqual([...times].sort());
      const olderResponse = await request(
        `conversations/${visible.shortId}/comments?${new URLSearchParams({
          order: "newest",
          limit: "100",
          cursor: bounded.commentsCursor!,
        })}`,
        "reader",
      );
      expect(olderResponse.status).toBe(200);
      const older: { items: collaboration.ConversationComment[]; nextCursor: string | null } = await olderResponse.json();
      expect(older.items).toHaveLength(3);
      expect(older.nextCursor).toBeNull();
      expect(older.items.every((item) => !bounded.comments.some((shown) => shown.id === item.id))).toBe(true);
    } finally {
      wake.mockRestore();
      setSystemTime(anchor);
      for (const id of comments) await sql`DELETE FROM mail.conversation_comments WHERE id = ${id}::uuid`;
    }
  });

  for (const token of ["owner", "revoked", "reader"]) {
    test(`${token}: both folder attributions equal every snapshot selection field with public IDs`, async () => {
      for (const folder of [folderA, folderB]) {
        const snapshotResponse = await routeRequest(folder, token);
        const detailResponse = await detailRequest(visible, folder, token);
        expect(snapshotResponse.status).toBe(200);
        expect(detailResponse.status).toBe(200);
        const snapshot: MailboxPageData = await snapshotResponse.json();
        const detail: MailConversationDetailData = await detailResponse.json();
        expect(detail).toEqual(selectionPart(snapshot));
        expect(detail.conversationId).toBe(visible.shortId);
        expect(detail.detailMessages.map((message) => message.id)).toEqual(visible.messageShortIds);
        expect(detail.detailMessages.every((message) => message.folderId === folder.shortId)).toBe(true);
        expect(detail.comments).toHaveLength(1);
        expect(detail.localTags).toHaveLength(1);
        expect(detail.conversationLocalTags?.tags).toEqual(detail.localTags);
        expect(detail.detailError).toBeNull();
        expect(detail.collaborationError).toBeNull();
        expect(Object.values(detail.detailErrors).every((value) => value === null)).toBe(true);
        expect(detail.assignableUsers.map((user) => user.id).sort()).toEqual(token === "reader" ? [] : [owner.id, reader.id].sort());
      }
    });
  }

  test("complete row state includes older messages and all live placements beyond the 100-body page", async () => {
    const long = await createConversation("Long thread", 101, 1000);
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id, assigned_at)
      VALUES (${long.id}::uuid, ${reader.id}::uuid, ${anchor})`;
    await sql`UPDATE mail.message_placements mp SET flags = ARRAY['\\Seen']::text[]
      FROM mail.conversation_messages cm WHERE cm.message_id = mp.message_id AND cm.conversation_id = ${long.id}::uuid`;
    const stale = unwrap(await messages.listConversations({ context: contextFor(reader), mailboxId, folderId: folderA.id })).items.find(
      (item) => item.id === long.id,
    )!;
    expect(stale.unread).toBe(false);
    // No revision or newest body changes: another client changes only the oldest message's placement.
    await sql`UPDATE mail.message_placements mp SET flags = ARRAY['\\Flagged']::text[]
      FROM mail.message_contents mc WHERE mc.id = mp.message_id AND mc.short_id = ${long.messageShortIds[0]}
        AND mp.folder_id = ${folderA.id}::uuid`;
    const response = await detailRequest(long, folderB, "reader");
    expect(response.status).toBe(200);
    const detail: MailConversationDetailData = await response.json();
    expect(detail.detailMessages).toHaveLength(100);
    expect(detail.detailMessages.some((message) => message.id === long.messageShortIds[0])).toBe(false);
    expect(detail.detailMessages.every((message) => message.flags.includes("\\Seen"))).toBe(true);
    expect(detail.conversationRowState).toMatchObject({
      revision: stale.revision,
      messageCount: 101,
      unreadFolderIds: [folderA.shortId],
      flaggedFolderIds: [folderA.shortId],
    });
    expect(detail.conversationRowState?.activeFolderIds.toSorted()).toEqual([folderA.shortId, folderB.shortId].sort());
    // Deleting placements removes their state, but does not remove the stored message from the total.
    await sql`UPDATE mail.message_placements mp SET deleted_at = ${anchor}
      FROM mail.message_contents mc WHERE mc.id = mp.message_id AND mc.short_id = ${long.messageShortIds[0]}`;
    const removed: MailConversationDetailData = await (await detailRequest(long, folderB, "reader")).json();
    expect(removed.conversationRowState).toMatchObject({ messageCount: 101, unreadFolderIds: [], flaggedFolderIds: [] });
    await sql`DELETE FROM mail.conversation_assignees WHERE conversation_id = ${long.id}::uuid`;
    expect((await detailRequest(long, folderB, "reader")).status).toBe(404);
    const denied = await messages.getConversationRowState({ context: contextFor(reader), mailboxId, conversationId: long.id });
    expect(denied.ok ? null : denied.error.status).toBe(404);
    const foreign = await messages.getConversationRowState({
      context: contextFor(owner),
      mailboxId: mailboxIds[1]!,
      conversationId: long.id,
    });
    expect(foreign.ok ? null : foreign.error.status).toBe(404);
  });

  test("assigned-only readers cannot open an unassigned conversation", async () => {
    expect((await detailRequest(hidden, folderA, "reader")).status).toBe(404);
  });

  test("grant revocation takes effect on the very next request", async () => {
    expect((await detailRequest(visible, folderA, "revoked")).status).toBe(200);
    unwrap(await access.revokeMailboxAccess({ context: contextFor(owner), mailboxId, accessId: revokedGrantId }));
    expect((await detailRequest(visible, folderA, "revoked")).status).toBe(404);
  });

  test("unknown and foreign folders have the same 404 as the folder parameter resolver", async () => {
    for (const folderId of [foreignFolder.shortId, newShortId()]) {
      const detail = await request(`workspace-detail/${visible.shortId}?folder=${folderId}`);
      const folder = await app.request(`/mailboxes/${mailboxShortId}/folders/${folderId}`, {
        method: "PATCH",
        headers: { authorization: "Bearer owner-write", "x-forwarded-for": uniqueCallerAddress(), "content-type": "application/json" },
        body: JSON.stringify({ display: "everywhere" }),
      });
      expect(detail.status).toBe(404);
      expect(folder.status).toBe(404);
      expect(await detail.json()).toEqual(await folder.json());
    }
  });

  test("absent folder still loads detail; malformed folder is rejected", async () => {
    expect((await detailRequest()).status).toBe(200);
    expect((await request(`workspace-detail/${visible.shortId}?folder=invalid`)).status).toBe(400);
  });

  test("plain bodies omit forwardText only from workspace selections", async () => {
    const response = await detailRequest(visible, folderA);
    expect(response.status).toBe(200);
    const detail: MailConversationDetailData = await response.json();
    for (const [index, message] of detail.detailMessages.entries()) {
      expect(Object.hasOwn(message, "forwardText")).toBe(!message.plainText?.trim());
      const publicResponse = await request(`messages/${message.id}`);
      expect(publicResponse.status).toBe(200);
      const publicMessage = await publicResponse.json();
      expect(Object.hasOwn(publicMessage, "forwardText")).toBe(true);
      expect(messageForwardTextOf(message)).toBe(publicMessage.forwardText);
      const singleResponse = await routeRequest(folderA, "owner", { message: visible.messageShortIds[index]! });
      expect(singleResponse.status).toBe(200);
      const single: MailboxPageData = await singleResponse.json();
      expect(single.detailMessages).toHaveLength(1);
      expect(Object.hasOwn(single.detailMessages[0]!, "forwardText")).toBe(!message.plainText?.trim());
      expect(messageForwardTextOf(single.detailMessages[0]!)).toBe(publicMessage.forwardText);
    }
    const fullDetails = unwrap(
      await messages.listConversationMessageDetails({
        context: contextFor(owner),
        mailboxId,
        conversationId: visible.id,
      }),
    );
    expect(fullDetails).toHaveLength(8);
    expect(fullDetails.every((message) => typeof message.forwardText === "string")).toBe(true);
  }, 30_000);

  test("the probe still rejects a missing conversation for mailbox-wide readers", async () => {
    expect(await loadMailboxConversationDetail({ context: contextFor(owner), mailboxId, conversationId: crypto.randomUUID() })).toBeNull();
  });

  test("the frozen fixture stays within the detail and snapshot byte budgets", async () => {
    const detail = await detailRequest(visible, folderA);
    const snapshot = await routeRequest(folderA);
    expect(detail.status).toBe(200);
    expect(snapshot.status).toBe(200);
    const detailBytes = (await detail.arrayBuffer()).byteLength;
    const snapshotBytes = (await snapshot.arrayBuffer()).byteLength;
    console.info(`workspace-detail: ${detailBytes} bytes; workspace-route (SSR props source): ${snapshotBytes} bytes`);
    expect(detailBytes).toBeLessThanOrEqual(WORKSPACE_DETAIL_MAX_BYTES);
    expect(snapshotBytes).toBeLessThanOrEqual(WORKSPACE_ROUTE_MAX_BYTES);
  });
});
