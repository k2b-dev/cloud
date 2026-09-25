import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("editor toolbar keyboard focus", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("keeps every focused toolbar button's focus signal inside the button", async () => {
    const dom = createDomTestHarness();
    const style = dom.document.createElement("style");
    style.textContent = `${await read("../../../../../../ui/src/styles/index.css")}\n${await read("../../../../styles/app.css")}`;
    dom.document.head.append(style);
    dom.document.body.classList.add("k2b-ui");
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: EditorToolbar } = await import("./EditorToolbar");
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <EditorToolbar connected editorView={undefined} notebookId="notebook-1" noteId="note-1" initialPanelOpen={false} />
        </LocaleProvider>
      ),
      dom.root,
    );

    try {
      const toolbar = dom.document.querySelector(".notebooks-editor-toolbar");
      const buttons = Array.from(toolbar?.querySelectorAll<HTMLElement>(".k2b-icon-button") ?? []);
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toContain("Fett");
      expect(buttons.length).toBeGreaterThanOrEqual(9);
      for (const button of buttons) {
        button.focus();
        expect(dom.document.activeElement).toBe(button);
        const focused = getComputedStyle(button);
        const label = button.getAttribute("aria-label");
        expect({ label, outline: focused.outlineStyle, shadow: focused.boxShadow }).toEqual({ label, outline: "none", shadow: "none" });
      }
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
