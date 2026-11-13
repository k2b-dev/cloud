import * as Y from "yjs";
import { compareStreamCursor } from "./cursor";
import { createDoc } from "./documents";
import { applySharedTextEvent, SHARED_TEXT_NAME } from "./events";
import type { SharedTextStoredState, SharedTextSyncEvent } from "./types";

/** One live base for this node's writers. Call apply only from a stream replayed
 * from this cursor or earlier; cursor numbers may contain other tenants' gaps. */
export class RoomWriterBase {
  readonly doc: Y.Doc;
  readonly docId: string;
  cursor: string | null;
  readonly restoreRevision: string;
  writers = 0;
  private encoded: SharedTextStoredState | undefined;

  constructor(docId: string, snapshot: SharedTextStoredState) {
    this.docId = docId;
    this.doc = createDoc(snapshot);
    this.cursor = snapshot.cursor;
    this.restoreRevision = snapshot.restoreRevision;
    this.encoded = snapshot;
  }

  apply(docId: string, event: { cursor: string; data: SharedTextSyncEvent }): void {
    if (docId !== this.docId) return;
    if (this.cursor && compareStreamCursor(event.cursor, this.cursor) <= 0) return;
    if (event.data.restoreRevision !== undefined && event.data.restoreRevision !== this.restoreRevision) return;
    applySharedTextEvent(this.doc, event, docId, this.restoreRevision);
    this.cursor = event.cursor;
    this.encoded = undefined;
  }

  merge(docId: string, snapshot: SharedTextStoredState): void {
    if (docId !== this.docId || snapshot.restoreRevision !== this.restoreRevision) return;
    if (this.cursor && (!snapshot.cursor || compareStreamCursor(snapshot.cursor, this.cursor) <= 0)) return;
    if (snapshot.state) Y.applyUpdate(this.doc, snapshot.state);
    this.cursor = snapshot.cursor;
    this.encoded = snapshot;
  }

  /** A current base needs only the accepted delta; missed remote input requires
   * the fully replayed admission result before its cursor may advance. */
  commit(docId: string, snapshot: SharedTextStoredState, previousCursor: string | null, update: Uint8Array): void {
    if (docId !== this.docId || snapshot.restoreRevision !== this.restoreRevision) return;
    if (this.cursor && (!snapshot.cursor || compareStreamCursor(snapshot.cursor, this.cursor) <= 0)) return;
    if (previousCursor && (!this.cursor || compareStreamCursor(this.cursor, previousCursor) < 0)) {
      this.merge(docId, snapshot);
      return;
    }
    Y.applyUpdate(this.doc, update);
    this.cursor = snapshot.cursor;
    this.encoded = snapshot;
  }

  /** Encoding is needed for admission, never for receiving fan-out. */
  snapshot(): SharedTextStoredState {
    this.encoded ??= {
      state: Y.encodeStateAsUpdate(this.doc),
      text: this.doc.getText(SHARED_TEXT_NAME).toString(),
      cursor: this.cursor,
      restoreRevision: this.restoreRevision,
    };
    return this.encoded;
  }
}
