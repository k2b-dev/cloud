import { describe, expect, test } from "bun:test";
import { decodeDslResultCursor, encodeDslResultCursor, gqlResultFingerprint } from "./result-cursor";

describe("GQL result cursors", () => {
  const signingKey = "gql-result-cursor-test-secret";

  test("round-trips opaque page state and normalizes serializable values", () => {
    const token = encodeDslResultCursor(
      {
        fingerprint: "query-fingerprint",
        pageSize: 75,
        start: 150,
        values: [12n, new Date("2026-07-16T10:00:00.000Z"), null],
      },
      signingKey,
    );

    expect(token).not.toContain("query-fingerprint");
    expect(decodeDslResultCursor(token, signingKey)).toEqual({
      fingerprint: "query-fingerprint",
      pageSize: 75,
      start: 150,
      values: ["12", "2026-07-16T10:00:00.000Z", null],
    });
  });

  test("rejects malformed and out-of-contract cursor payloads", () => {
    expect(decodeDslResultCursor("not-json", signingKey)).toBeNull();
    expect(
      decodeDslResultCursor(encodeDslResultCursor({ fingerprint: "x", start: 0, pageSize: 10, values: [] }, signingKey), "wrong-key"),
    ).toBeNull();
    expect(decodeDslResultCursor("x".repeat(16_385), signingKey)).toBeNull();
  });

  test("falls back to a compact signed offset cursor for oversized sort values", () => {
    const token = encodeDslResultCursor({ fingerprint: "x", start: 10, pageSize: 10, values: ["x".repeat(20_000)] }, signingKey);

    expect(token.length).toBeLessThanOrEqual(16_384);
    expect(decodeDslResultCursor(token, signingKey)).toEqual({
      fingerprint: "x",
      start: 10,
      pageSize: 10,
      values: null,
    });
  });

  test("rejects cursor payload tampering", () => {
    const token = encodeDslResultCursor({ fingerprint: "x", start: 10, pageSize: 10, values: ["one"] }, signingKey);
    const [payload, signature] = token.split(".");
    const parsed = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    parsed.s = 0;
    const tampered = `${Buffer.from(JSON.stringify(parsed)).toString("base64url")}.${signature}`;
    expect(decodeDslResultCursor(tampered, signingKey)).toBeNull();
  });

  test("fingerprints bind continuation state to base, source, and scope", () => {
    const first = gqlResultFingerprint({ baseId: "base-a", canonicalSource: "from table A", scope: "view:one" });
    expect(first).toBe(gqlResultFingerprint({ baseId: "base-a", canonicalSource: "from table A", scope: "view:one" }));
    expect(first).not.toBe(gqlResultFingerprint({ baseId: "base-b", canonicalSource: "from table A", scope: "view:one" }));
    expect(first).not.toBe(gqlResultFingerprint({ baseId: "base-a", canonicalSource: "from table B", scope: "view:one" }));
    expect(first).not.toBe(gqlResultFingerprint({ baseId: "base-a", canonicalSource: "from table A", scope: "view:two" }));
  });
});

test("existing result cursors verify throughout both ring overlaps and fail after root removal", () => {
  const cursor = { fingerprint: "listing", pageSize: 10, start: 20, values: ["next"] };
  const token = encodeDslResultCursor(cursor, "A");
  expect(decodeDslResultCursor(token, ["B", "A"])).toEqual(cursor);
  expect(decodeDslResultCursor(token, ["A", "B"])).toEqual(cursor);
  expect(decodeDslResultCursor(token, ["B"])).toBeNull();
});
