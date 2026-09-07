import { describe, expect, test } from "bun:test";
import { compareStreamCursor, fromBase64, maxStreamCursor, parseStreamCursor, toBase64 } from "./yjs-sync";

describe("notebook Yjs stream helpers", () => {
  test("parses and orders valid stream cursors", () => {
    expect(parseStreamCursor("s6t.abc.2")).toEqual({ resource: "abc", seq: 2 });
    expect(parseStreamCursor("invalid")).toBeNull();
    expect(parseStreamCursor("100-2")).toBeNull();
    expect(() => compareStreamCursor("s6t.abc.2", "s6t.other.3")).toThrow();
    expect(parseStreamCursor("s6t.abc.9007199254740992")).toBeNull();
    expect(compareStreamCursor("s6t.abc.2", "s6t.abc.3")).toBeLessThan(0);
    expect(maxStreamCursor("s6t.abc.2", "s6t.abc.10")).toBe("s6t.abc.10");
  });

  test("round-trips base64 and rejects malformed updates", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(() => fromBase64("not base64!")).toThrow(TypeError);
  });
});
