import { expect, test } from "bun:test";
import * as Y from "yjs";
import { resolveTextCursor } from "./relative-cursor";

test("cursor resolution accepts the existing text root and never creates foreign roots", () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  try {
    text.insert(0, "notes");
    const roots = [...doc.share.keys()];
    for (const tname of ["unknown-one", "unknown-two", "unknown-three"]) {
      expect(resolveTextCursor(text, { tname, item: null, type: null, assoc: 0 })).toBeNull();
      expect([...doc.share.keys()]).toEqual(roots);
    }
    for (const index of [0, 2, text.length]) {
      const at = Y.createRelativePositionFromTypeIndex(text, index);
      expect(resolveTextCursor(text, at)?.index).toBe(index);
      expect(resolveTextCursor(text, JSON.parse(JSON.stringify(at)))?.index).toBe(index);
    }
    expect(resolveTextCursor(text, null)).toBeNull();
    expect(resolveTextCursor(text, {})).toBeNull();
    expect(resolveTextCursor(text, { tname: "codemirror", item: { client: 999, clock: 999 } })).toBeNull();
    expect([...doc.share.keys()]).toEqual(roots);
  } finally {
    doc.destroy();
  }
});
