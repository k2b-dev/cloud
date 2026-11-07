import { expect, test } from "bun:test";
import { ChangesQuerySchema, MessageQuerySchema, MessageSchema, SendMessageSchema } from "./contracts";
import { chatLiveUpdates } from "./live-updates";
import { type MessageRow, projectMessage } from "./message-store";

test("client IDs and Markdown are bounded without trimming content or splitting emoji", () => {
  for (const clientId of ["", "a!", "a".repeat(65)]) expect(SendMessageSchema.safeParse({ clientId, body: "hello" }).success).toBeFalse();
  for (const body of ["", " \n\t", "hello\u0000world", "a".repeat(20_001), "😀".repeat(20_001)])
    expect(SendMessageSchema.safeParse({ clientId: "a_-0", body }).success).toBeFalse();
  const body = "😀".repeat(20_000);
  expect(SendMessageSchema.parse({ clientId: "a".repeat(64), body }).body).toBe(body);
  expect(SendMessageSchema.parse({ clientId: "ok", body: " \n**hello**\n " }).body).toBe(" \n**hello**\n ");
});
test("a stored message keeps the clientId it was sent with in views and live events, so the sender replaces its send", () => {
  const row: MessageRow = {
    short_id: "Message001",
    seq: "1",
    rev: "1",
    kind: "text",
    author_type: "user",
    author_id: "11111111-1111-4111-8111-111111111111",
    author_name: "Robin Example",
    body_md: "hello",
    client_id: "send_1",
    refs: [],
    links: [],
    system_code: null,
    system_params: null,
    created_at: new Date("2026-10-14T10:00:00.000Z"),
    thread_id: null,
    reply_to_seq: null,
  };
  const message = projectMessage(row, "Chat01");
  expect(MessageSchema.parse(message).clientId).toBe("send_1");
  const [live] = chatLiveUpdates("Chat01", message, "hello", []);
  expect(live?.data.type === "message" && live.data.message.clientId).toBe("send_1");
  const system = {
    ...row,
    kind: "system" as const,
    body_md: null,
    client_id: null,
    system_code: "conversation_created",
    system_params: {},
  };
  expect(projectMessage(system, "Chat01").clientId).toBeNull();
});
test("history cursors are mutually exclusive safe integers; after and delta accept zero, before stays positive", () => {
  for (const query of [
    { before: 1, after: 2 },
    { before: 0 },
    { after: -1 },
    { after: 1.5 },
    { before: Number.MAX_SAFE_INTEGER + 1 },
    { after: "bad" },
    { before: "" },
    { after: "1e2" },
  ])
    expect(MessageQuerySchema.safeParse(query).success).toBeFalse();
  expect(MessageQuerySchema.parse({ before: "12" })).toEqual({ before: 12 });
  expect(MessageQuerySchema.parse({ after: "0" })).toEqual({ after: 0 });
  expect(MessageQuerySchema.parse({})).toEqual({});
  expect(ChangesQuerySchema.parse({ afterRev: "0" })).toEqual({ afterRev: 0 });
  for (const afterRev of [-1, "", " ", 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(ChangesQuerySchema.safeParse({ afterRev }).success).toBeFalse();
});

test("an empty group membership change still invalidates conversation and sidebar access", () => {
  const message = MessageSchema.parse({
    thread: null,
    replyTo: null,
    id: "0123456789",
    conversationId: "abcdef",
    seq: 1,
    rev: 1,
    kind: "system",
    author: { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "Alex" },
    body: null,
    reactions: [],
    mentions: [],
    refs: [],
    attachments: [],
    system: { code: "groups_added", params: { groups: [{ id: "22222222-2222-4222-8222-222222222222", name: "Empty" }] } },
    createdAt: "2026-10-12T00:00:00.000Z",
  });
  const rows = chatLiveUpdates("abcdef", message, null, []);
  expect(rows.map((row) => ({ key: row.key, access: row.access }))).toEqual([
    { key: "c:abcdef", access: true },
    { key: "l:abcdef", access: true },
  ]);
});
