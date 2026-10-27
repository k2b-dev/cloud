import { expect, test } from "bun:test";
import { decodeActivityCursor } from "./activity";

test("validates Spaces activity cursors", () => {
  const encoded = Buffer.from(JSON.stringify({ version: 1, lastOccurredAt: "2026-08-20T10:00:00.000Z", id: "42" })).toString("base64url");
  expect(decodeActivityCursor(encoded)).toEqual({ version: 1, lastOccurredAt: "2026-08-20T10:00:00.000Z", id: "42" });
  expect(() => decodeActivityCursor("broken")).toThrow("Invalid activity cursor");
});

test("retains database timestamp precision and rejects out-of-range activity positions", () => {
  const position = { version: 1, lastOccurredAt: "2026-10-23 12:00:00.000123+00", id: "9223372036854775807" } as const;
  expect(decodeActivityCursor(Buffer.from(JSON.stringify(position)).toString("base64url"))).toEqual(position);
  expect(() => decodeActivityCursor(Buffer.from(JSON.stringify({ ...position, id: "9223372036854775808" })).toString("base64url"))).toThrow(
    "Invalid activity cursor",
  );
});
