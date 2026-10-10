import { describe, expect, test } from "bun:test";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { codeFontExtension } from "./code-font";
import { listsExtension } from "./lists";
import { markdownExtension } from "./markdown";
import { markupExtension } from "./markup";
import { tagPillExtension } from "./tag-pill";

// CodeMirror parses a long note in steps: the first state holds a syntax tree for
// only the first few thousand characters, and the parser later delivers the rest in
// a transaction without a document change. Markers further down must render once
// that tree arrives, without waiting for an edit.
describe("editor decorations in a long note", () => {
  if (isServer) {
    test.skip("editor decorations run with browser export conditions", () => {});
    return;
  }

  const filler = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} with some ordinary prose.\n`).join("\n");
  const tail = [
    "### Late heading",
    "",
    "- [x] done task",
    "- [ ] open task",
    "- plain bullet",
    "",
    "Some *soft* and **loud** words with `inline code` and a [link](https://example.com) #latetag.",
    "",
    "```",
    "#notatag",
    "```",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| a | 1 |",
    "",
    "End.",
  ].join("\n");
  const doc = `${filler}\n${tail}`;

  test("renders markers after the parser delivers the rest of the tree without an edit", async () => {
    const dom = createDomTestHarness();
    document.documentElement.lang = "en";
    // These widgets load the shared UI, which needs the browser globals of the harness.
    const { linksExtension } = await import("./links");
    const { tablesExtension } = await import("./tables");
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [
          markdownExtension(),
          listsExtension(),
          markupExtension(),
          codeFontExtension(),
          tablesExtension("Nb12Cd"),
          linksExtension("Nb12Cd"),
          tagPillExtension("Nb12Cd"),
        ],
      }),
    });
    try {
      // The first tree stops long before the tail.
      expect(syntaxTree(view.state).length).toBeLessThan(doc.indexOf("### Late heading"));

      // Deliver the rest of the tree the way the background parser does: no document change.
      forceParsing(view, doc.length, 5000);
      expect(syntaxTree(view.state).length).toBe(doc.length);
      // The test DOM has no layout, so move the viewport to the tail explicitly.
      view.dispatch({ effects: EditorView.scrollIntoView(doc.length) });
      await Bun.sleep(0);

      const text = dom.root.textContent ?? "";
      const checkboxes = Array.from(dom.root.querySelectorAll<HTMLInputElement>("input.custom-list-task-marker"));
      expect(checkboxes.map((box) => box.checked)).toEqual([true, false]);
      expect(text).not.toContain("[x]");
      expect(text).toContain("plain bullet");
      expect(text).not.toContain("- plain bullet");
      expect(text).toContain("Late heading");
      expect(text).not.toContain("###");
      expect(text).toContain("Some soft and loud words");
      expect(dom.root.querySelector(".cm-md-code")?.textContent).toContain("inline code");
      expect(text).not.toContain("](https://example.com)");
      expect(Array.from(dom.root.querySelectorAll(".cm-tag-pill")).map((pill) => pill.textContent)).toEqual(["#latetag"]);
      expect(text).toContain("#notatag");
      expect(dom.root.querySelector(".cm-table-widget")).not.toBeNull();
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });
});
