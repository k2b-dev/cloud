import { expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { extractHeadingLines } from "../../../../lib/note-insights";
import { participantCursors, presenceLocations } from "./presence-locations";

test("remote relative cursors map to current headings; local and legacy clients are excluded", () => {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const text = doc.getText("codemirror");
  const markdown = "Intro\n# One\nbody\n## Two\nlast";
  text.insert(0, markdown);
  let document = Text.of(markdown.split("\n"));
  const lineAt = (position: number) => document.lineAt(position).number;
  const states = awareness.getStates();
  const remote = doc.clientID + 1;
  const cursor = { head: Y.createRelativePositionFromTypeIndex(text, markdown.indexOf("last")) };
  awareness.setLocalStateField("user", { userId: "self" });
  states.set(remote, { user: { userId: "jana" }, cursor });
  states.set(remote + 1, { user: { userId: "blurred" }, cursor: null });
  states.set(remote + 2, { user: { name: "Old client" }, cursor });
  try {
    expect(presenceLocations(participantCursors(awareness, text), lineAt, extractHeadingLines(markdown))).toEqual({
      jana: { writing: true, headingId: "two", headingText: "Two" },
      blurred: { writing: false, headingId: null, headingText: null },
    });
    text.insert(0, "extra\n");
    const updated = text.toString();
    document = Text.of(updated.split("\n"));
    expect(presenceLocations(participantCursors(awareness, text), lineAt, extractHeadingLines(updated)).jana?.headingId).toBe("two");
    states.set(remote, { user: { userId: "jana" }, cursor: { head: {} } });
    expect(presenceLocations(participantCursors(awareness, text), lineAt, extractHeadingLines(updated)).jana).toEqual({
      writing: true,
      headingId: null,
      headingText: null,
    });
    states.delete(remote);
    expect(participantCursors(awareness, text).has("jana")).toBe(false);
  } finally {
    awareness.destroy();
    doc.destroy();
  }
});

test("presence resolves cursor lines and skips the resolver for missing positions", () => {
  const headings = extractHeadingLines("Intro\n# One\nbody\n## Two\nlast");
  const resolved: number[] = [];
  const lineAt = (position: number) => {
    resolved.push(position);
    return 5;
  };
  expect(
    presenceLocations(
      new Map([
        ["jana", { writing: true, position: 24 }],
        ["blurred", { writing: false, position: null }],
      ]),
      lineAt,
      headings,
    ),
  ).toEqual({
    jana: { writing: true, headingId: "two", headingText: "Two" },
    blurred: { writing: false, headingId: null, headingText: null },
  });
  expect(resolved).toEqual([24]);
});

test("foreign-root awareness never adds roots while resolving panel locations", () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  const awareness = new Awareness(doc);
  try {
    const roots = [...doc.share.keys()];
    for (const tname of ["unknown-one", "unknown-two", "unknown-three"]) {
      awareness.getStates().set(2 ** 32 + 1, { user: { userId: "peer" }, cursor: { head: { tname, item: null, type: null } } });
      expect(participantCursors(awareness, text).get("peer")?.position).toBeNull();
      expect([...doc.share.keys()]).toEqual(roots);
    }
    awareness.getStates().clear();
    expect(participantCursors(awareness, text).size).toBe(0);
    expect([...doc.share.keys()]).toEqual(roots);
  } finally {
    awareness.destroy();
    doc.destroy();
  }
});
