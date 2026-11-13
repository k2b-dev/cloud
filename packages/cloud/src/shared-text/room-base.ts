import * as Y from "yjs";
import { compareStreamCursor } from "./cursor";
import { createDoc } from "./documents";
import { applySharedTextEvent, SHARED_TEXT_NAME } from "./events";
import type { SharedTextStoredState, SharedTextSyncEvent } from "./types";

/** One live base for this node's writers. Call apply only from a stream replayed
 * from this cursor or earlier; cursor numbers may contain other tenants' gaps. */
export class RoomWriterBase {
  readonly doc: Y.Doc;
  cursor: string | null;
  readonly restoreRevision: string;
  writers = 0;

  constructor(snapshot: SharedTextStoredState) {
    this.doc = createDoc(snapshot);
    this.cursor = snapshot.cursor;
    this.restoreRevision = snapshot.restoreRevision;
  }

  apply(docId: string, event: { cursor: string; data: SharedTextSyncEvent }): void {
    if (this.cursor && compareStreamCursor(event.cursor, this.cursor) <= 0) return;
    if (event.data.restoreRevision !== undefined && event.data.restoreRevision !== this.restoreRevision) return;
    applySharedTextEvent(this.doc, event, docId, this.restoreRevision);
    this.cursor = event.cursor;
  }

  merge(snapshot: SharedTextStoredState): void {
    if (snapshot.restoreRevision !== this.restoreRevision) return;
    if (this.cursor && (!snapshot.cursor || compareStreamCursor(snapshot.cursor, this.cursor) <= 0)) return;
    if (snapshot.state) Y.applyUpdate(this.doc, snapshot.state);
    this.cursor = snapshot.cursor;
  }

  /** Encoding is needed for admission, never for receiving fan-out. */
  snapshot(): SharedTextStoredState {
    return {
      state: Y.encodeStateAsUpdate(this.doc),
      text: this.doc.getText(SHARED_TEXT_NAME).toString(),
      cursor: this.cursor,
      restoreRevision: this.restoreRevision,
    };
  }
}
