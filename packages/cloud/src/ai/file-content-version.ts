import { createHash } from "node:crypto";

/** Opaque identity/version for stores whose public file metadata has no counter. */
export function aiFileContentVersion(file: { id: string; updatedAt: string; mediaType: string; bytes: Uint8Array }): string {
  return createHash("sha256")
    .update(JSON.stringify([file.id, file.updatedAt, file.mediaType]))
    .update(file.bytes)
    .digest("hex");
}

/** The destination changed after it was inspected. */
export class AiFileVersionConflict extends Error {
  constructor() {
    super("File version conflict");
    this.name = "AiFileVersionConflict";
  }
}
