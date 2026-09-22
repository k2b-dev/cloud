import { crc32, deflateRawSync } from "node:zlib";

/**
 * Archive bounds, derived from measured budgets (see the #52 Dex task):
 * - 512 MiB matches the evidence package bound, stays 2x under the 1 GB
 *   Postgres bytea datum limit and 4x under `grids.files.size_bytes`
 *   (integer). A streamed 512 MiB build measured 16-25 s, far inside the
 *   120 s workflow lease, with ~56 MiB application RSS.
 * - 10,000 entries equals the captured-row budget (MAX_WORKFLOW_QUERY_ROWS)
 *   and keeps the provenance manifest inside the 5 MiB profile output budget.
 *   Both bounds stay below the plain ZIP limits (65,535 entries, 4 GiB
 *   offsets), so the writer needs no ZIP64 records and asserts that.
 */
export const DOCUMENT_ZIP_MAX_BYTES = 512 * 1024 * 1024;
export const DOCUMENT_ZIP_MAX_ENTRIES = 10_000;
/** Longest archive path; folder (64) + separator + filename (255) fits with margin. */
export const DOCUMENT_ZIP_MAX_PATH_BYTES = 512;

export class DocumentZipBoundError extends Error {
  constructor(
    readonly bound: "bytes" | "entries",
    readonly limit: number,
  ) {
    super(`Archive exceeds the ${limit} ${bound} limit.`);
  }
}

export type DocumentZipMethod = "store" | "deflate";

/** Already compressed media gain nothing from deflate; keep their bytes verbatim. */
const STORED_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-bzip2",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
]);

export const zipMethodForMediaType = (mediaType: string): DocumentZipMethod => {
  const type = mediaType.toLowerCase();
  if (STORED_MEDIA_TYPES.has(type) || type.startsWith("video/") || type.startsWith("audio/")) return "store";
  return "deflate";
};

export const assertSafeZipPath = (path: string): void => {
  if (
    !path ||
    new TextEncoder().encode(path).byteLength > DOCUMENT_ZIP_MAX_PATH_BYTES ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
};

export type DocumentZipEntry = {
  path: string;
  method: DocumentZipMethod;
  sizeBytes: number;
  compressedBytes: number;
  crc32: number;
  offset: number;
};

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 1 << 11;
const ZIP16_MAX_ENTRIES = 0xffff;
const ZIP16_MAX_BYTES = 0xffffffff;
const CHUNK_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** MS-DOS date/time as ZIP stores it; seconds resolution is halved by the format. */
const dosDateTime = (at: Date): { date: number; time: number } => {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
  };
};

/** Upper bound of the archive bytes an entry adds beyond its (compressed) data. */
export const zipEntryOverheadBytes = (path: string): number =>
  LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES + 2 * encoder.encode(path).byteLength;

export const zipEndRecordBytes = END_RECORD_BYTES;

/**
 * Writes a plain ZIP archive through a chunk sink without holding the archive
 * in memory. Entries arrive as complete buffers (each source artifact is
 * already bounded), so headers carry exact sizes and CRCs and readers need
 * no data descriptors.
 */
export class DocumentZipWriter {
  readonly entries: DocumentZipEntry[] = [];
  private buffered = new Uint8Array(CHUNK_BYTES);
  private bufferedBytes = 0;
  private writtenBytes = 0;
  private readonly stamp: { date: number; time: number };

  constructor(
    modifiedAt: Date,
    private readonly writeChunk: (bytes: Uint8Array) => Promise<void>,
    private readonly limits: { maxEntries: number; maxBytes: number } = {
      maxEntries: DOCUMENT_ZIP_MAX_ENTRIES,
      maxBytes: DOCUMENT_ZIP_MAX_BYTES,
    },
  ) {
    this.stamp = dosDateTime(modifiedAt);
  }

  get sizeBytes(): number {
    return this.writtenBytes;
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (this.writtenBytes + bytes.byteLength > this.limits.maxBytes) {
      throw new DocumentZipBoundError("bytes", this.limits.maxBytes);
    }
    this.writtenBytes += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = Math.min(this.buffered.byteLength - this.bufferedBytes, bytes.byteLength - offset);
      this.buffered.set(bytes.subarray(offset, offset + count), this.bufferedBytes);
      this.bufferedBytes += count;
      offset += count;
      if (this.bufferedBytes === this.buffered.byteLength) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.bufferedBytes === 0) return;
    const chunk = this.buffered.subarray(0, this.bufferedBytes);
    this.buffered = new Uint8Array(CHUNK_BYTES);
    this.bufferedBytes = 0;
    await this.writeChunk(chunk);
  }

  async add(path: string, bytes: Uint8Array, method: DocumentZipMethod): Promise<DocumentZipEntry> {
    if (this.entries.length >= this.limits.maxEntries) throw new DocumentZipBoundError("entries", this.limits.maxEntries);
    assertSafeZipPath(path);
    const name = encoder.encode(path);
    const checksum = crc32(bytes);
    let data = bytes;
    let used = method;
    if (method === "deflate") {
      const deflated = deflateRawSync(bytes);
      // Incompressible data would grow; store it and keep the archive within its bound.
      if (deflated.byteLength < bytes.byteLength) data = new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength);
      else used = "store";
    }
    const offset = this.writtenBytes;
    if (offset + LOCAL_HEADER_BYTES + name.byteLength + data.byteLength > ZIP16_MAX_BYTES)
      throw new Error("Archive exceeds plain ZIP offsets");
    const header = new Uint8Array(LOCAL_HEADER_BYTES + name.byteLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, VERSION_NEEDED, true);
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, used === "deflate" ? 8 : 0, true);
    view.setUint16(10, this.stamp.time, true);
    view.setUint16(12, this.stamp.date, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, data.byteLength, true);
    view.setUint32(22, bytes.byteLength, true);
    view.setUint16(26, name.byteLength, true);
    view.setUint16(28, 0, true);
    header.set(name, LOCAL_HEADER_BYTES);
    await this.write(header);
    await this.write(data);
    const entry = { path, method: used, sizeBytes: bytes.byteLength, compressedBytes: data.byteLength, crc32: checksum, offset };
    this.entries.push(entry);
    return entry;
  }

  async finish(): Promise<{ sizeBytes: number; entryCount: number }> {
    if (this.entries.length > ZIP16_MAX_ENTRIES) throw new Error("Archive exceeds plain ZIP entry count");
    const directoryOffset = this.writtenBytes;
    for (const entry of this.entries) {
      const name = encoder.encode(entry.path);
      const header = new Uint8Array(CENTRAL_HEADER_BYTES + name.byteLength);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, VERSION_NEEDED, true);
      view.setUint16(6, VERSION_NEEDED, true);
      view.setUint16(8, FLAG_UTF8, true);
      view.setUint16(10, entry.method === "deflate" ? 8 : 0, true);
      view.setUint16(12, this.stamp.time, true);
      view.setUint16(14, this.stamp.date, true);
      view.setUint32(16, entry.crc32, true);
      view.setUint32(20, entry.compressedBytes, true);
      view.setUint32(24, entry.sizeBytes, true);
      view.setUint16(28, name.byteLength, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, entry.offset, true);
      header.set(name, CENTRAL_HEADER_BYTES);
      await this.write(header);
    }
    const directoryBytes = this.writtenBytes - directoryOffset;
    if (this.writtenBytes + END_RECORD_BYTES > ZIP16_MAX_BYTES) throw new Error("Archive exceeds plain ZIP offsets");
    const end = new Uint8Array(END_RECORD_BYTES);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, this.entries.length, true);
    view.setUint16(10, this.entries.length, true);
    view.setUint32(12, directoryBytes, true);
    view.setUint32(16, directoryOffset, true);
    view.setUint16(20, 0, true);
    await this.write(end);
    await this.flush();
    return { sizeBytes: this.writtenBytes, entryCount: this.entries.length };
  }
}
