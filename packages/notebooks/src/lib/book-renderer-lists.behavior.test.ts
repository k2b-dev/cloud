import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createDomTestHarness } from "../../../ui/test/dom";
import { basicExtensions } from "../frontend/lib/editor/basic";
import { markdownExtension } from "../frontend/lib/editor/markdown";

const loading = createDomTestHarness();
const { listCommandsExtension } = await import("../frontend/lib/editor/list-commands");
const { renderNotebookBook } = await import("./book-renderer");
loading.cleanup();

test("Enter twice ends a tight list before the next Book paragraph", () => {
  const dom = createDomTestHarness();
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc: "- a",
      selection: { anchor: 3 },
      extensions: [basicExtensions(), markdownExtension(), listCommandsExtension()],
    }),
  });
  try {
    for (let n = 0; n < 2; n++)
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    view.dispatch(view.state.replaceSelection("Hello"));
    expect(view.state.doc.toString()).toBe("- a\n\nHello");
    const { html } = renderNotebookBook({ markdown: view.state.doc.toString(), notebookId: "ABC123", locale: "en" });
    expect(html).toMatch(/<li>a<\/li>/);
    expect(html).not.toMatch(/<li>\s*<p>/);
    expect(html).toMatch(/<\/ul>\s*<p>Hello<\/p>/);
  } finally {
    view.destroy();
    dom.cleanup();
  }
});
