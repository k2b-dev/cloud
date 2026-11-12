import { describe, expect, test } from "bun:test";
import { decodeReferencedByCursor, encodeReferencedByCursor } from "./referenced-by";

const key = "referenced-by-test-key";
const scope = {
  targetTableId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a001",
  targetRecordId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a002",
  relationFieldId: "field1",
};

describe("referenced-by cursor", () => {
  test("round-trips public boundary IDs without exposing UUIDs", () => {
    const cursor = encodeReferencedByCursor(scope, { fieldId: "field1", recordId: "record" }, key);
    expect(decodeReferencedByCursor(cursor, scope, key)).toEqual({ fieldId: "field1", recordId: "record" });
    expect(Buffer.from(cursor.split(".")[0]!, "base64url").toString("utf8")).not.toContain(scope.targetRecordId);
  });

  test("rejects tampering and reuse with another target or filter", () => {
    const cursor = encodeReferencedByCursor(scope, { fieldId: "field1", recordId: "record" }, key);
    expect(decodeReferencedByCursor(`${cursor.slice(0, -1)}x`, scope, key)).toBeNull();
    expect(decodeReferencedByCursor(cursor, { ...scope, targetRecordId: "018f8df0-d9d3-7b31-8bf0-2cf733d4a003" }, key)).toBeNull();
    expect(decodeReferencedByCursor(cursor, { ...scope, relationFieldId: "field2" }, key)).toBeNull();
  });

  test("rejects malformed and oversized tokens", () => {
    expect(decodeReferencedByCursor("not-a-cursor", scope, key)).toBeNull();
    expect(decodeReferencedByCursor("x".repeat(2_001), scope, key)).toBeNull();
  });
});

test("reference cursors authenticate all overlapping roots without weakening their scope", () => {
  const boundary = { fieldId: "field1", recordId: "record" };
  const cursor = encodeReferencedByCursor(scope, boundary, "A");
  expect(decodeReferencedByCursor(cursor, scope, ["B", "A"])).toEqual(boundary);
  expect(decodeReferencedByCursor(cursor, { ...scope, relationFieldId: "field2" }, ["B", "A"])).toBeNull();
  expect(decodeReferencedByCursor(cursor, scope, ["B"])).toBeNull();
});
