import type { SharedTextSyncEvent } from "./types";

/** Freeze owners stop before a faster peer may expire the retained lease. */
export const SHARED_TEXT_FREEZE_SAFETY_MS = 5_000;

/** A broker-ordered lifecycle rejection never acknowledges the input update. */
export class SharedTextBoundaryError extends Error {
  constructor(readonly code: "DOCUMENT_FROZEN" | "DOCUMENT_CLOSED" | "GENERATION_CHANGED") {
    super(code);
    this.name = "SharedTextBoundaryError";
  }
}

export const checkSharedTextBoundary = (event: SharedTextSyncEvent | undefined, revision: string): void => {
  if (!event) return;
  if (event.restoreRevision !== undefined && event.restoreRevision !== revision) throw new SharedTextBoundaryError("GENERATION_CHANGED");
  if (event.restoreRevision !== revision) return;
  if (event.room?.state === "closed") throw new SharedTextBoundaryError("DOCUMENT_CLOSED");
  if (event.room?.state === "frozen" && event.room.expiresAt > Date.now()) throw new SharedTextBoundaryError("DOCUMENT_FROZEN");
};
