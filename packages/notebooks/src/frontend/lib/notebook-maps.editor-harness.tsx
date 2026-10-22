import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { parseNotebookMapBlocks, renderNotebookMapFigure } from "../../lib/map-blocks";
import { createQueryBlockPreviews } from "./editor/query-blocks";
import { isolateYjsHistory } from "./yjs/history";

/** Real editor and Yjs path; all documents and capability replies are fictional. */
export function mountMapEditorFixture(root: HTMLElement) {
  const markdown = JSON.parse(document.getElementById("fixture-markdown")!.textContent!) as string;
  const readonly = new URL(location.href).searchParams.has("readonly");
  const documentModel = new Y.Doc();
  const text = documentModel.getText("note");
  text.insert(0, markdown);
  const undo = new Y.UndoManager(text, { captureTimeout: 10_000 });
  let editor: EditorView | undefined;
  root.replaceChildren();
  const dispose = render(() => {
    const host = document.createElement("div");
    const [view, setView] = createSignal<EditorView>();
    const previews = createQueryBlockPreviews({
      notebookId: "Book01",
      noteId: "Note01",
      readOnly: readonly,
      initialMarkdown: markdown,
      view,
      enabled: () => true,
      locale: () => "de",
      load: async (draft) => {
        const source = draft ?? text.toString();
        return {
          markdown: source,
          headings: [],
          diagnostics: [],
          blocks: parseNotebookMapBlocks(source).blocks.map((block) => ({
            line: block.line,
            html: renderNotebookMapFigure(block.document, {
              locale: "de",
              notebookId: "Book01",
              state: {
                availability: {
                  configured: true,
                  cloud: { exhausted: false, resetsAt: "2026-11-01T00:00:00Z" },
                  person: { exhausted: false, resetsAt: "2026-10-23T00:00:00Z" },
                },
              },
            }),
          })),
        };
      },
    });
    onMount(() => {
      editor = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: markdown,
          extensions: [
            EditorState.readOnly.of(readonly),
            yCollab(text, null, { undoManager: undo }),
            isolateYjsHistory(undo),
            previews.extension,
            previews.listener,
          ],
        }),
      });
      setView(editor);
    });
    onCleanup(() => editor?.destroy());
    return host;
  }, root);
  Object.assign(window, {
    notebookEditorFixture: {
      markdown: () => text.toString(),
      typePrefix: () => editor?.dispatch({ changes: { from: 0, insert: "Draft " }, userEvent: "input.type" }),
      undo: () => undo.undo(),
      redo: () => undo.redo(),
      remoteChange: () => documentModel.transact(() => text.insert(0, "Remote paragraph\n\n"), "remote"),
      dispose: () => {
        dispose();
        undo.destroy();
        documentModel.destroy();
      },
    },
  });
}
