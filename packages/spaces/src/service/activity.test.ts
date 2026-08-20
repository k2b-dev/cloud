import { expect, test } from "bun:test";
import { decodeActivityCursor } from "./activity";

test("validates Spaces activity cursors", () => {
  const encoded = Buffer.from(JSON.stringify({ version: 1, lastOccurredAt: "2026-08-20T10:00:00.000Z", id: "42" })).toString("base64url");
  expect(decodeActivityCursor(encoded)).toEqual({ version: 1, lastOccurredAt: "2026-08-20T10:00:00.000Z", id: "42" });
  expect(() => decodeActivityCursor("broken")).toThrow("Invalid activity cursor");
});
