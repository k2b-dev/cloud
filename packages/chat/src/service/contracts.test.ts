import { describe, expect, test } from "bun:test";
import {
  AddMembersSchema,
  ChatLiveEventSchema,
  ConversationCursorSchema,
  ConversationQuerySchema,
  ConversationSchema,
  CreateConversationSchema,
  LeaveSchema,
  PeopleQuerySchema,
  UpdateConversationSchema,
  UpdateMemberSchema,
} from "./contracts";
import { deriveTitle } from "./titles";

const lea = "12345678-1234-4234-8234-123456789012";
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
