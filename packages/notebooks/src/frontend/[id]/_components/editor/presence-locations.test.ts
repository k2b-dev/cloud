import { expect, test } from "bun:test";
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
  const states = awareness.getStates();
  const remote = doc.clientID + 1;
  const cursor = { head: Y.createRelativePositionFromTypeIndex(text, markdown.indexOf("last")) };
  awareness.setLocalStateField("user", { userId: "self" });
  states.set(remote, { user: { userId: "jana" }, cursor });
  states.set(remote + 1, { user: { userId: "blurred" }, cursor: null });
  states.set(remote + 2, { user: { name: "Old client" }, cursor });
  try {
    expect(presenceLocations(participantCursors(awareness, text), markdown, extractHeadingLines(markdown))).toEqual({
      jana: { writing: true, headingId: "two", headingText: "Two" },
      blurred: { writing: false, headingId: null, headingText: null },
    });
    text.insert(0, "extra\n");
    const updated = text.toString();
    expect(presenceLocations(participantCursors(awareness, text), updated, extractHeadingLines(updated)).jana?.headingId).toBe("two");
    states.set(remote, { user: { userId: "jana" }, cursor: { head: {} } });
    expect(presenceLocations(participantCursors(awareness, text), updated, extractHeadingLines(updated)).jana).toEqual({
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
