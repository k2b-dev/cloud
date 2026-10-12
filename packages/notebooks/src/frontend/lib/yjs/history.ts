import { isolateHistory } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import type { UndoManager } from "yjs";

/** Honor CodeMirror's conversion boundary before yCollab sends the edit to Yjs. */
export const isolateYjsHistory = (undoManager: UndoManager) =>
  EditorState.transactionExtender.of((tr) => {
    if (tr.annotation(isolateHistory) === "before") undoManager.stopCapturing();
    return null;
  });
