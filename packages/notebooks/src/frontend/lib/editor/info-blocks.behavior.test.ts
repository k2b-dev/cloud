import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const doc = "Intro\n\n:::warning\nBack up **first**.\n:::\n\nOutro";

const mount = async (anchor: number) => {
  const dom = createDomTestHarness();
  // @k2b/ui's browser build needs the DOM globals before it loads.
  const { infoBlocksExtension } = await import("./info-blocks");
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({ doc, selection: { anchor }, extensions: [infoBlocksExtension("de")] }),
  });
  return {
    view,
    root: dom.root,
    [Symbol.dispose]: () => {
      view.destroy();
      dom.cleanup();
    },
  };
};

describe("editor notice blocks", () => {
  if (isServer) {
    test.skip("editor notice blocks run with browser export conditions", () => {});
    return;
  }

  test("a notice outside the cursor shows its tone colour without label or icon", async () => {
    using editor = await mount(0);
    const card = editor.root.querySelector(".k2b-notice-card");
    expect(card?.getAttribute("data-tone")).toBe("warning");
    expect(card?.getAttribute("role")).toBe("note");
    expect(card?.querySelector(".sr-only")?.textContent).toBe("Warnung: ");
    expect(card?.querySelector(".k2b-notice-card__body")?.innerHTML).toBe("Back up <strong>first</strong>.");
    expect(card?.querySelector(".k2b-notice-card__icon, .k2b-notice-card__title, i")).toBeNull();
  });

  test("the cursor inside a notice shows its source for editing", async () => {
    using editor = await mount(doc.indexOf("Back up"));
    expect(editor.root.querySelector(".k2b-notice-card")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain(":::warning");
  });
});
