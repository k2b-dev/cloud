import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { TextEditorController } from "../src/text-editor/engine";
import { createDomTestHarness } from "./dom";

test.skipIf(isServer).each(["formatted", "source"] as const)(
  "a locked %s editor keeps its toolbar, caret and focus and rejects input until it unlocks",
  async (mode) => {
    const dom = createDomTestHarness();
    const { TextEditor } = await import("../src/text-editor/TextEditor");
    const [locked, setLocked] = createSignal(false);
    let editor!: TextEditorController;
    const dispose = render(
      () => (
        <TextEditor
          label="Message"
          initialValue="Hello"
          locked={locked()}
          mode={mode}
          maxLength={10_000}
          onReady={(value) => {
            editor = value;
          }}
        />
      ),
      dom.root,
    );
    try {
      while (!editor) await Bun.sleep(10);
      const toolbar = dom.root.querySelector(".k2b-ste-toolbar");
      // The formatting tools and, in the source view, the switch back to the formatted view.
      const tools = () => [...dom.root.querySelectorAll<HTMLButtonElement>(".k2b-ste-toolbar button.k2b-ste-tool, .k2b-ste-views button")];
      expect(toolbar).not.toBeNull();
      expect(tools().every((tool) => !tool.disabled)).toBe(true);
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: 3 } });

      setLocked(true);
      expect(dom.root.querySelector(".k2b-ste-toolbar")).toBe(toolbar);
      expect(tools().length).toBeGreaterThan(0);
      expect(tools().every((tool) => tool.disabled)).toBe(true);
      if (mode === "source") expect(dom.root.querySelector(".k2b-ste-views button")).not.toBeNull();
      expect(editor.view.state.readOnly).toBe(true);
      expect(editor.view.contentDOM.getAttribute("contenteditable")).toBe("true");
      expect(dom.document.activeElement).toBe(editor.view.contentDOM);
      expect(editor.view.state.selection.main.head).toBe(3);

      setLocked(false);
      expect(dom.root.querySelector(".k2b-ste-toolbar")).toBe(toolbar);
      expect(tools().every((tool) => !tool.disabled)).toBe(true);
      expect(editor.view.state.readOnly).toBe(false);
      expect(dom.document.activeElement).toBe(editor.view.contentDOM);
    } finally {
      dispose();
      dom.cleanup();
    }
  },
);
