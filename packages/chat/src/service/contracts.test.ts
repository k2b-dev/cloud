import { describe, expect, test } from "bun:test";
import {
  AddMembersSchema,
  ConversationCursorSchema,
  ConversationQuerySchema,
  CreateConversationSchema,
  LeaveSchema,
  UpdateConversationSchema,
  UpdateMemberSchema,
} from "./contracts";
import { deriveTitle } from "./titles";

const lea = "12345678-1234-4234-8234-123456789012";
describe("conversation inputs", () => {
  test("defaults to an only-you chat and requires explicit duplicate creation", () => {
    expect(CreateConversationSchema.parse({})).toEqual({ members: [], allowDuplicate: false });
    expect(CreateConversationSchema.parse({ members: [lea, lea] }).members).toEqual([lea]);
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
      { members: Array(101).fill(lea) },
      { members: ["not-an-id"] },
    ]) {
      expect(CreateConversationSchema.safeParse(input).success).toBeFalse();
    }
    expect(CreateConversationSchema.safeParse({ icon: "ti ti-messages" }).success).toBeTrue();
    expect(AddMembersSchema.safeParse({ members: [] }).success).toBeFalse();
    expect(AddMembersSchema.safeParse({ members: Array(101).fill(lea) }).success).toBeFalse();
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
