import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const doc = "Intro\n\n:::warning\nBack up **first**.\n:::\n\nOutro";

const mount = async (anchor: number, source = doc) => {
  const dom = createDomTestHarness();
  // @k2b/ui's browser build needs the DOM globals before it loads.
  const { infoBlocksExtension } = await import("./info-blocks");
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({ doc: source, selection: { anchor }, extensions: [infoBlocksExtension("de")] }),
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
    expect(card?.querySelector(".k2b-sr-only")?.textContent).toBe("Warnung: ");
    expect(card?.querySelector(".k2b-notice-card__body")?.innerHTML).toBe("Back up <strong>first</strong>.");
    expect(card?.querySelector(".k2b-notice-card__icon, .k2b-notice-card__title, i")).toBeNull();
  });

  test("a titled notice shows its title like in the book view", async () => {
    using editor = await mount(0, "Intro\n\n:::warning Before deleting\nBack up **first**.\n:::\n\nOutro");
    const card = editor.root.querySelector(".k2b-notice-card");
    expect(card?.querySelector(".k2b-notice-card__title")?.textContent).toBe("Before deleting");
    expect(card?.querySelector(".k2b-sr-only")).toBeNull();
    expect(editor.view.contentDOM.textContent).not.toContain(":::warning");
  });

  // An earlier block, empty or not, must end at its own `:::` instead of the notice's.
  for (const [kind, before] of [
    ["table of contents", ":::toc\n:::"],
    ["query", ":::query\nsource: notes\n:::"],
    ["data block", ":::data\nkey: value\n:::"],
    ["notice", ":::note\nFirst.\n:::"],
    ["empty notice", ":::note\n:::"],
  ] as const) {
    test(`a notice after a ${kind} renders like in the book view`, async () => {
      const source = `${before}\n\n:::info\nRead **this**.\n:::\n\nOutro`;
      using editor = await mount(source.length, source);
      const card = Array.from(editor.root.querySelectorAll(".k2b-notice-card")).at(-1);
      expect(card?.getAttribute("data-tone")).toBe("info");
      expect(card?.querySelector(".k2b-notice-card__body")?.innerHTML).toBe("Read <strong>this</strong>.");
      expect(editor.view.contentDOM.textContent).not.toContain(":::info");
    });
  }

  test("a notice inside a code fence stays source like in the book view", async () => {
    const source = "```md\n:::info\nExample\n:::\n```\n\nOutro";
    using editor = await mount(source.length, source);
    expect(editor.root.querySelector(".k2b-notice-card")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain(":::info");
  });

  test("the cursor inside a notice shows its source for editing", async () => {
    using editor = await mount(doc.indexOf("Back up"));
    expect(editor.root.querySelector(".k2b-notice-card")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain(":::warning");
  });
});
