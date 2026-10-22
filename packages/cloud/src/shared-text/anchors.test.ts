import { expect, test } from "bun:test";
import * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "./anchors";

const fixture = () => {
  const doc = new Y.Doc();
  doc.clientID = 101;
  const text = doc.getText("codemirror");
  text.insert(0, "| A | B |");
  return { doc, text };
};

test("character anchors survive unrelated offset shifts and snapshot reconstruction", () => {
  const { doc, text } = fixture();
  const copy = new Y.Doc();
  try {
    const anchor = captureTextAnchor(text, 4);
    text.insert(0, "Intro\n");
    expect(resolveTextAnchor(text, anchor)).toBe(10);
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(resolveTextAnchor(copy.getText("codemirror"), anchor)).toBe(10);
  } finally {
    doc.destroy();
    copy.destroy();
  }
});

test("deleted anchors reject identical replacements and neighbouring delimiters", () => {
  const { doc, text } = fixture();
  try {
    const middle = captureTextAnchor(text, 4);
    const last = captureTextAnchor(text, text.length - 1);
    text.delete(4, 1);
    expect(resolveTextAnchor(text, middle)).toBeNull();
    text.insert(4, "|");
    expect(resolveTextAnchor(text, middle)).toBeNull();
    text.delete(text.length - 1, 1);
    expect(resolveTextAnchor(text, last)).toBeNull();
    expect(resolveTextAnchor(text, captureTextAnchor(text, 4))).toBe(4);
  } finally {
    doc.destroy();
  }
});

test("undo does not revive the identity of a deleted target", () => {
  const { doc, text } = fixture();
  const history = new Y.UndoManager(text, { captureTimeout: 0 });
  try {
    const anchor = captureTextAnchor(text, 4);
    text.delete(4, 1);
    history.undo();
    expect(text.toString()).toBe("| A | B |");
    expect(resolveTextAnchor(text, anchor)).toBeNull();
    expect(resolveTextAnchor(text, captureTextAnchor(text, 4))).toBe(4);
  } finally {
    history.destroy();
    doc.destroy();
  }
});

test("unknown, malformed, boundary, and other shared-type anchors are rejected", () => {
  const { doc, text } = fixture();
  const other = new Y.Doc();
  other.clientID = 202;
  other.getText("codemirror").insert(0, "|");
  try {
    const heading = doc.getText("heading");
    heading.insert(0, "|");
    expect(resolveTextAnchor(text, captureTextAnchor(heading, 0))).toBeNull();
    expect(resolveTextAnchor(text, captureTextAnchor(other.getText("codemirror"), 0))).toBeNull();
    expect(resolveTextAnchor(text, new Uint8Array())).toBeNull();
    expect(resolveTextAnchor(text, Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, text.length)))).toBeNull();
    expect(resolveTextAnchor(text, Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 4, -1)))).toBeNull();
    for (const index of [-1, text.length, 0.5, NaN, Infinity]) expect(() => captureTextAnchor(text, index)).toThrow(RangeError);
    expect(() => captureTextAnchor(new Y.Text(), 0)).toThrow(RangeError);
  } finally {
    doc.destroy();
    other.destroy();
  }
});
