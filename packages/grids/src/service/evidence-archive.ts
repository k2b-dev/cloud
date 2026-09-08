import { createHash } from "node:crypto";

export const EVIDENCE_EXPORT_MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export const EVIDENCE_EXPORT_MAX_ENTRIES = 25_000;
const EVIDENCE_EXPORT_CHUNK_BYTES = 1024 * 1024;

type EvidenceArchiveEntry = {
  path: string;
  category: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
};

export class EvidenceExportBoundError extends Error {}

const encoder = new TextEncoder();

export const safeArchiveSegment = (value: string, fallback = "item"): string => {
  const safe = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return safe || fallback;
};

export const assertSafeArchivePath = (path: string): void => {
  if (
    !path ||
    path.length > 100 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe evidence archive path: ${path}`);
  }
};

const writeText = (target: Uint8Array, offset: number, length: number, value: string): void => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error(`TAR field is too long: ${value}`);
  target.set(bytes, offset);
};

const writeOctal = (target: Uint8Array, offset: number, length: number, value: number): void => {
  const text = Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  writeText(target, offset, length, `${text}\0`);
};

export const tarHeader = (path: string, size: number, modifiedAt: Date): Uint8Array => {
  assertSafeArchivePath(path);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid TAR entry size");
  const header = new Uint8Array(512);
  writeText(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o640);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(modifiedAt.getTime() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
};

const oneChunk = async function* (bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
};

export class EvidenceTarWriter {
  readonly entries: EvidenceArchiveEntry[] = [];
  private readonly packageHash = createHash("sha256");
  private buffered = new Uint8Array(EVIDENCE_EXPORT_CHUNK_BYTES);
  private bufferedBytes = 0;
  private writtenBytes = 0;

  constructor(
    private readonly modifiedAt: Date,
    private readonly writeChunk: (bytes: Uint8Array) => Promise<void>,
    private readonly limits: { maxEntries: number; maxPackageBytes: number } = {
      maxEntries: EVIDENCE_EXPORT_MAX_ENTRIES,
      maxPackageBytes: EVIDENCE_EXPORT_MAX_PACKAGE_BYTES,
    },
  ) {}

  private async write(bytes: Uint8Array): Promise<void> {
    if (this.writtenBytes + bytes.byteLength > this.limits.maxPackageBytes) {
      throw new EvidenceExportBoundError(`Evidence package exceeds the ${this.limits.maxPackageBytes} byte limit.`);
    }
    this.packageHash.update(bytes);
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
    await this.writeChunk(this.buffered.slice(0, this.bufferedBytes));
    this.buffered = new Uint8Array(EVIDENCE_EXPORT_CHUNK_BYTES);
    this.bufferedBytes = 0;
  }

  async addBytes(path: string, category: string, mediaType: string, bytes: Uint8Array): Promise<EvidenceArchiveEntry> {
    return this.add(path, category, mediaType, bytes.byteLength, oneChunk(bytes));
  }

  async addJson(path: string, category: string, value: unknown): Promise<EvidenceArchiveEntry> {
    return this.addBytes(path, category, "application/json", encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
  }

  async add(
    path: string,
    category: string,
    mediaType: string,
    sizeBytes: number,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<EvidenceArchiveEntry> {
    if (this.entries.length >= this.limits.maxEntries) {
      throw new EvidenceExportBoundError(`Evidence package exceeds the ${this.limits.maxEntries} entry limit.`);
    }
    assertSafeArchivePath(path);
    await this.write(tarHeader(path, sizeBytes, this.modifiedAt));
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of chunks) {
      received += chunk.byteLength;
      if (received > sizeBytes) throw new Error(`Evidence entry ${path} exceeded its declared size.`);
      hash.update(chunk);
      await this.write(chunk);
    }
    if (received !== sizeBytes) throw new Error(`Evidence entry ${path} did not match its declared size.`);
    const padding = (512 - (sizeBytes % 512)) % 512;
    if (padding > 0) await this.write(new Uint8Array(padding));
    const entry = { path, category, mediaType, sizeBytes, sha256: hash.digest("hex") };
    this.entries.push(entry);
    return entry;
  }

  async finish(): Promise<{ sizeBytes: number; sha256: string }> {
    await this.write(new Uint8Array(1024));
    await this.flush();
    return { sizeBytes: this.writtenBytes, sha256: this.packageHash.digest("hex") };
  }
}
