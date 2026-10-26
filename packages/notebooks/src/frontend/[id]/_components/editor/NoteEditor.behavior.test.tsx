import { describe, expect, spyOn, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { delegateEvents, isServer, render } from "solid-js/web";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { EDITOR_INSERT_ATTACHMENT_EVENT } from "../detail/events";
import { NOTE_EDITOR_MAX_LENGTH } from "./table-structure";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { default: NoteEditor } = await import("./NoteEditor.client");
    const { LocaleProvider } = await import("@k2b/ui");
    const { yjs } = await import("../../../lib/yjs");
    return { NoteEditor, LocaleProvider, yjs };
  } finally {
    dom.cleanup();
  }
};
const loaded = isServer ? undefined : await load();

const mount = (markdown: string) => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "mousedown"], dom.document);
  const previousBindings = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["sessionStorage", "HTMLAnchorElement", "PopStateEvent", "Window"] as const) {
    previousBindings.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  const href = "/app/notebooks/Book01/notes/Note01?mode=write";
  window.history.replaceState({}, "", href);
  const { NoteEditor, LocaleProvider, yjs } = loaded!;
  // Keep the real editor, collaboration binding, attachment event and ScrollArea handlers;
  // only the network provider is inert. No service is contacted by this fixture.
  const provider = spyOn(yjs, "createYjsProvider").mockImplementation((opts) => ({
    connect() {},
    reconnectNow() {},
    resume() {},
    dispose() {},
    hasUnsentChanges: () => false,
    restoreRevision: () => opts.initialRestoreRevision ?? null,
    canStructure: () => false,
    canUndo: () => !!opts.undoManager?.undoStack.length,
    canRedo: () => !!opts.undoManager?.redoStack.length,
    undo: async () => {
      opts.undoManager?.undo();
      return null;
    },
    redo: async () => {
      opts.undoManager?.redo();
      return null;
    },
    setInverseHandler: () => {},
    recoveryInput: () => ({
      state: Y.encodeStateAsUpdate(opts.doc),
      text: opts.doc.getText("codemirror").toString(),
      pending: [],
      baseCursor: null,
    }),
    beginAction: () => {
      throw new Error("Structure is unavailable in this fixture");
    },
  }));
  const dispose = render(
    () => (
      <LocaleProvider locale="en">
        <NoteEditor
          noteId="Note01"
          noteTitle="Note"
          notebookId="Book01"
          noteLockedAt={null}
          historyIncomplete={false}
          notebookName="Book"
          appUrl="http://localhost"
          userId="User01"
          displayName="Reader"
          initialContent={markdown}
          initialPanelOpen={false}
          initialRichMode="rich"
          initialHref={href}
          initialDetail={{
            noteAuthors: { createdBy: null, lastEditedBy: null },
            noteId: "Note01",
            noteTitle: "Note",
            contentMd: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            lockedAt: null,
            historyIncomplete: false,
            isLocked: false,
            tocItems: [],
            taskProgress: { total: 0, done: 0 },
            attachments: [],
            backlinks: [],
            namedBlocks: [],
          }}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  const view = EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!)!;
  const surface = view.dom.closest<HTMLElement>(".k2b-scroll-area")!;
  return {
    dom,
    view,
    surface,
    async [Symbol.asyncDispose]() {
      dispose();
      // Focus-out cleanup queues a measurement in the shared editor. Let it run
      // before removing this document, just as when the real page stays mounted.
      await Promise.resolve();
      provider.mockRestore();
      for (const [name, previous] of previousBindings) {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.cleanup();
    },
  };
};

describe("Notebook attachment and recovery surface integration", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test.each(["| Item | Cost |\n| --- | ---: |\n| Paper | 4 |", "Item | Cost\n--- | ---:\nPaper | 4"])(
    "the actual attachment event inserts after the table without changing its source (%s)",
    async (table) => {
      await using app = mount(`Intro\n\n${table}\n\nFollowing prose.`);
      app.view.dispatch({ selection: { anchor: app.view.state.doc.toString().indexOf("Paper") } });
      window.dispatchEvent(
        new CustomEvent(EDITOR_INSERT_ATTACHMENT_EVENT, { detail: { id: "File01", kind: "file", filename: "invoice.pdf" } }),
      );
      expect(app.view.state.doc.toString()).toBe(`Intro\n\n${table}\n\n[invoice.pdf](attach://File01)\n\nFollowing prose.`);
    },
  );

  test("the attachment picker remains available while a table cell has focus", async () => {
    await using app = mount("| Item | Cost |\n| --- | ---: |\n| Paper | 4 |");
    const cell = app.view.contentDOM.querySelector<HTMLElement>(".k2b-ste-cell");
    if (!cell) throw new Error("Missing editable cell");
    cell.focus();
    await Promise.resolve();
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Attach file or image"]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-disabled")).not.toBe("true");
  });

  test("the actual blank surface handler leaves preserved input selectable and recovery controls operable", async () => {
    await using app = mount("Beginning\n\nEnd of note");
    app.view.dispatch({ selection: { anchor: 2 } });
    app.view.focus();
    const interrupted = `Interrupted input ${"x".repeat(NOTE_EDITOR_MAX_LENGTH)}`;
    app.view.dispatch({ changes: { from: 2, insert: interrupted }, userEvent: "input.type" });
    await Promise.resolve();
    const recovery = app.surface.querySelector<HTMLTextAreaElement>(".k2b-ste-recovery");
    if (!recovery) throw new Error("Missing preserved input");
    expect(recovery.value).toBe(interrupted);
    expect(app.view.state.doc.toString()).toBe("Beginning\n\nEnd of note");
    expect(recovery.closest(".cm-editor")).toBeNull();
    recovery.focus();
    recovery.setSelectionRange(0, 17);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    recovery.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(recovery);
    expect(recovery.value.slice(recovery.selectionStart, recovery.selectionEnd)).toBe("Interrupted input");
    expect(app.view.state.selection.main.head).toBe(2);

    const discard = Array.from(app.surface.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Discard"),
    );
    if (!discard) throw new Error("Missing discard control");
    const controlPress = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    discard.dispatchEvent(controlPress);
    expect(controlPress.defaultPrevented).toBe(false);
    expect(app.view.state.selection.main.head).toBe(2);
    discard.click();
    expect(app.surface.querySelector(".k2b-ste-recovery")).toBeNull();

    const blankPress = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    app.surface.dispatchEvent(blankPress);
    expect(blankPress.defaultPrevented).toBe(true);
    expect(app.view.hasFocus).toBe(true);
    expect(app.view.state.selection.main.head).toBe(app.view.state.doc.length);
  });
});
