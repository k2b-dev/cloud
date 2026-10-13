import { isolateHistory } from "@codemirror/commands";
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";
import type { UndoManager } from "yjs";

/** A transaction's own history boundary; a local line break, such as Enter, is an undo step of its own. */
const isolation = (tr: Transaction) => {
  const explicit = tr.annotation(isolateHistory);
  if (explicit || tr.annotation(ySyncAnnotation) || !tr.isUserEvent("input") || tr.isUserEvent("input.paste")) return explicit;
  let lineBreak = false;
  tr.changes.iterChanges((_from, _to, _fromB, _toB, text) => {
    if (text.lines > 1) lineBreak = true;
  });
  return lineBreak ? "full" : undefined;
};

/**
 * Honor CodeMirror's history boundaries in the Yjs undo stack: "before" and
 * "full" close the open undo item before yCollab sends the edit to Yjs, and
 * "after" and "full" close it once the edit is in Yjs.
 */
export const isolateYjsHistory = (undoManager: UndoManager): Extension => [
  EditorState.transactionExtender.of((tr) => {
    const isolate = isolation(tr);
    if (isolate === "before" || isolate === "full") undoManager.stopCapturing();
    return null;
  }),
  // Update listeners run after yCollab's view plugin wrote the transaction to Yjs.
  EditorView.updateListener.of((update) => {
    if (
      update.transactions.some((tr) => {
        const value = isolation(tr);
        return value === "after" || value === "full";
      })
    )
      undoManager.stopCapturing();
  }),
];

/**
 * Run a command as one undo step of its own: close the open undo item before it and again after its last edit, also
 * when the command waits for a picker first. A view destroyed meanwhile ignores the closing transaction.
 */
export const asUndoStep = (view: EditorView, run: () => void | Promise<void>) => {
  view.dispatch({ annotations: isolateHistory.of("before") });
  const close = () => view.dispatch({ annotations: isolateHistory.of("after") });
  let result: void | Promise<void>;
  try {
    result = run();
  } catch (error) {
    close();
    throw error;
  }
  if (result) return result.finally(close);
  close();
};
