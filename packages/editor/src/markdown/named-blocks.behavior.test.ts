import { describe, expect, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

describe("named block anchors", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mount = async (doc: string, withDataBlocks: boolean) => {
    const dom = createDomTestHarness();
    const { markdownExtension } = await import("./markdown");
    const { namedBlocksExtension } = await import("./named-blocks");
    const { dataBlocksExtension } = await import("./data-blocks");
    const extensions: Extension[] = [markdownExtension(), namedBlocksExtension(), withDataBlocks ? dataBlocksExtension() : []];
    const view = new EditorView({ parent: dom.root, state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions }) });
    forceParsing(view, doc.length, 5000);
    return {
      view,
      labels: () => [...dom.root.querySelectorAll(".md-block-handle")].map((label) => label.textContent),
      [Symbol.dispose]() {
        view.destroy();
        dom.cleanup();
      },
    };
  };

  const doc = "Intro\n\n@plan\n- Sunday 16 km\n- Tuesday intervals\n\n@numbers\n:::data\nweek: 3\n:::\n\nEnd";

  test("a list anchor reads as a label without @ until the caret enters its line", async () => {
    using page = await mount(doc, true);
    expect(page.labels()).toEqual(["plan", "numbers"]);
    page.view.dispatch({ selection: { anchor: doc.indexOf("@plan") + 2 } });
    expect(page.labels()).toEqual(["numbers"]);
    expect(page.view.contentDOM.textContent).toContain("@plan");
  });

  test("a data anchor is drawn once: by the data block when it is shown, otherwise as a label", async () => {
    using withData = await mount(doc, true);
    expect(withData.labels().filter((label) => label === "numbers")).toHaveLength(1);
    using withoutData = await mount(doc, false);
    expect(withoutData.labels()).toEqual(["plan", "numbers"]);
  });
});
