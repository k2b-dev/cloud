import { describe, expect, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { handleSoftNoteNavigationRequests } from "../soft-navigation";
import { refreshMarkdownDecorationsEffect } from "./_lib/cursor-zone-field";
import { markdownExtension } from "./markdown";

describe("editor note links", () => {
  if (isServer) {
    test.skip("editor links run with browser export conditions", () => {});
    return;
  }

  test("a link to a heading renders as a note link and opens the note at the heading", async () => {
    const dom = createDomTestHarness();
    // The link widgets load the shared UI, which needs the browser globals of the harness.
    const { linksExtension } = await import("./links");
    const doc = "[Restore](note://Ab12Cd#restore) [Top](note://Ab12Cd#) [Code](javascript:alert(1))\n";
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdownExtension(), linksExtension("Nb12Cd")] }),
    });
    const opened: string[] = [];
    const stop = handleSoftNoteNavigationRequests(async (href) => {
      opened.push(href);
      return { kind: "applied", href };
    });
    try {
      forceParsing(view, doc.length, 5000);
      view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
      const links = Array.from(dom.root.querySelectorAll<HTMLElement>(".cm-note-link"));
      expect(links.map((link) => link.textContent)).toEqual(["Restore", "Top"]);
      expect(view.contentDOM.textContent).toContain("javascript:alert(1)");
      for (const link of links) link.click();
      await Bun.sleep(0);
      expect(opened).toEqual(["/app/notebooks/Nb12Cd/notes/Ab12Cd#heading-restore", "/app/notebooks/Nb12Cd/notes/Ab12Cd"]);
    } finally {
      stop();
      view.destroy();
      dom.cleanup();
    }
  });
});
