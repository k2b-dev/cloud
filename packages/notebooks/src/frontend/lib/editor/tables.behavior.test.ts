import { describe, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { markdownExtension } from "./markdown";
import { tableColumnCompletionSource } from "./table-columns";

describe("Notebook table escaped pipes", () => {
  test("column completion keeps an escaped-pipe header inside its formula cell", () => {
    const doc = "| First \\| Last | Result |\n| --- | --- |\n| Ada | =SUM( |";
    const cursor = doc.lastIndexOf("(") + 1;
    const state = EditorState.create({ doc });
    const result = tableColumnCompletionSource(new CompletionContext(state, cursor, true));
    expect(result?.options.map((option) => option.label)).toEqual(["First | Last", "Result"]);
    expect(result?.options[0]?.apply).toBe("`First \\| Last`");
  });

  if (isServer) {
    test.skip("table previews run with browser export conditions", () => {});
    return;
  }

  for (const sourceVisible of [false, true]) {
    test(`escaped pipes preserve ${sourceVisible ? "inline" : "block"} formula previews`, async () => {
      const dom = createDomTestHarness();
      document.documentElement.lang = "en";
      const { tablesExtension } = await import("./tables");
      const doc = "Intro\n\n\n| Name | Result |\n| --- | --- |\n| Ada \\| Grace | =LEN(Name) |";
      const view = new EditorView({
        parent: dom.root,
        state: EditorState.create({
          doc,
          selection: { anchor: sourceVisible ? doc.indexOf("=LEN") + 4 : 0 },
          extensions: [markdownExtension(), tablesExtension("ABC123")],
        }),
      });
      try {
        if (sourceVisible) {
          expect(dom.root.querySelector(".cm-formula-preview")?.textContent).toContain("11");
          expect(dom.root.querySelector(".cm-formula-preview-error")).toBeNull();
        } else {
          expect(dom.root.querySelector("tbody")?.textContent).toBe("Ada | Grace11");
          expect(dom.root.querySelectorAll("tbody td").length).toBe(2);
        }
        expect(view.state.doc.toString()).toBe(doc);
      } finally {
        view.destroy();
        dom.cleanup();
      }
    });
  }
});
