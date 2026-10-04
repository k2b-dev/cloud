import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { decodeRecordChangeFeedCursor, encodeRecordChangeFeedCursor, listRecordChanges } from "./record-change-feed";

describe("Record change feed cursor", () => {
  const key = "record-change-feed-test-key";
  const scope = {
    baseId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a001",
    tableId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a002",
  };
  const boundary = {
    txid: "4294967301",
    eventId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a003",
    occurredAt: new Date().toISOString(),
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

  test("asks holders of a signed version-1 cursor for a full rescan", async () => {
    const fingerprint = createHash("sha256").update(scope.baseId).update("\0").update(scope.tableId).digest("base64url");
    const payload = Buffer.from(JSON.stringify({ v: 1, f: fingerprint, at: boundary.occurredAt, id: boundary.eventId }), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", key).update("grids:record-change-feed-cursor:v1\0").update(payload).digest("base64url");
    const cursor = `${payload}.${signature}`;
    expect(decodeRecordChangeFeedCursor(cursor, scope, key)).toBe("expired");
    expect(await listRecordChanges({ scope, cursor, cursorSigningKey: key })).toEqual({
      ok: false,
      error: { code: "CONFLICT", status: 409, message: "The Record change-feed cursor has expired. Perform a full Record rescan." },
    });
  });

  test("localizes invalid-cursor errors for regional German locales", async () => {
    const result = await listRecordChanges({ scope, cursor: "not-a-cursor", cursorSigningKey: key, locale: "de-CH" });
    expect(result).toEqual({
      ok: false,
      error: { code: "BAD_INPUT", status: 400, message: "Der Cursor des Datensatz-Änderungsfeeds ist ungültig." },
    });
  });
});
