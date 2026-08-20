import { describe, expect, test } from "bun:test";
import { decodeActivityCursor, encodeActivityCursor } from "./activity";

describe("notebook activity cursor", () => {
  test("round-trips the stable activity position", () => {
    const cursor = {
      id: "9223372036854775807",
      lastOccurredAt: "2026-08-20T10:15:00.000Z",
    };

    expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual({
      version: 1,
      ...cursor,
    });
  });

  test.each([
    "not-base64-json",
    Buffer.from(JSON.stringify({ version: 1, id: "1" })).toString("base64url"),
    Buffer.from(JSON.stringify({ version: 1, id: "0", lastOccurredAt: "2026-08-20T10:15:00.000Z" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify({ version: 1, id: "1", lastOccurredAt: "not-a-date" })).toString("base64url"),
  ])("rejects an invalid cursor", (cursor) => {
    expect(() => decodeActivityCursor(cursor)).toThrow("Invalid activity cursor");
  });
});
