import { expect, test } from "bun:test";
import { ChatLiveEventSchema, ForYouPageSchema, ForYouQuerySchema } from "./contracts";
import { decodeForYouCursor } from "./for-you";

const cursor = { v: 1 as const, at: "2026-10-24T12:00:00.123456Z", id: "11111111-1111-4111-8111-111111111111" };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
test("opaque For you cursors preserve microseconds and reject malformed or unbounded state", () => {
  expect(decodeForYouCursor(encode(cursor))).toEqual(cursor);
  for (const value of [
    "",
    "!",
    "a".repeat(257),
    encode({ ...cursor, v: 2 }),
    encode({ ...cursor, at: "tomorrow" }),
    encode({ ...cursor, id: "bad" }),
    encode({ ...cursor, extra: true }),
    encode(null),
  ])
    expect(decodeForYouCursor(value)).toBeNull();
  expect(ForYouQuerySchema.safeParse({ cursor: "x".repeat(257) }).success).toBeFalse();
});
test("For you pages carry navigable system thread positions and untranslated kinds", () => {
  const item = {
    kind: "mention" as const,
    conversation: { id: "abcdef", title: "Project", kind: "system" as const },
    thread: { id: "fedcba", name: "Task" },
    message: {
      id: "message001",
      seq: 12,
      author: {
        type: "user" as const,
        id: cursor.id,
        name: "Mara",
      },
      preview: "Hello",
      createdAt: "2026-10-24T12:00:00.000Z",
    },
    unread: true,
  };
  expect(ForYouPageSchema.parse({ items: [item], nextCursor: null }).items[0]).toEqual(item);
  expect(ForYouPageSchema.safeParse({ items: Array(31).fill(item), nextCursor: null }).success).toBeFalse();
  expect(ForYouPageSchema.safeParse({ items: [{ ...item, kind: "erwähnung" }], nextCursor: null }).success).toBeFalse();
});
test("personal For you live updates carry no message or conversation data", () => {
  expect(ChatLiveEventSchema.parse({ type: "for-you" })).toEqual({ type: "for-you" });
  expect(ChatLiveEventSchema.safeParse({ type: "for-you", conversationId: "abcdef" }).success).toBeFalse();
});
