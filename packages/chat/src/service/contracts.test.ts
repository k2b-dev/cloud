import { describe, expect, test } from "bun:test";
import {
  AddMembersSchema,
  ChatLiveEventSchema,
  ConversationCursorSchema,
  ConversationQuerySchema,
  ConversationSchema,
  CreateConversationSchema,
  ForResourceSchema,
  LeaveSchema,
  MemberPageSchema,
  MemberPreviewSchema,
  MemberQuerySchema,
  PeopleQuerySchema,
  ReadAllSchema,
  SummaryQuerySchema,
  SystemChatParamSchema,
  ThreadQuerySchema,
  ThreadResourceSchema,
  UpdateConversationSchema,
  UpdateMemberSchema,
} from "./contracts";
import { deriveTitle } from "./titles";

const lea = "12345678-1234-4234-8234-123456789012";
test("member pages require nullable direct membership with its permission and active state", () => {
  const page = { items: [], nextCursor: null, managers: 1 };
  expect(MemberPageSchema.safeParse(page).success).toBeFalse();
  expect(MemberPageSchema.parse({ ...page, self: null }).self).toBeNull();
  for (const permission of ["read", "write", "admin"] as const)
    for (const active of [true, false]) {
      const self = { accessId: lea, permission, active };
      expect(MemberPageSchema.parse({ ...page, self }).self).toEqual(self);
    }
  for (const self of [
    { accessId: "bad", permission: "admin", active: true },
    { accessId: lea, permission: "none", active: true },
    { accessId: lea, permission: "admin" },
  ])
    expect(MemberPageSchema.safeParse({ ...page, self }).success).toBeFalse();
});
describe("conversation inputs", () => {
  test("defaults to an only-you chat and requires explicit duplicate creation", () => {
    expect(CreateConversationSchema.parse({})).toEqual({ members: [], allowDuplicate: false });
    expect(
      CreateConversationSchema.parse({
        members: [
          { type: "user", userId: lea },
          { type: "user", userId: lea },
        ],
      }).members,
    ).toEqual([{ type: "user", userId: lea }]);
  });
  test("create keys are optional UUIDs and remain stable through transport revalidation", () => {
    const createKey = "ABCDEFAB-1234-4234-8234-123456789012";
    const parsed = CreateConversationSchema.parse({ createKey });
    expect(parsed.createKey).toBe(createKey.toLowerCase());
    expect(CreateConversationSchema.parse(parsed)).toEqual(parsed);
    for (const createKey of ["", "not-a-key", "x".repeat(100), null])
      expect(CreateConversationSchema.safeParse({ createKey }).success).toBeFalse();
  });
  test("trims metadata and clears empty strings", () => {
    expect(UpdateConversationSchema.parse({ name: "  ", purpose: " hello ", icon: " " })).toEqual({
      name: null,
      purpose: "hello",
      icon: null,
    });
    expect(UpdateConversationSchema.parse({ name: null })).toEqual({ name: null });
  });
  test("bounds input and accepts only Tabler icon classes", () => {
    for (const input of [
      { name: "a".repeat(81) },
      { purpose: "a".repeat(301) },
      { icon: "<script>" },
      { members: Array(101).fill({ type: "user", userId: lea }) },
      { members: ["not-an-id"] },
    ]) {
      expect(CreateConversationSchema.safeParse(input).success).toBeFalse();
    }
    expect(CreateConversationSchema.safeParse({ icon: "ti ti-messages" }).success).toBeTrue();
    expect(AddMembersSchema.safeParse({ members: [] }).success).toBeFalse();
    expect(AddMembersSchema.safeParse({ members: Array(101).fill({ type: "user", userId: lea }) }).success).toBeFalse();
    expect(UpdateConversationSchema.safeParse({}).success).toBeFalse();
    expect(UpdateConversationSchema.safeParse({ member_count: 99 }).success).toBeFalse();
    expect(UpdateMemberSchema.safeParse({ permission: "none" }).success).toBeFalse();
    expect(LeaveSchema.safeParse({ successor: "bad" }).success).toBeFalse();
  });
  test("rejects malformed or incomplete pagination cursors", () => {
    expect(ConversationCursorSchema.safeParse({ at: "bad", id: "abcdef" }).success).toBeFalse();
    expect(ConversationQuerySchema.safeParse({ cursor: "malformed" }).success).toBeFalse();
    expect(
      ConversationQuerySchema.safeParse({ cursor: JSON.stringify({ at: "2026-10-09T12:00:00.000123Z", id: "abcdef" }) }).success,
    ).toBeTrue();
    expect(ConversationCursorSchema.safeParse({ at: "2026-10-09T12:00:00.000Z", id: "abcdef" }).success).toBeTrue();
  });
});
describe("derived conversation titles", () => {
  test("prefers an explicit name", () => expect(deriveTitle("Planning", [], "de")).toBe("Planning"));
  test("localizes the only-you title", () => {
    expect(deriveTitle(null, [], "en")).toBe("You");
    expect(deriveTitle(null, [], "de-DE")).toBe("Du");
  });
  test("uses a single person's display name and several people's first names", () => {
    const members = [
      { displayName: "Lea Müller", givenName: "Lea" },
      { displayName: "Tim Smith", givenName: "" },
    ];
    expect(deriveTitle(null, members.slice(0, 1), "en")).toBe("Lea Müller");
    expect(deriveTitle(null, members, "de")).toBe("Lea, Tim");
  });
  test("uses group names and keeps their full names after people", () => {
    const lea = { displayName: "Lea Müller", givenName: "Lea" };
    const group = { displayName: "Engineering", givenName: "", group: true };
    expect(deriveTitle(null, [group], "en")).toBe("Engineering");
    expect(deriveTitle(null, [lea, group], "en")).toBe("Lea, Engineering");
    expect(deriveTitle(null, [lea, { ...group, displayName: "Engineering Team" }], "en")).toBe("Lea, Engineering Team");
  });
  test("bounds the title to three names", () => {
    expect(
      deriveTitle(
        null,
        Array.from({ length: 5 }, (_, i) => ({ displayName: `Person ${i}`, givenName: `P${i}` })),
        "en",
      ),
    ).toBe("P0, P1, P2, …");
  });
});

test("conversation revisions, summary timestamps and membership hints are part of the live contract", () => {
  expect(ConversationSchema.shape.rev.safeParse(0).success).toBeTrue();
  expect(ConversationSchema.shape.rev.safeParse(-1).success).toBeFalse();
  expect(ChatLiveEventSchema.parse({ type: "membership", conversationId: "abcdef" })).toEqual({
    type: "membership",
    conversationId: "abcdef",
  });
  expect(ChatLiveEventSchema.safeParse({ type: "membership", conversationId: "missing-id" }).success).toBeFalse();
  const summary = {
    type: "summary",
    thread: null,
    conversationId: "abcdef",
    id: "0123456789",
    seq: 1,
    rev: 1,
    kind: "text",
    author: { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "Ana" },
    preview: "Hello",
    mention: false,
  };
  expect(ChatLiveEventSchema.safeParse(summary).success).toBeFalse();
  expect(ChatLiveEventSchema.safeParse({ ...summary, createdAt: "not a date" }).success).toBeFalse();
  expect(ChatLiveEventSchema.safeParse({ ...summary, createdAt: "2026-10-12T00:00:00.000Z" }).success).toBeTrue();
});

test("principal normalization is idempotent and deduplicates per type", () => {
  const id = "ABCDEF12-1234-4234-8234-123456789012";
  const parsed = CreateConversationSchema.parse({
    members: [
      { type: "user", userId: id },
      { type: "user", userId: id.toLowerCase() },
      { type: "group", groupId: id },
      { type: "group", groupId: id.toLowerCase() },
    ],
  });
  expect(parsed.members).toEqual([
    { type: "user", userId: id.toLowerCase() },
    { type: "group", groupId: id.toLowerCase() },
  ]);
  expect(CreateConversationSchema.parse(parsed)).toEqual(parsed);
  const add = AddMembersSchema.parse({ members: parsed.members });
  expect(AddMembersSchema.parse(add)).toEqual(add);
  expect(AddMembersSchema.safeParse({ members: [{ type: "user", userId: id, groupId: id }] }).success).toBeFalse();
  expect(AddMembersSchema.safeParse({ members: Array(101).fill({ type: "group", groupId: id }) }).success).toBeFalse();
});
test("people query trims search and strictly validates bounded JSON cursors", () => {
  expect(PeopleQuerySchema.parse({ search: " Lea " })).toEqual({ search: "Lea" });
  const cursor = { name: "lea", id: lea };
  expect(PeopleQuerySchema.parse({ cursor: JSON.stringify(cursor) }).cursor).toEqual(cursor);
  for (const query of [
    { search: "a".repeat(101) },
    { cursor: "bad" },
    { cursor: JSON.stringify({ ...cursor, extra: true }) },
    { cursor: JSON.stringify({ name: "lea" }) },
  ]) {
    expect(PeopleQuerySchema.safeParse(query).success).toBeFalse();
  }
});
test("former entries preserve the whole localized label within a derived title", () => {
  const former = { displayName: "Old name", givenName: "Old", former: true };
  expect(deriveTitle(null, [former], "en")).toBe("Former account");
  expect(deriveTitle(null, [former], "de")).toBe("Ehemaliges Konto");
  expect(deriveTitle(null, [{ displayName: "Lea Example", givenName: "Lea" }, former], "en")).toBe("Lea, Former account");
});

test("personal read contracts reject unsafe seqs, unknown input fields and unbounded unread", async () => {
  const { ReadSchema, MarkUnreadSchema, ReadAllSchema, ReadStateSchema, ReadUpdateSchema, ReadAllOutcomeSchema } = await import(
    "./contracts"
  );
  for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(ReadSchema.safeParse({ seq }).success).toBeFalse();
  expect(ReadSchema.parse({ seq: Number.MAX_SAFE_INTEGER })).toEqual({ seq: Number.MAX_SAFE_INTEGER, thread: "general" });
  expect(ReadSchema.safeParse({ seq: 1, lastReadAt: "now" }).success).toBeFalse();
  expect(MarkUnreadSchema.parse({})).toEqual({});
  expect(MarkUnreadSchema.safeParse({ message: "bad" }).success).toBeFalse();
  expect(ReadAllSchema.parse({})).toEqual({ confirmed: false });
  expect(ReadAllSchema.safeParse({ extra: true }).success).toBeFalse();
  const state = { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 };
  expect(ReadStateSchema.parse(state)).toEqual(state);
  expect(ReadStateSchema.safeParse({ ...state, unreadFromSeq: 0 }).success).toBeFalse();
  const update = { threads: [], ...state, conversationId: "abcdef", unread: 100, asOfRev: 1 };
  expect(ReadUpdateSchema.safeParse(update).success).toBeTrue();
  expect(ReadUpdateSchema.safeParse({ ...update, unread: 101 }).success).toBeFalse();
  expect(ReadUpdateSchema.safeParse({ ...update, asOfRev: undefined }).success).toBeFalse();
  expect(ReadAllOutcomeSchema.parse({ outcome: "done", marked: 50, more: true })).toMatchObject({ marked: 50 });
});

test("member query bounds search and strictly decodes opaque name and access-ID cursors", () => {
  expect(MemberQuerySchema.parse({ q: " Lea " })).toEqual({ q: "Lea" });
  expect(MemberQuerySchema.parse({ q: "  " })).toEqual({ q: "" });
  const cursor = { name: "lea", id: lea };
  expect(MemberQuerySchema.parse({ cursor: JSON.stringify(cursor) }).cursor).toEqual(cursor);
  for (const query of [
    { q: "a".repeat(101) },
    { cursor: lea },
    { cursor: "malformed" },
    { cursor: "x".repeat(2001) },
    { cursor: JSON.stringify({ ...cursor, extra: true }) },
    { cursor: JSON.stringify({ name: "lea" }) },
    { cursor: JSON.stringify({ name: "lea", id: "bad" }) },
    { unknown: true },
  ])
    expect(MemberQuerySchema.safeParse(query).success).toBeFalse();
  expect(MemberPreviewSchema.parse({ joining: 2, throughGroups: 1, memberCount: 3 })).toEqual({
    joining: 2,
    throughGroups: 1,
    memberCount: 3,
  });
  expect(MemberPreviewSchema.safeParse({ joining: -1, throughGroups: 0, memberCount: 3 }).success).toBeFalse();
  expect(MemberPreviewSchema.safeParse({ joining: 1.5, throughGroups: 0, memberCount: 3 }).success).toBeFalse();
});

test("thread input is strict, bounded, trimmed and supports explicit read selectors", async () => {
  const { CreateThreadSchema, UpdateThreadSchema, ThreadIdSchema, ThreadSelectorSchema, ReadSchema, SnapshotQuerySchema } = await import(
    "./contracts"
  );
  expect(CreateThreadSchema.parse({ name: " Work ", description: " " })).toEqual({ name: "Work", description: null });
  for (const input of [
    { name: " " },
    { name: "a".repeat(81) },
    { name: "A", description: "b".repeat(81) },
    { name: "A", extra: true },
    { name: "A", description: "two\nlines" },
  ]) {
    expect(CreateThreadSchema.safeParse(input).success).toBeFalse();
  }
  expect(UpdateThreadSchema.safeParse({}).success).toBeFalse();
  expect(UpdateThreadSchema.parse({ archived: false })).toEqual({ archived: false });
  expect(ThreadIdSchema.safeParse("general").success).toBeFalse();
  for (const thread of ["general", "abc123"]) {
    expect(ThreadSelectorSchema.safeParse(thread).success).toBeTrue();
    expect(SnapshotQuerySchema.parse({ thread })).toEqual({ thread });
  }
  expect(ReadSchema.parse({ seq: 1, thread: "all" })).toEqual({ seq: 1, thread: "all" });
  expect(SnapshotQuerySchema.safeParse({ thread: "all" }).success).toBeFalse();
});

test("system chat contracts constrain containers, item metadata and paging", () => {
  for (const resourceType of ["spaces.space", "notebooks.notebook"])
    expect(SystemChatParamSchema.safeParse({ resourceType, resourceId: "abcdef" }).success).toBeTrue();
  expect(SystemChatParamSchema.safeParse({ resourceType: "spaces.item", resourceId: "abcdef" }).success).toBeFalse();
  expect(ForResourceSchema.parse({ ref: { type: "notebooks.note", id: "note01" } })).toEqual({
    ref: { type: "notebooks.note", id: "note01" },
  });
  expect(ThreadQuerySchema.parse({ filter: "unread", q: " task ", cursor: "abcdef" })).toEqual({
    filter: "unread",
    q: "task",
    cursor: "abcdef",
  });
  for (const query of [{ filter: "archived" }, { q: "x".repeat(101) }, { cursor: "not-a-cursor" }])
    expect(ThreadQuerySchema.safeParse(query).success).toBeFalse();
  expect(
    ThreadResourceSchema.safeParse({ ref: { type: "spaces.item", id: "item01" }, kind: "task", status: null, done: false, href: "/item" })
      .success,
  ).toBeTrue();
  expect(
    ThreadResourceSchema.safeParse({ ref: { type: "spaces.item", id: "item01" }, kind: "task", status: null, href: "/item" }).success,
  ).toBeFalse();
});

test("summary and read-all continuations reject malformed state and preserve an unstarted thread page", () => {
  for (const thread of [undefined, "", "abcdef"]) {
    const cursor = { at: "2026-10-01T00:00:00.000123Z", id: "ghijkl", ...(thread !== undefined ? { thread } : {}) };
    expect(ReadAllSchema.parse({ confirmed: true, cursor: JSON.stringify(cursor) }).cursor).toEqual(cursor);
  }
  expect(SummaryQuerySchema.parse({ summaryCursor: "" }).summaryCursor).toBe("");
  for (const cursor of ["bad", "{}", JSON.stringify({ at: "bad", id: "abcdef" }), "x".repeat(257)])
    expect(ReadAllSchema.safeParse({ cursor }).success).toBeFalse();
  expect(SummaryQuerySchema.safeParse({ summaryCursor: "not-a-thread" }).success).toBeFalse();
});

test("channel discovery accepts bounded distinct audiences and service-account members", async () => {
  const { ChannelQuerySchema, DiscoveryEntriesSchema, DiscoveryUpdateSchema, SystemMessageSchema } = await import("./contracts");
  const entries = [
    { principal: { type: "group" as const, groupId: lea }, permission: "write" as const },
    { principal: { type: "authenticated" as const }, permission: "read" as const },
  ];
  expect(DiscoveryEntriesSchema.parse(entries)).toEqual(entries);
  for (const invalid of [
    [...entries, entries[0]],
    [{ principal: { type: "user", userId: lea }, permission: "read" }],
    [{ principal: { type: "authenticated" }, permission: "admin" }],
    Array(101).fill(entries[0]),
  ])
    expect(DiscoveryEntriesSchema.safeParse(invalid).success).toBeFalse();
  expect(DiscoveryUpdateSchema.parse({ entries: [], name: "  News  " })).toEqual({ entries: [], name: "News" });
  const principal = { type: "service_account" as const, serviceAccountId: lea };
  expect(AddMembersSchema.parse({ members: [principal, principal] }).members).toEqual([principal]);
  expect(CreateConversationSchema.parse({ discovery: entries, members: [principal] }).discovery).toEqual(entries);
  expect(ChannelQuerySchema.parse({ q: " News ", cursor: JSON.stringify({ name: "news", id: lea }) })).toEqual({
    q: "News",
    cursor: { name: "news", id: lea },
  });
  expect(ChannelQuerySchema.safeParse({ cursor: "invalid" }).success).toBeFalse();
  expect(ChannelQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBeFalse();
  expect(SystemMessageSchema.parse({ code: "discovery_changed", params: { count: 2 } }).code).toBe("discovery_changed");
  expect(ConversationSchema.shape.channel.parse(true)).toBeTrue();
  expect(ConversationSchema.shape.member.parse(false)).toBeFalse();
});
