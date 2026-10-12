import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LocaleProvider, ScrollArea } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { basicExtensions } from "../../../lib/editor/basic";
import { listCommandsExtension, listIndentAvailability } from "../../../lib/editor/list-commands";
import { listsExtension } from "../../../lib/editor/lists";
import { markdownExtension } from "../../../lib/editor/markdown";
import { noteScrollerTheme } from "../../../lib/editor/theme";
import EditorToolbar from "./EditorToolbar";

function Harness() {
  let host!: HTMLDivElement;
  const [view, setView] = createSignal<EditorView>();
  // Match NoteEditor: availability follows document and selection transactions, with equal values suppressed.
  const [listIndent, setListIndent] = createSignal(
    { indent: false, outdent: false },
    { equals: (a, b) => a.indent === b.indent && a.outdent === b.outdent },
  );

  onMount(() => {
    const editor = new EditorView({
      parent: host,
      state: EditorState.create({
        extensions: [
          basicExtensions(),
          markdownExtension(),
          listCommandsExtension(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) setListIndent(listIndentAvailability(update.state));
          }),
          listsExtension(),
          noteScrollerTheme,
        ],
      }),
    });
    setView(editor);
    onCleanup(() => editor.destroy());

    const harness = {
      loadDocument(markdown: string) {
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: markdown }, selection: { anchor: 0 } });
        forceParsing(editor, markdown.length, 5000);
      },
      placeCaret(text: string, offset: number) {
        const from = editor.state.doc.toString().indexOf(text);
        if (from < 0 || offset < 0 || offset > text.length) throw new Error(`Invalid caret target: ${text}, offset ${offset}`);
        editor.dispatch({ selection: { anchor: from + offset }, scrollIntoView: true });
        editor.focus();
      },
      read() {
        return { doc: editor.state.doc.toString(), head: editor.state.selection.main.head, hasFocus: editor.hasFocus };
      },
      async settle() {
        await document.fonts.ready;
        // Allow CodeMirror measurements and Solid's DOM updates to finish; never refocus after a toolbar press.
        for (let frame = 0; frame < 5; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      },
    };
    Object.assign(window, { harness });
  });

  return (
    <LocaleProvider locale="en">
      <div class="flex flex-1 min-h-0 min-w-0 flex-col">
        <ScrollArea class="flex-1 min-h-0">
          <div ref={host} />
        </ScrollArea>
        <EditorToolbar
          connected={true}
          editorView={view()}
          notebookId="Book01"
          noteId="Note01"
          initialPanelOpen={false}
          listIndent={listIndent()}
        />
      </div>
    </LocaleProvider>
  );
}

export type ToolbarHarness = {
  loadDocument: (markdown: string) => void;
  placeCaret: (text: string, offset: number) => void;
  read: () => { doc: string; head: number; hasFocus: boolean };
  settle: () => Promise<void>;
};

render(() => <Harness />, document.getElementById("root")!);
