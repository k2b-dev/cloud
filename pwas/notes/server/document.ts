import * as Y from "yjs";
import { NotesError } from "./errors";
import { limits } from "./limits";

export const validateDocument = (doc: Y.Doc, started = performance.now()): Uint8Array => {
  if (doc.store.pendingStructs || doc.store.pendingDs) throw new NotesError("missing_predecessor", 409);
  if ([...doc.share.keys()].some((key) => key !== "text")) throw new NotesError("invalid_document");
  const text = doc.getText("text");
  if (text.length > limits.text) throw new NotesError("text_limit", 413);
  // A shared root loaded from the wire starts as AbstractType. Inspect both its map and sequence.
  if (
    text._map.size ||
    text.toDelta().some(
      (part: { insert: unknown; attributes?: Record<string, unknown> }) =>
        // Postgres text projections cannot represent NUL; reject before durable bytea updates.
        typeof part.insert !== "string" || part.insert.includes("\u0000") || Object.keys(part.attributes ?? {}).length,
    )
  ) {
    throw new NotesError("invalid_document");
  }
  const state = Y.encodeStateAsUpdate(doc);
  if (state.byteLength > limits.stateBytes) throw new NotesError("state_limit", 413);
  if (performance.now() - started > limits.processingMs) throw new NotesError("processing_limit", 429);
  return state;
};
export const decodeDocument = (bytes: Uint8Array): Y.Doc => {
  if (bytes.byteLength > limits.stateBytes) throw new NotesError("state_limit", 413);
  const started = performance.now();
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    validateDocument(doc, started);
    return doc;
  } catch (error) {
    doc.destroy();
    if (error instanceof NotesError) throw error;
    throw new NotesError("invalid_document");
  }
};
