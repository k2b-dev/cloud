import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tableGrid, tableHost } from "../src/text-editor/table";

const errors: string[] = [];
const view = new EditorView({
  parent: document.getElementById("root")!,
  state: EditorState.create({
    doc: "| Head |\n| --- |\n| Paper |",
    extensions: [
      tableHost.of({
        undo() {},
        redo() {},
        boundary() {},
        cellLabel: (row, column) => `Row ${row}, column ${column}`,
        maxLength: 2_097_152,
        maxPasteCells: 2_000,
        onError: (code) => errors.push(code),
        onRecovery: (text) => errors.push(`recovery:${text}`),
      }),
      tableGrid(),
    ],
  }),
});
window.clipboardGrid = { text: () => view.state.doc.toString(), errors: () => [...errors] };
declare global {
  interface Window {
    clipboardGrid: { text: () => string; errors: () => string[] };
  }
}
