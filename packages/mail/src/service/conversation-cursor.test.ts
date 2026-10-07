import { describe, expect, test } from "bun:test";
import { type ConversationCursorScope, decodeConversationCursor, encodeConversationCursor } from "./conversation-cursor";

const scope: ConversationCursorScope = {
  mailboxId: "00000000-0000-4000-8000-000000000001",
  folderId: "00000000-0000-4000-8000-000000000002",
  excludedFolderIds: ["00000000-0000-4000-8000-000000000007"],
  status: "needs_action",
  view: "needs_action",
  unread: true,
  userId: "00000000-0000-4000-8000-000000000003",
};

describe("conversation pagination cursor", () => {
  for (const date of ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000200Z"]) {
    test(`decodes an existing cursor without changing timestamp precision: ${date}`, () => {
      const cursor = Buffer.from(JSON.stringify({ version: 4, scope, date, id: "00000000-0000-4000-8000-000000000004" })).toString(
        "base64url",
      );
      const decoded = decodeConversationCursor(cursor, scope);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.data?.date).toBe(date);
    });
  }

  test("round-trips within the original query scope", () => {
    const encoded = encodeConversationCursor({
      scope,
      date: "2026-07-22T10:15:00.000Z",
      id: "00000000-0000-4000-8000-000000000004",
    });

    const decoded = decodeConversationCursor(encoded, scope);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.data).toMatchObject({ version: 4, scope, date: "2026-07-22T10:15:00.000Z" });
  });

  test("rejects cursors reused for another mailbox, filter, or user", () => {
    const encoded = encodeConversationCursor({
      scope,
      date: "2026-07-22T10:15:00.000Z",
      id: "00000000-0000-4000-8000-000000000004",
    });

    expect(decodeConversationCursor(encoded, { ...scope, mailboxId: "00000000-0000-4000-8000-000000000005" }).ok).toBe(false);
    expect(decodeConversationCursor(encoded, { ...scope, view: "done" }).ok).toBe(false);
    expect(decodeConversationCursor(encoded, { ...scope, unread: false }).ok).toBe(false);
    expect(decodeConversationCursor(encoded, { ...scope, excludedFolderIds: [] }).ok).toBe(false);
    expect(decodeConversationCursor(encoded, { ...scope, userId: "00000000-0000-4000-8000-000000000006" }).ok).toBe(false);
  });

  test("rejects legacy, malformed, and non-date cursors", () => {
    const legacy = Buffer.from(
      JSON.stringify({ version: 1, date: "2026-07-22T10:15:00.000Z", id: "00000000-0000-4000-8000-000000000004" }),
    ).toString("base64url");
    const invalidDate = Buffer.from(
      JSON.stringify({
        version: 4,
        scope,
        date: "not-a-date",
        id: "00000000-0000-4000-8000-000000000004",
      }),
    ).toString("base64url");

    expect(decodeConversationCursor(legacy, scope).ok).toBe(false);
    expect(decodeConversationCursor(invalidDate, scope).ok).toBe(false);
    expect(decodeConversationCursor("not-base64-json", scope).ok).toBe(false);
  });
});
