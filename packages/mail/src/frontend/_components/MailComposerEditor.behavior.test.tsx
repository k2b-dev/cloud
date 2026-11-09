import { expect, test } from "bun:test";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { PanesLayout } from "@k2b/ui";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 150 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition()).toBe(true);
};

test.skipIf(isServer)("switching between Markdown and plain text keeps the editor, its caret, focus and undo", async () => {
  const dom = createDomTestHarness();
  const [{ default: MailComposerEditor }, { LocaleProvider }] = await Promise.all([import("./MailComposerEditor"), import("@k2b/ui")]);
  const { reconcileMailComposerPanes } = await import("./mail-composer-panes");
  const layout: PanesLayout = { version: 2, root: { type: "group", items: ["editor", "preview"], active: "editor" } };
  const [format, setFormat] = createSignal<"plain" | "markdown">("markdown");
  const [body, setBody] = createSignal("Hello");
  const dispose = render(
    () => (
      <LocaleProvider locale="en">
        <MailComposerEditor
          format={format}
          body={body}
          onBodyInput={setBody}
          editable={() => true}
          completions={() => []}
          panes={() => reconcileMailComposerPanes(layout, format(), false)}
          onPanesChange={() => undefined}
          preview={() => null}
          previewError={() => undefined}
          previewPending={() => false}
          onRetryPreview={() => undefined}
          onEditorReady={() => undefined}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  try {
    await waitFor(() => Boolean(dom.root.querySelector(".cm-content")));
    const view = EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!)!;
    view.focus();
    view.dispatch({ changes: { from: 5, insert: " world" }, selection: { anchor: 8 }, userEvent: "input.type" });
    setFormat("plain");
    await Bun.sleep(30);
    const after = EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!);
    expect(after).toBe(view);
    expect(view.dom.isConnected).toBe(true);
    expect(view.state.selection.main.head).toBe(8);
    expect(dom.document.activeElement).toBe(view.contentDOM);
    undo(view);
    expect(view.state.doc.toString()).toBe("Hello");
    setFormat("markdown");
    await Bun.sleep(30);
    expect(EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
  } finally {
    dispose();
    dom.cleanup();
  }
});
