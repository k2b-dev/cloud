import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import type { ChatContext } from "./access";
import { ConversationSchema } from "./contracts";
import { conversations } from "./conversations";
import { chatLive } from "./live";
import { messages } from "./messages";
import { loadChatView } from "./snapshot";

const userId = "11111111-1111-4111-8111-111111111111";
const context: ChatContext = {
  accessSubject: { type: "user", userId },
  locale: "en",
  actor: {
    kind: "user",
    user: UserSchema.parse({
      id: userId,
      uid: "lea",
      provider: "local",
      profile: "user",
      roles: ["user"],
      givenname: "Lea",
      sn: "Example",
      displayName: "Lea Example",
      mail: null,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    }),
  },
};
const conversation = ConversationSchema.parse({
  id: "abcdef",
  name: "Private name",
  title: "Private name",
  icon: null,
  purpose: null,
  memberCount: 1,
  unread: 0,
  read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
  archived: false,
  pinnedRank: null,
  member: true,
  withGuests: false,
  peerDeactivated: false,
  rev: 0,
  permission: "admin",
  lastMessage: null,
  createdAt: "2026-10-12T00:00:00.000Z",
  lastActivityAt: "2026-10-12T00:00:00.000Z",
});
const page = { items: [], rev: 0, seqHead: 0 };
afterEach(() => mock.restore());

test("SSR reads cursor, sidebar, then the same focused snapshot as the browser", async () => {
  const order: string[] = [];
  spyOn(chatLive, "cursor").mockImplementation(async () => {
    order.push("cursor");
    return "before-reads";
  });
  spyOn(conversations, "list").mockImplementation(async () => {
    order.push("sidebar");
    return { ok: true, data: { items: [conversation], nextCursor: null } };
  });
  const snapshot = spyOn(messages, "snapshot").mockImplementation(async () => {
    order.push("snapshot");
    return { ok: true, data: { conversation, page, focus: "message001" } };
  });
  const result = await loadChatView(context, { conversationId: "abcdef", messageId: "message001" });
  expect(order).toEqual(["cursor", "sidebar", "snapshot"]);
  expect(snapshot).toHaveBeenCalledWith({ ...context, conversationId: "abcdef", messageId: "message001" });
  expect(result).toEqual({
    cursor: "before-reads",
    sidebar: { items: [conversation], nextCursor: null },
    open: { conversation, page, focus: "message001" },
    noAccess: false,
  });
});

test("SSR landing and invalid conversation IDs do not read a chat", async () => {
  spyOn(chatLive, "cursor").mockResolvedValue("before-reads");
  spyOn(conversations, "list").mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
  const snapshot = spyOn(messages, "snapshot");
  expect(await loadChatView(context, {})).toMatchObject({ open: null, noAccess: false });
  const invalid = await loadChatView(context, { conversationId: "bad-id!" });
  expect(invalid).toMatchObject({ open: null, noAccess: true });
  expect(snapshot).not.toHaveBeenCalled();
});

for (const code of ["NOT_FOUND", "FORBIDDEN"] as const)
  test(`SSR ${code} opens no details`, async () => {
    spyOn(chatLive, "cursor").mockResolvedValue("before-reads");
    spyOn(conversations, "list").mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
    spyOn(messages, "snapshot").mockResolvedValue({
      ok: false,
      error: { code, status: code === "NOT_FOUND" ? 404 : 403, message: "Hidden" },
    });
    expect(await loadChatView(context, { conversationId: "abcdef" })).toEqual({
      cursor: "before-reads",
      sidebar: { items: [], nextCursor: null },
      open: null,
      noAccess: true,
    });
  });

test("SSR propagates failed sidebar and snapshot reads to the page's error state", async () => {
  spyOn(chatLive, "cursor").mockResolvedValue("before-reads");
  const list = spyOn(conversations, "list").mockResolvedValue({
    ok: false,
    error: { code: "INTERNAL_ERROR", status: 500, message: "Sidebar failed" },
  });
  await expect(loadChatView(context, {})).rejects.toThrow("Sidebar failed");
  list.mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
  spyOn(messages, "snapshot").mockResolvedValue({ ok: false, error: { code: "INTERNAL_ERROR", status: 500, message: "Snapshot failed" } });
  await expect(loadChatView(context, { conversationId: "abcdef" })).rejects.toThrow("Snapshot failed");
});
