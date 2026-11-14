import { afterAll, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commands } from "../src/text-editor/format";
import { createDomTestHarness } from "./dom";

const dom = createDomTestHarness();
afterAll(dom.cleanup);
test.each([
  ["one\ntwo\nthree", 0, "1. one\n2. two\n3. three"],
  ["8. previous\none\ntwo", 12, "8. previous\n9. one\n10. two"],
  ["1. one\n2. two", 0, "one\ntwo"],
  ["8. first\nsecond", 0, "8. first\n9. second"],
  ["  one\n  two", 0, "  1. one\n  2. two"],
])("ordered toolbar action numbers selected lines: %s", (doc, from, expected) => {
  const view = new EditorView({ parent: dom.root, state: EditorState.create({ doc, selection: { anchor: from, head: doc.length } }) });
  try {
    commands.orderedList(view);
    expect(view.state.doc.toString()).toBe(expected);
  } finally {
    view.destroy();
  }
});
