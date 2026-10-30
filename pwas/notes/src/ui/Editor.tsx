import type { EditorView } from "@codemirror/view";
import { BubbleMenu, createEditor, Editor, type EditorAction, markdownActions, type SlashAction, slashMenu } from "@k2b/editor";
import { files as browserFiles } from "@k2b/stdlib/browser";
import type { TextEditorController } from "@k2b/ui/text-editor";
import { onCleanup } from "solid-js";
import { yCollab } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { MAX_NOTE_LENGTH } from "../lib/model";
import { preferences } from "../prefs";
import { t } from "../state";

/** Puts a block on its own lines at the caret and leaves the caret at `caret` characters into it. */
const insertBlock = (view: EditorView, block: string, caret: number) => {
  const at = view.state.selection.main.head;
  const line = view.state.doc.lineAt(at);
  const lead = line.text.trim() ? "\n\n" : "";
  const from = line.text.trim() ? line.to : line.from;
  view.dispatch({ changes: { from, to: line.to, insert: `${lead}${block}` }, selection: { anchor: from + lead.length + caret } });
  view.focus();
};

const chartBlock = (type: "line" | "bar", title: string) =>
  `:::chart\ntype: ${type}\ntitle: ${title}\ncolumns: [A, B]\nrows:\n  - [1, 10]\n  - [2, 20]\nx: A\ny: B\n:::\n`;

/**
 * The note editor: @k2b/editor on the note's Y.Text, with the compact bubble menu and the `/` menu of mockup v4.
 * The Yjs binding, its history and the remote cursors come in as extensions; the transport stays in the app.
 */
export function NoteEditor(props: {
  text: Y.Text;
  awareness: Awareness;
  label: string;
  readOnly?: boolean;
  placeholder?: string;
  autofocus?: "end" | "start";
  onReady?: (editor: TextEditorController, undo: () => void) => void;
  onFiles?: (files: File[]) => void;
}) {
  const undoManager = new Y.UndoManager(props.text);
  onCleanup(() => undoManager.destroy());
  const editor = createEditor();
  const md = () => markdownActions(preferences.locale());

  const tag: EditorAction = {
    id: "tag",
    icon: "ti-hash",
    label: t().fmtTag,
    isEnabled: (state) => !state.readOnly,
    run: (view) => {
      const { from, to } = view.state.selection.main;
      const word = view.state.sliceDoc(from, to).trim().replace(/\s+/g, "-");
      view.dispatch({ changes: { from, to, insert: `#${word}` }, selection: { anchor: from + word.length + 1 } });
    },
  };
  const slash = (): SlashAction[] => [
    {
      id: "chart",
      name: "diagramm",
      aliases: ["chart"],
      icon: "ti-chart-area-line",
      label: t().slashChart,
      description: t().slashChartHint,
      run: (view) => insertBlock(view, chartBlock("line", t().slashChart), 0),
    },
    {
      id: "chart-bar",
      name: "balken",
      aliases: ["bar"],
      icon: "ti-chart-bar",
      label: t().slashBar,
      run: (view) => insertBlock(view, chartBlock("bar", t().slashChart), 0),
    },
    { ...md().table, name: "tabelle", aliases: ["table"], label: t().slashTable },
    {
      id: "checklist",
      name: "checkliste",
      aliases: ["todo", "task"],
      icon: "ti-list-check",
      label: t().fmtTask,
      run: (view) => insertBlock(view, "- [ ] ", 6),
    },
    {
      id: "note",
      name: "hinweis",
      aliases: ["note", "callout"],
      icon: "ti-info-circle",
      label: t().slashNote,
      description: t().slashNoteHint,
      run: (view) => insertBlock(view, ":::note\n\n:::\n", 8),
    },
    {
      id: "image",
      name: "bild",
      aliases: ["image", "img"],
      icon: "ti-photo",
      label: t().slashImage,
      description: t().slashImageHint,
      run: () =>
        void browserFiles
          .showFileDialog({ accept: "image/*,application/pdf", multiple: true })
          .then((list) => props.onFiles?.(list))
          .catch(() => {}),
    },
    { ...md().heading2, name: "ueberschrift", aliases: ["h2", "heading"], label: t().fmtHeading },
  ];
  editor.use(() => slashMenu({ actions: slash() }));

  return (
    <>
      <Editor
        editor={editor}
        class={`n-editor${props.readOnly ? " n-readonly" : ""}`}
        label={props.label}
        initialValue={props.text.toString()}
        readOnly={props.readOnly}
        placeholder={props.placeholder}
        toolbar={false}
        maxLength={MAX_NOTE_LENGTH}
        host={{
          undo: () => undoManager.undo() !== null,
          redo: () => undoManager.redo() !== null,
          boundary: () => undoManager.stopCapturing(),
        }}
        extensions={[yCollab(props.text, props.awareness, { undoManager })]}
        onReady={(controller) => {
          props.onReady?.(controller, () => void undoManager.undo());
          const view = controller.view;
          // Cursors of others disappear when this person leaves the editor.
          const blur = () =>
            queueMicrotask(() => {
              if (!view.dom.contains(document.activeElement)) props.awareness.setLocalStateField("cursor", null);
            });
          view.dom.addEventListener("focusout", blur);
          onCleanup(() => view.dom.removeEventListener("focusout", blur));
          if (props.autofocus && !props.readOnly) {
            const position = props.autofocus === "end" ? view.state.doc.length : 0;
            view.dispatch({ selection: { anchor: position } });
            view.focus();
          }
        }}
        onDroppedImages={(_count, files) => {
          if (!props.onFiles || files.length === 0) return false;
          props.onFiles(files);
          return true;
        }}
      />
      <BubbleMenu editor={editor} groups={[[md().bold, md().italic, md().strikethrough, md().code, md().link], [tag]]} />
    </>
  );
}
