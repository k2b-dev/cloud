import { describe, expect, test } from "bun:test";
import { undoDepth } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const doc = "Intro\n\n| Item | Cost |\n| --- | ---: |\n| Paper | 4 |\n\nAfter";
const baseHost = {
  cellLabel: (row: number, column: number) => `${row}, ${column}`,
  maxLength: 10_000,
  maxPasteCells: 2_000,
  onError() {},
  onRecovery() {},
  boundary() {},
};

if (isServer) {
  test.skip("the editor engine needs browser export conditions", () => {});
} else {
  describe("text editor host contract", () => {
    test("reactive history availability cannot reconfigure the editor from inside a binding update", async () => {
      const dom = createDomTestHarness();
      const { TextEditor } = await import("../src/text-editor/TextEditor");
      const [revision, setRevision] = createSignal(0);
      const writes: string[] = [];
      const errors: unknown[] = [];
      let editor!: import("../src/text-editor/engine").TextEditorController;
      const binding = ViewPlugin.define(() => ({
        update(update) {
          if (!update.docChanged) return;
          setRevision((value) => value + 1);
          writes.push(update.state.doc.toString());
        },
      }));
      const dispose = render(
        () => (
          <TextEditor
            label="Note"
            initialValue={doc}
            maxLength={10_000}
            extensions={[binding, EditorView.exceptionSink.of((error) => errors.push(error))]}
            host={{
              structure: {
                available: () => {
                  revision();
                  return true;
                },
                perform: async () => {},
              },
            }}
            onReady={(value) => {
              editor = value;
            }}
          />
        ),
        dom.root,
      );
      try {
        editor.view.dispatch({ changes: { from: doc.length, insert: " first" } });
        editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: " second" } });
        expect(errors).toEqual([]);
        expect(writes).toEqual([`${doc} first`, `${doc} first second`]);
        expect(editor.view.state.doc.toString()).toBe(writes.at(-1)!);
      } finally {
        dispose();
        dom.cleanup();
      }
    });

    test("application presentation without a status slot keeps the note at its existing top edge", async () => {
      const dom = createDomTestHarness();
      const { TextEditor } = await import("../src/text-editor/TextEditor");
      let editor!: import("../src/text-editor/engine").TextEditorController;
      const dispose = render(
        () => (
          <TextEditor
            label="Note"
            initialValue="Intro"
            maxLength={2_097_152}
            presentation={() => []}
            toolbar={false}
            onReady={(value) => {
              editor = value;
            }}
          />
        ),
        dom.root,
      );
      try {
        expect(dom.root.querySelector(".k2b-ste-status")).toBeNull();
        editor.view.dispatch({ changes: { from: 0, to: 5, insert: "| A |\n| --- |\n| x | y |" } });
        await Promise.resolve();
        expect(dom.root.querySelector(".k2b-ste-status")?.textContent).toContain("Check table");
        editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "Intro" } });
        await Promise.resolve();
        expect(dom.root.querySelector(".k2b-ste-status")).toBeNull();
      } finally {
        dispose();
        dom.cleanup();
      }
    });

    test("a host presentation replaces the built-in Markdown view but keeps the shared table grid", async () => {
      const dom = createDomTestHarness();
      const { createTextEditor } = await import("../src/text-editor/engine");
      const built = createTextEditor({ parent: dom.root, doc, label: "Text", host: { ...baseHost, undo() {}, redo() {} } });
      const hosted = createTextEditor({
        parent: dom.root,
        doc,
        label: "Text",
        presentation: () => [],
        host: { ...baseHost, undo() {}, redo() {} },
      });
      try {
        expect(built.view.state.facet(language)).not.toBeNull();
        expect(hosted.view.state.facet(language)).toBeNull();
        expect(hosted.view.dom.querySelectorAll(".k2b-ste-table")).toHaveLength(1);
        hosted.setMode("source");
        expect(hosted.view.dom.querySelectorAll(".k2b-ste-table")).toHaveLength(0);
      } finally {
        built.destroy();
        hosted.destroy();
        dom.cleanup();
      }
    });

    test("the engine routes history to its host and installs no history of its own", async () => {
      const dom = createDomTestHarness();
      const { createTextEditor } = await import("../src/text-editor/engine");
      const calls: string[] = [];
      const editor = createTextEditor({
        parent: dom.root,
        doc: "Text",
        label: "Text",
        host: { ...baseHost, undo: () => calls.push("undo"), redo: () => calls.push("redo") },
      });
      try {
        editor.view.dispatch({ changes: { from: 4, insert: "!" }, userEvent: "input.type" });
        expect(undoDepth(editor.view.state)).toBe(0);
        const key = (init: KeyboardEventInit) =>
          editor.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
        key({ key: "z", ctrlKey: true });
        key({ key: "Z", code: "KeyZ", keyCode: 90, ctrlKey: true, shiftKey: true });
        expect(calls).toEqual(["undo", "redo"]);
        editor.setReadOnly(true);
        key({ key: "z", ctrlKey: true });
        expect(calls).toEqual(["undo", "redo"]);
      } finally {
        editor.destroy();
        dom.cleanup();
      }
    });

    test("the length limit refuses growth but lets an over-limit text shrink", async () => {
      const dom = createDomTestHarness();
      const { createTextEditor } = await import("../src/text-editor/engine");
      const errors: string[] = [];
      const editor = createTextEditor({
        parent: dom.root,
        doc: "0123456789",
        label: "Text",
        host: { ...baseHost, maxLength: 8, onError: (code) => errors.push(code), undo() {}, redo() {} },
      });
      try {
        editor.view.dispatch({ changes: { from: 10, insert: "a" }, userEvent: "input.type" });
        expect(editor.view.state.doc.toString()).toBe("0123456789");
        editor.view.dispatch({ changes: { from: 9, to: 10 }, userEvent: "delete.backward" });
        editor.view.dispatch({ changes: { from: 0, to: 2, insert: "x" }, userEvent: "input.type" });
        expect(editor.view.state.doc.toString()).toBe("x2345678");
        await Promise.resolve();
        expect(errors).toEqual(["textTooLarge"]);
      } finally {
        editor.destroy();
        dom.cleanup();
      }
    });

    test("the editable surface follows a changed access label and plain mode does not report Markdown damage", async () => {
      const dom = createDomTestHarness();
      const { TextEditor } = await import("../src/text-editor/TextEditor");
      const [label, setLabel] = createSignal("Editable note");
      const [mode, setMode] = createSignal<"formatted" | "plain">("formatted");
      const checks: boolean[] = [];
      const dispose = render(
        () => (
          <TextEditor
            label={label()}
            mode={mode()}
            initialValue={"| A | B |\n| text | 2 |"}
            maxLength={1000}
            onTableCheck={(value) => checks.push(value)}
          />
        ),
        dom.root,
      );
      try {
        expect(dom.root.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Editable note");
        expect(checks.at(-1)).toBe(true);
        setLabel("Read-only note");
        setMode("plain");
        expect(dom.root.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Read-only note");
        expect(checks.at(-1)).toBe(false);
      } finally {
        dispose();
        dom.cleanup();
      }
    });

    test("omitted clipboard images offer the host attachment picker without changing text", async () => {
      const dom = createDomTestHarness();
      const { TextEditor } = await import("../src/text-editor/TextEditor");
      let opened = 0;
      let editor: import("../src/text-editor/engine").TextEditorController | undefined;
      const dispose = render(
        () => (
          <TextEditor
            label="Note"
            initialValue="Keep this text"
            maxLength={1000}
            onAttachImages={() => opened++}
            onReady={(controller) => {
              editor = controller;
            }}
          />
        ),
        dom.root,
      );
      try {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: { getData: () => "", files: [new File([], "image.png", { type: "image/png" })] },
        });
        editor!.view.contentDOM.dispatchEvent(event);
        const attach = [...dom.root.querySelectorAll("button")].find((button) => button.textContent === "Add images as attachments");
        expect(attach).toBeDefined();
        attach!.click();
        expect(opened).toBe(1);
        expect(editor!.view.state.doc.toString()).toBe("Keep this text");
      } finally {
        dispose();
        dom.cleanup();
      }
    });

    test("host inline marks preserve table boundaries and reject structural delimiters", async () => {
      const { EditorState } = await import("@codemirror/state");
      const { inlineFormat } = await import("../src/text-editor/format");
      const start = doc.indexOf("Paper");
      const state = EditorState.create({ doc, selection: { anchor: start, head: start + 5 } });
      const marked = state.update(inlineFormat(state, { marker: "==" })).state;
      expect(marked.doc.toString()).toBe(doc.replace("Paper", "==Paper=="));
      expect(marked.update(inlineFormat(marked, { marker: "==" })).state.doc.toString()).toBe(doc);
      for (const marker of ["", "|", "\n", "\r"]) {
        expect(state.update(inlineFormat(state, { marker })).state.doc.toString()).toBe(doc);
      }
    });

    test("damaged separators show review in both modes and the host receives the recovery view change", async () => {
      const dom = createDomTestHarness();
      const { TextEditor } = await import("../src/text-editor/TextEditor");
      const values: boolean[] = [];
      const modes: string[] = [];
      let editor: import("../src/text-editor/engine").TextEditorController | undefined;
      const damaged = "| A | B |\n| KEEP ME | 2 |";
      const dispose = render(
        () => (
          <TextEditor
            label="Note"
            initialValue={damaged}
            maxLength={1000}
            status="Offline"
            onTableCheck={(check) => values.push(check)}
            onModeChange={(mode) => modes.push(mode)}
            onReady={(controller) => {
              editor = controller;
            }}
          />
        ),
        dom.root,
      );
      try {
        expect(values.at(-1)).toBe(true);
        expect(dom.root.textContent).toContain("Offline");
        expect(dom.root.querySelector(".k2b-ste-check")?.textContent).toContain("Check table");
        const review = [...dom.root.querySelectorAll("button")].find((button) => button.textContent === "Check Markdown");
        expect(review).toBeDefined();
        review!.click();
        await Promise.resolve();
        expect(modes).toEqual(["source"]);
        expect(dom.root.querySelector(".k2b-text-editor")?.getAttribute("data-mode")).toBe("source");
        expect(editor!.view.state.doc.toString()).toBe(damaged);
        expect(dom.root.querySelector(".k2b-ste-check")).not.toBeNull();
        editor!.view.dispatch({ changes: { from: damaged.indexOf("\n") + 1, insert: "| --- | --- |\n" } });
        await Promise.resolve();
        expect(values.at(-1)).toBe(false);
        expect(dom.root.querySelector(".k2b-ste-check")).toBeNull();
        expect(dom.root.textContent).toContain("Offline");
      } finally {
        dispose();
        dom.cleanup();
      }
    });

    test("the standalone component keeps native history; a host toolbar gets the shared table controls", async () => {
      const dom = createDomTestHarness();
      const { TextEditor } = await import("../src/text-editor/TextEditor");
      type Ready = Parameters<NonNullable<Parameters<typeof TextEditor>[0]["onReady"]>>;
      let ready: Ready | undefined;
      let hostedReady: Ready | undefined;
      const dispose = render(
        () => (
          <>
            <TextEditor label="Standalone" initialValue="Text" maxLength={1000} onReady={(...args) => (ready = args)} />
            <TextEditor
              label="Hosted"
              initialValue={doc}
              maxLength={1000}
              toolbar={false}
              presentation={() => []}
              host={{ undo() {}, redo() {}, boundary() {} }}
              onReady={(...args) => (hostedReady = args)}
            />
          </>
        ),
        dom.root,
      );
      try {
        const [editor] = ready!;
        editor.view.dispatch({ changes: { from: 4, insert: "!" }, userEvent: "input.type" });
        expect(undoDepth(editor.view.state)).toBe(1);
        editor.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
        expect(editor.view.state.doc.toString()).toBe("Text");

        const [hosted, controls] = hostedReady!;
        const roots = dom.root.querySelectorAll(".k2b-text-editor");
        expect(roots[0]!.querySelector(".k2b-ste-toolbar")).not.toBeNull();
        expect(roots[0]!.querySelector(".k2b-ste-host")).not.toBeNull();
        expect(roots[1]!.querySelector(".k2b-ste-toolbar")).toBeNull();
        expect(roots[1]!.querySelector(".k2b-ste-host")).toBeNull();
        expect(roots[1]!.querySelector(".k2b-ste-app-host .k2b-ste-table")).not.toBeNull();
        expect(undoDepth(hosted.view.state)).toBe(0);
        expect(controls.tableActive()).toBe(false);
        expect(controls.formatCell("bold")).toBe(false);
        controls.notify("Server says no");
        await Promise.resolve();
        expect(roots[1]!.querySelector(".k2b-ste-notice")?.textContent).toContain("Server says no");
      } finally {
        dispose();
        dom.cleanup();
      }
    });
  });
}
