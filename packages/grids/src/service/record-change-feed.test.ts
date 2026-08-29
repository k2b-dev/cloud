import { describe, expect, test } from "bun:test";
import { decodeRecordChangeFeedCursor, encodeRecordChangeFeedCursor, listRecordChanges } from "./record-change-feed";

describe("Record change feed cursor", () => {
  const key = "record-change-feed-test-key";
  const scope = {
    baseId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a001",
    tableId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a002",
  };
  const boundary = {
    occurredAt: "2026-08-21T20:00:00.000Z",
    eventId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a003",
  };

  test("round-trips only in the signed Base and Table scope", () => {
    const cursor = encodeRecordChangeFeedCursor(scope, boundary, key);
    expect(decodeRecordChangeFeedCursor(cursor, scope, key)).toEqual(boundary);
    expect(decodeRecordChangeFeedCursor(cursor, { ...scope, tableId: null }, key)).toBeNull();
    expect(Buffer.from(cursor.split(".")[0]!, "base64url").toString("utf8")).not.toContain(scope.baseId);
  });

  test("rejects malformed, oversized and tampered cursors", () => {
    const cursor = encodeRecordChangeFeedCursor(scope, boundary, key);
    expect(decodeRecordChangeFeedCursor(`${cursor.slice(0, -1)}x`, scope, key)).toBeNull();
    expect(decodeRecordChangeFeedCursor("not-a-cursor", scope, key)).toBeNull();
    expect(decodeRecordChangeFeedCursor("x".repeat(2_001), scope, key)).toBeNull();
  });

  test("localizes invalid-cursor errors for regional German locales", async () => {
    const result = await listRecordChanges({ scope, cursor: "not-a-cursor", cursorSigningKey: key, locale: "de-CH" });
    expect(result).toEqual({
      ok: false,
      error: { code: "BAD_INPUT", status: 400, message: "Der Cursor des Datensatz-Änderungsfeeds ist ungültig." },
    });
  });
});
