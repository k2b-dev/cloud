import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { messageForwardTextOf } from "../forward-text";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import * as access from "../service/access";
import type { MailRequestContext } from "../service/auth";
import * as mailboxes from "../service/mailboxes";
import * as messages from "../service/messages";
import { loadMailboxConversationDetail, type MailboxPageData, type MailConversationDetailData } from "../service/workspace";
import app from ".";

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
  const createConversation = async (label: string, messageCount: number): Promise<Conversation> => {
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
          VALUES (${folder.id}::uuid, ${message.id}::uuid, 1, ${label === "Visible thread" ? i + 1 : i + 100}) RETURNING id`;
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
    await migrate();
    owner = await createUser("owner");
    reader = await createUser("reader");
    revokedReader = await createUser("revoked");
    tokenSpy = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user = token === "owner" ? owner : token === "reader" ? reader : token === "revoked" ? revokedReader : null;
      return user ? { kind: "user", payload: {}, user, scopes: [] } : null;
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
        headers: { authorization: "Bearer owner", "x-forwarded-for": uniqueCallerAddress(), "content-type": "application/json" },
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
