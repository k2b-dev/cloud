import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  applyYjsTopicEvent,
  compareStreamCursor,
  fromBase64,
  isValidYjsUpdate,
  MalformedSyncEventError,
  maxStreamCursor,
  parseStreamCursor,
  toBase64,
} from "./yjs-sync";

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

  test("accepts only decodable Yjs updates at ingress", () => {
    const doc = new Y.Doc();
    doc.getText("codemirror").insert(0, "hello");
    const update = toBase64(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    expect(isValidYjsUpdate(update)).toBe(true);
    expect(isValidYjsUpdate("not base64!")).toBe(false);
    // Valid base64 that is not a Yjs update must be rejected before it is retained.
    expect(isValidYjsUpdate(toBase64(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255])))).toBe(false);
  });

  test("a malformed retained event is a typed, non-retryable replay failure", () => {
    const doc = new Y.Doc();
    try {
      const event = {
        cursor: "s6t.abc.4",
        data: { kind: "sync" as const, payload: toBase64(new Uint8Array([255, 255, 255, 255])), originNodeId: "n", originPeerId: null },
      };
      expect(() => applyYjsTopicEvent(doc, event, "note-1")).toThrow(MalformedSyncEventError);
      try {
        applyYjsTopicEvent(doc, event, "note-1");
      } catch (error) {
        expect(error).toMatchObject({ noteId: "note-1", cursor: "s6t.abc.4" });
      }
    } finally {
      doc.destroy();
    }
  });
});
