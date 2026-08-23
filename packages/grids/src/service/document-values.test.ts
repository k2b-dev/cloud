import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { decodeDocumentCursor, encodeDocumentCursor } from "./document-values";

describe("document cursors", () => {
  test("round-trips a valid created-at and UUID pair", () => {
    const value = { createdAt: "2026-07-14T00:00:00.000Z", id: "11111111-1111-4111-8111-111111111111" };
    expect(decodeDocumentCursor(encodeDocumentCursor(value))).toEqual(value);
  });

  test("rejects structurally valid cursors with invalid SQL values", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    expect(decodeDocumentCursor(encode({ createdAt: "not-a-date", id: "not-a-uuid" }))).toBeNull();
    expect(decodeDocumentCursor(encode({ createdAt: "2026-07-14T00:00:00.000Z", id: "not-a-uuid" }))).toBeNull();
  });
});
