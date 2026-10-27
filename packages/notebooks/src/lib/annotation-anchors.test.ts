import { expect, test } from "bun:test";
import { SHARED_TEXT_NAME } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import {
  absoluteAnnotationPosition,
  annotationContext,
  annotationHeadingPath,
  annotationPositions,
  locateAnnotation,
  locateAnnotationPassage,
  resolveAnnotation,
} from "./annotation-anchors";

const fixture = (source = "Before target after") => {
  const doc = new Y.Doc();
  doc.clientID = 100;
  const text = doc.getText(SHARED_TEXT_NAME);
  text.insert(0, source);
  const from = source.indexOf("target");
  const positions = annotationPositions(doc, from, from + 6);
  return { doc, text, from, positions, selector: { quote: "target", prefix: source.slice(0, from), suffix: source.slice(from + 6) } };
};
const resolve = (value: ReturnType<typeof fixture>, sameRevision = true) =>
  resolveAnnotation({
    doc: value.doc,
    ...value.positions,
    selector: value.selector,
    start: value.positions.start,
    end: value.positions.end,
    sameRevision,
  });
test("typing at both edges leaves the selected characters outside new text", () => {
  const value = fixture();
  try {
    value.text.insert(value.from + 6, "RIGHT");
    value.text.insert(value.from, "LEFT");
    const range = resolve(value);
    expect(range).toMatchObject({ from: value.from + 4, to: value.from + 10, orphan: false });
    expect(value.text.toString().slice(range.from, range.to)).toBe("target");
  } finally {
    value.doc.destroy();
  }
});
test("concurrent edits before, inside and after the passage resolve identically after replay", () => {
  const value = fixture();
  const remote = new Y.Doc();
  remote.clientID = 101;
  try {
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(value.doc));
    value.text.insert(0, "Local ");
    const text = remote.getText(SHARED_TEXT_NAME);
    text.insert(value.from + 3, "X");
    text.insert(text.length, " Remote");
    const update = Y.encodeStateAsUpdate(remote);
    Y.applyUpdate(value.doc, update);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(value.doc));
    const local = resolve(value);
    const other = resolveAnnotation({
      doc: remote,
      start: value.positions.start,
      end: value.positions.end,
      selector: value.selector,
      sameRevision: true,
    });
    expect(local).toEqual(other);
    expect(value.text.toString().slice(local.from, local.to)).toBe("tarXget");
  } finally {
    value.doc.destroy();
    remote.destroy();
  }
});
test("deletion orphans a quote and a contextual reinsertion reanchors every replayed client", () => {
  const value = fixture();
  const remote = new Y.Doc();
  try {
    value.text.delete(value.from, 6);
    expect(resolve(value)).toMatchObject({ orphan: true, from: value.from, to: value.from });
    value.text.insert(value.from, "target");
    const result = resolve(value);
    expect(result).toMatchObject({ orphan: false, reanchored: true, from: value.from, to: value.from + 6 });
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(value.doc));
    expect(
      resolveAnnotation({
        doc: remote,
        start: value.positions.start,
        end: value.positions.end,
        selector: value.selector,
        sameRevision: true,
      }),
    ).toEqual(result);
  } finally {
    value.doc.destroy();
    remote.destroy();
  }
});
test("deleting one of two equal passages cannot reanchor to the other", () => {
  const value = fixture("First target end\nSecond target done");
  try {
    value.text.delete(value.from, 6);
    expect(resolve(value).orphan).toBeTrue();
    expect(locateAnnotation("target target", { quote: "target", prefix: "", suffix: "" })).toBeNull();
  } finally {
    value.doc.destroy();
  }
});
test("restore revisions invalidate positions and need a unique context match", () => {
  const value = fixture();
  const restored = new Y.Doc();
  restored.clientID = 102;
  try {
    restored.getText(SHARED_TEXT_NAME).insert(0, "Before target after");
    expect(absoluteAnnotationPosition(restored, value.positions.start)).toBeNull();
    expect(
      resolveAnnotation({
        doc: restored,
        start: value.positions.start,
        end: value.positions.end,
        selector: value.selector,
        sameRevision: false,
      }),
    ).toMatchObject({ orphan: false, reanchored: true, from: 7, to: 13 });
    value.selector.prefix = "different";
    expect(
      resolveAnnotation({
        doc: restored,
        start: value.positions.start,
        end: value.positions.end,
        selector: value.selector,
        sameRevision: false,
      }).orphan,
    ).toBeTrue();
  } finally {
    value.doc.destroy();
    restored.destroy();
  }
});
test("quote-only recovery and a far-away strong match stay orphaned", () => {
  const value = fixture();
  try {
    value.text.delete(value.from, 6);
    value.text.insert(value.text.length, `${" ".repeat(40)}Before target after`);
    expect(resolve(value).orphan).toBeTrue();
    value.selector = { quote: "target", prefix: "", suffix: "" };
    expect(resolve(value).orphan).toBeTrue();
  } finally {
    value.doc.destroy();
  }
});
test("heading paths ignore code fences and preserve source offsets", () => {
  const source = "# Handbook\n## Plan\n```md\n# Example\n```\n### Next\ntarget\n";
  expect(annotationHeadingPath(source, source.indexOf("target"))).toEqual(["Handbook", "Plan", "Next"]);
});

test("Yjs undo resolves consistently for the local author, a remote client and a fresh replay", () => {
  const value = fixture();
  const remote = new Y.Doc();
  const replay = new Y.Doc();
  const undo = new Y.UndoManager(value.text);
  try {
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(value.doc));
    value.text.delete(value.from, 6);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(value.doc));
    expect(resolve(value).orphan).toBeTrue();
    undo.undo();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(value.doc));
    Y.applyUpdate(replay, Y.encodeStateAsUpdate(remote));
    const expected = resolve(value);
    expect(expected.orphan).toBeFalse();
    for (const doc of [remote, replay])
      expect(
        resolveAnnotation({ doc, start: value.positions.start, end: value.positions.end, selector: value.selector, sameRevision: true }),
      ).toEqual(expected);
  } finally {
    undo.destroy();
    value.doc.destroy();
    remote.destroy();
    replay.destroy();
  }
});

test("canonical context does not split surrogate pairs at its UTF-16 boundaries", () => {
  const prefix = "😀" + "a".repeat(31);
  const suffix = "b".repeat(31) + "😀";
  const text = prefix + "target" + suffix;
  expect(annotationContext(text, prefix.length, prefix.length + 6)).toEqual({ prefix: "a".repeat(31), suffix: "b".repeat(31) });
});

test("relative positions resolve before a replayed document text has been opened", () => {
  const value = fixture();
  const replay = new Y.Doc();
  try {
    Y.applyUpdate(replay, Y.encodeStateAsUpdate(value.doc));
    expect(absoluteAnnotationPosition(replay, value.positions.start)).toBe(value.from);
    expect(absoluteAnnotationPosition(replay, value.positions.end)).toBe(value.from + 6);
  } finally {
    value.doc.destroy();
    replay.destroy();
  }
});

test("creation distinguishes repeated exact quotes and selects their 1-based occurrence", () => {
  const text = "Before target after; second target done";
  const selector = { quote: "target", prefix: "", suffix: "" };
  expect(locateAnnotationPassage(text, selector)).toEqual({ from: null, matches: 2, ambiguous: true });
  expect(locateAnnotationPassage(text, selector, undefined, 2)).toEqual({ from: text.lastIndexOf("target"), matches: 2, ambiguous: false });
  expect(locateAnnotationPassage(text, selector, undefined, 3)).toEqual({ from: null, matches: 2, ambiguous: false });
  expect(locateAnnotationPassage(text, { ...selector, prefix: "second " })).toEqual({
    from: text.lastIndexOf("target"),
    matches: 2,
    ambiguous: false,
  });
  expect(locateAnnotationPassage(text, selector, text.lastIndexOf("target"))).toEqual({
    from: text.lastIndexOf("target"),
    matches: 2,
    ambiguous: false,
  });
  expect(locateAnnotationPassage(text, { ...selector, quote: "absent" })).toEqual({ from: null, matches: 0, ambiguous: false });
});
