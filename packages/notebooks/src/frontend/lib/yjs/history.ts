import { isolateHistory } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { UndoManager } from "yjs";

/**
 * Honor CodeMirror's history boundaries in the Yjs undo stack: "before" and
 * "full" close the open undo item before yCollab sends the edit to Yjs, and
 * "after" and "full" close it once the edit is in Yjs.
 */
export const isolateYjsHistory = (undoManager: UndoManager): Extension => [
  EditorState.transactionExtender.of((tr) => {
    const isolate = tr.annotation(isolateHistory);
    if (isolate === "before" || isolate === "full") undoManager.stopCapturing();
    return null;
  }),
  // Update listeners run after yCollab's view plugin wrote the transaction to Yjs.
  EditorView.updateListener.of((update) => {
    const isolate = update.transactions.some((tr) => {
      const value = tr.annotation(isolateHistory);
      return value === "after" || value === "full";
    });
    if (isolate) undoManager.stopCapturing();
  }),
];
