import { fromBase64Strict } from "@k2b/stdlib";
import * as Y from "yjs";
import type { SharedTextEvent } from "./types";

export const SHARED_TEXT_NAME = "codemirror";
export const sharedTextNodeId = crypto.randomUUID();
export const toBase64 = (data: Uint8Array): string => Buffer.from(data).toString("base64");
export const fromBase64 = fromBase64Strict;

/** A retained event cannot be decoded as a Yjs update: retrying never helps, no replay can pass it. */
export class MalformedSharedTextEventError extends Error {
  constructor(
    readonly docId: string,
    readonly cursor: string,
    cause: unknown,
  ) {
    super(`Malformed sync event for document ${docId} at cursor ${cursor}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MalformedSharedTextEventError";
  }
}

/** Ingress check: a publish is accepted only when it is base64 of a decodable Yjs update. */
export const isValidSharedTextUpdate = (payload: string): boolean => {
  try {
    Y.decodeUpdate(fromBase64(payload));
    return true;
  } catch {
    return false;
  }
};

export const applySharedTextEvent = (
  doc: Y.Doc,
  event: { cursor: string; data: SharedTextEvent },
  docId: string,
  restoreRevision?: string,
): boolean => {
  if (event.data.kind !== "sync") return false;
  if (event.data.restoreRevision !== undefined) {
    if (restoreRevision === undefined) throw new TypeError("A versioned update needs its snapshot restore revision");
    if (event.data.restoreRevision !== restoreRevision) return false;
  }
  try {
    const update = fromBase64(event.data.payload);
    // Decode completely before mutating the document: malformed bytes must not
    // partially integrate state before recovery skips the invalid event.
    Y.decodeUpdate(update);
    Y.applyUpdate(doc, update, `replay:${event.cursor}`);
    return true;
  } catch (error) {
    throw new MalformedSharedTextEventError(docId, event.cursor, error);
  }
};
