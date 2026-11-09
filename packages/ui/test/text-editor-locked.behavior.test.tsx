import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { TextEditorController } from "../src/text-editor/engine";
import { createDomTestHarness } from "./dom";

test.skipIf(isServer)("a locked editor keeps its toolbar, caret and focus and takes no input until it unlocks", async () => {
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
        maxLength={10_000}
        onReady={(value) => {
          editor = value;
        }}
      />
    ),
    dom.root,
  );
  try {
    for (let attempt = 0; attempt < 100 && !editor; attempt++) await Bun.sleep(10);
    const toolbar = dom.root.querySelector(".k2b-ste-toolbar");
    const tools = () => [...dom.root.querySelectorAll<HTMLButtonElement>(".k2b-ste-toolbar button.k2b-ste-tool")];
    expect(toolbar).not.toBeNull();
    expect(tools().every((tool) => !tool.disabled)).toBe(true);
    editor.view.focus();
    editor.view.dispatch({ selection: { anchor: 3 } });

    setLocked(true);
    expect(dom.root.querySelector(".k2b-ste-toolbar")).toBe(toolbar);
    expect(tools().length).toBeGreaterThan(0);
    expect(tools().every((tool) => tool.disabled)).toBe(true);
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
});
