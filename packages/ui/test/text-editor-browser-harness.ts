import { ChangeSet } from "@codemirror/state";
import { createTextEditor } from "../src/text-editor/engine";
import { commands, type InlineFormat } from "../src/text-editor/format";
import { deleteColumn, findTables, insertColumn } from "../src/text-editor/markdown-table";
import { textEditorMessages } from "../src/text-editor/messages";
import { formatActiveCell, type MenuAction, runMenuAction } from "../src/text-editor/table";

let editor: ReturnType<typeof createTextEditor>;
const errors: string[] = [];
const calls: string[] = [];
let cellSelection: { anchor: number; head: number } | null = null;
const root = document.getElementById("root")!;
const labels = textEditorMessages.resolve(["en"]).t;
const load = (doc: string, collaborative = false, maxLength = 2097152, customHistory = false) => {
  editor?.destroy();
  errors.length = 0;
  calls.length = 0;
  editor = createTextEditor({
    parent: root,
    doc,
    label: "Text",
    onDroppedImages: (count) => errors.push(`images:${count}`),
    host: {
      cellLabel: (row, column) => labels.cellLabel({ row, column }),
      maxLength,
      onCellSelection: (selection) => {
        cellSelection = selection;
      },
      ...(customHistory ? { undo: () => calls.push("undo"), redo: () => calls.push("redo") } : {}),
      maxPasteCells: 2000,
      onRecovery: (text) => errors.push(`recovery:${text}`),
      onError: (code) => errors.push(code),
      ...(collaborative
        ? {
            structure: {
              available: () => navigator.onLine,
              perform: async (action: MenuAction) => {
                calls.push(action);
              },
            },
          }
        : {}),
    },
  });
};
const fixture = "Before\n\n| Product | Count |\n| :--- | ---: |\n| Paper | 4 |\n| Ink | 2 |\n\nAfter";
load(fixture);
window.sharedEditorHarness = {
  load,
  text: () => editor.view.state.doc.toString(),
  errors: () => [...errors],
  cellSelection: () => cellSelection,
  caret: () => editor.view.state.selection.main.head,
  calls: () => [...calls],
  mode: (mode: "source" | "formatted" | "plain") => editor.setMode(mode),
  readOnly: (on: boolean) => editor.setReadOnly(on),
  remote: (from: number, insert: string, to = from) => editor.view.dispatch({ changes: { from, to, insert } }),
  action: (action: MenuAction) => {
    const wrap = root.querySelector<HTMLElement>(".ste-table");
    if (wrap) runMenuAction(editor.view, wrap, action);
  },
  selection: (from: number, to = from) => {
    editor.view.dispatch({ selection: { anchor: from, head: to } });
    editor.view.focus();
  },
  remoteColumn: (column: number) =>
    editor.view.dispatch({ changes: deleteColumn(findTables(editor.view.state.doc.toString())[0]!, column) }),
  command: (name: keyof typeof commands) => commands[name](editor.view),
  format: (name: InlineFormat = "bold") => formatActiveCell(editor.view, name),
  swapColumn: () => {
    const state = editor.view.state;
    const remove = state.changes(deleteColumn(findTables(state.doc.toString())[0]!, 0));
    const intermediate = state.update({ changes: remove }).state;
    const table = findTables(intermediate.doc.toString())[0]!;
    const append = intermediate.changes(insertColumn(table, table.columns));
    editor.view.dispatch({ changes: remove.compose(append) });
  },
  shiftColumn: () => {
    const state = editor.view.state;
    const insert = state.changes(insertColumn(findTables(state.doc.toString())[0]!, 0));
    const intermediate = state.update({ changes: insert }).state;
    const table = findTables(intermediate.doc.toString())[0]!;
    editor.view.dispatch({ changes: insert.compose(intermediate.changes(deleteColumn(table, table.columns - 1))) });
  },
  map: (from: number, to: number, insert: string) => ChangeSet.of({ from, to, insert }, editor.view.state.doc.length).desc.toJSON(),
};
declare global {
  interface Window {
    sharedEditorHarness: {
      load: (doc: string, collaborative?: boolean, maxLength?: number, customHistory?: boolean) => void;
      text: () => string;
      errors: () => string[];
      caret: () => number;
      cellSelection: () => { anchor: number; head: number } | null;
      calls: () => string[];
      mode: (mode: "source" | "formatted" | "plain") => void;
      readOnly: (on: boolean) => void;
      remote: (from: number, insert: string, to?: number) => void;
      action: (action: MenuAction) => void;
      selection: (from: number, to?: number) => void;
      remoteColumn: (column: number) => void;
      command: (name: keyof typeof commands) => boolean;
      format: (name?: InlineFormat) => boolean;
      swapColumn: () => void;
      shiftColumn: () => void;
      map: (from: number, to: number, insert: string) => unknown;
    };
  }
}
