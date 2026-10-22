import { history, redo, undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LocaleProvider, ScrollArea } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { notebooksYjs } from "../../../../lib/yjs";
import { basicExtensions } from "../../../lib/editor/basic";
import { fadeScrollMarginsExtension, fadeScrollPadding } from "../../../lib/editor/fade-scroll-margins";
import { listCommandsExtension } from "../../../lib/editor/list-commands";
import { listsExtension } from "../../../lib/editor/lists";
import { markdownExtension } from "../../../lib/editor/markdown";
import { noteScroller } from "../../../lib/editor/note-scroller";
import { notebookWorkspaceMessages } from "../../messages";
import EditorToolbar, { formattingKeymap } from "./EditorToolbar";
import { caretFormat, sameCaretFormat } from "./editor-actions";
import { createSyncEnded, SyncEndedBar } from "./sync-ended";

function Harness() {
  let host!: HTMLDivElement;
  let scrollPort: HTMLDivElement | undefined;
  const [view, setView] = createSignal<EditorView>();
  const [toolbarMounted, setToolbarMounted] = createSignal(true);
  const locale = new URLSearchParams(window.location.search).get("locale") ?? "en";
  let pending = false;
  const sync = createSyncEnded({
    messages: () => notebookWorkspaceMessages.resolve([locale]).t,
    hasUnsentChanges: () => pending,
    resume: () => {},
    focusEditor: () => view()?.focus(),
  });
  // Match NoteEditor: formats follow document and selection transactions, suppressing equal values.
  const [format, setFormat] = createSignal(caretFormat(EditorState.create()), { equals: sameCaretFormat });

  onMount(() => {
    const editor = new EditorView({
      parent: host,
      state: EditorState.create({
        extensions: [
          basicExtensions(),
          history(),
          formattingKeymap({ notebookId: "Book01" }),
          markdownExtension(),
          listCommandsExtension(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) setFormat(caretFormat(update.state));
          }),
          listsExtension(),
          noteScroller,
          fadeScrollMarginsExtension(() => scrollPort),
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
      select(text: string) {
        const from = editor.state.doc.toString().indexOf(text);
        if (from < 0) throw new Error(`Invalid selection target: ${text}`);
        editor.dispatch({ selection: { anchor: from, head: from + text.length }, scrollIntoView: true });
        editor.focus();
      },
      read() {
        return {
          doc: editor.state.doc.toString(),
          anchor: editor.state.selection.main.anchor,
          head: editor.state.selection.main.head,
          hasFocus: editor.hasFocus,
        };
      },
      caretRect(): { top: number; bottom: number } | null {
        const rect = editor.coordsAtPos(editor.state.selection.main.head);
        return rect ? { top: rect.top, bottom: rect.bottom } : null;
      },
      blur() {
        editor.contentDOM.blur();
      },
      endSync(code: string, unsent: boolean) {
        const known = Object.values(notebooksYjs.errorCode).find((value) => value === code);
        if (!known) throw new Error(`Unknown sync error: ${code}`);
        pending = unsent;
        sync.end({ code: known, message: code });
      },
      resumeSync() {
        sync.ready();
      },
      async remountToolbar() {
        setToolbarMounted(false);
        // Let the test open the keyboard while no toolbar is listening.
        await Promise.resolve();
        setToolbarMounted(true);
      },
      async settle() {
        await document.fonts.ready;
        // Allow CodeMirror measurements and Solid's DOM updates to finish; never refocus after a toolbar press.
        for (let frame = 0; frame < 5; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      },
    };
    window.toolbarHarness = harness;
  });

  return (
    <LocaleProvider locale={locale}>
      <div class="flex flex-1 min-h-0 min-w-0 flex-col">
        <ScrollArea ref={scrollPort} style={{ "scroll-padding-block": fadeScrollPadding }} class="flex-1 min-h-0" data-editor-scroller>
          <div ref={host} />
        </ScrollArea>
        <Show when={toolbarMounted()}>
          <Show
            when={sync.ended()}
            fallback={
              <EditorToolbar
                connected={true}
                editorView={view()}
                notebookId="Book01"
                noteId="Note01"
                initialPanelOpen={false}
                format={format()}
                onUndo={() => {
                  const editor = view();
                  if (editor) undo(editor);
                }}
                onRedo={() => {
                  const editor = view();
                  if (editor) redo(editor);
                }}
              />
            }
          >
            {(ended) => (
              <SyncEndedBar
                notebookId="Book01"
                ended={ended()}
                sync={sync}
                markdown={() => view()?.state.doc.toString() ?? ""}
                noteHref={() => "/app/notebooks/Book01/Note01"}
              />
            )}
          </Show>
        </Show>
      </div>
    </LocaleProvider>
  );
}

export type ToolbarHarness = {
  loadDocument: (markdown: string) => void;
  placeCaret: (text: string, offset: number) => void;
  select: (text: string) => void;
  read: () => { doc: string; anchor: number; head: number; hasFocus: boolean };
  caretRect: () => { top: number; bottom: number } | null;
  blur: () => void;
  endSync: (code: string, unsent: boolean) => void;
  resumeSync: () => void;
  remountToolbar: () => Promise<void>;
  settle: () => Promise<void>;
};

declare global {
  interface Window {
    toolbarHarness: ToolbarHarness;
    keyboard: {
      set: (values: { offsetTop?: number; height?: number; scale?: number }) => void;
      show: (top: number, height: number) => void;
      hide: () => void;
    };
  }
}

render(() => <Harness />, document.getElementById("root")!);
