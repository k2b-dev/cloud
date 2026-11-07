// Matches the concept spike's engine + Yjs + awareness measurement; the component fixture also measures the UI controls.
import { yCollab } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createTextEditor } from "../src/text-editor/engine";

export { commands } from "../src/text-editor/format";

const doc = new Y.Doc();
const text = doc.getText("codemirror");
const awareness = new Awareness(doc);
const history = new Y.UndoManager(text);
export const editor = createTextEditor({
  parent: document.body,
  label: "Text",
  extensions: yCollab(text, awareness, { undoManager: history }),
  host: {
    maxLength: 2097152,
    maxPasteCells: 2000,
    cellLabel: (row, column) => `Row ${row}, column ${column}`,
    onError: console.error,
    onRecovery: console.warn,
    undo: () => history.undo(),
    redo: () => history.redo(),
    boundary: () => history.stopCapturing(),
  },
});
