import type { Extension } from "@codemirror/state";
import { yCollab } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { isolateYjsHistory } from "./history";
import { remoteCursors } from "./remote-cursors";

export { isolateYjsHistory } from "./history";
export { resolveTextCursor } from "./relative-cursor";
export { REMOTE_CARET_IDLE_CLASS, REMOTE_CARET_LABEL_IDLE_MS, remoteCursors } from "./remote-cursors";

export type CollabOptions = {
  /** The shared text the editor shows; the application owns its document and transport. */
  text: Y.Text;
  /** The Yjs undo stack of this editor; without it, undo stays CodeMirror's own. */
  undoManager?: Y.UndoManager;
  /**
   * Presence of the other writers. The editor publishes its own cursor as `{ anchor, head }` relative positions in
   * the `cursor` field and draws the others' cursors with `user.name` and `user.color`.
   */
  awareness?: Awareness;
};

/**
 * Collaborative editing for `@k2b/editor`: the Yjs binding, undo steps that keep CodeMirror's history boundaries,
 * and the other writers' cursors. The transport, such as a WebSocket provider, stays in the application.
 */
export const collab = (options: CollabOptions): Extension => [
  yCollab(options.text, null, { undoManager: options.undoManager ?? false }),
  options.undoManager ? isolateYjsHistory(options.undoManager) : [],
  options.awareness ? remoteCursors(options.text, options.awareness) : [],
];
