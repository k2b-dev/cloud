import { CAPABILITY_MAX_REQUEST_BYTES } from "@k2b/cloud/contracts";
import { createZip } from "@k2b/stdlib/browser";
import { LIMITS } from "../contracts";
import { CloudError, guarded } from "./errors";

// Expanded data shares the existing 16 MiB runtime working-data ceiling, below the 50 MiB chat-file limit.
// At most one expanded budget per bridge-sized compressed input: 16 MiB / 256 KiB = 64.
export const ZIP_LIMITS = {
  fileBytes: LIMITS.inputFileBytes,
  expandedBytes: Math.min(LIMITS.inputFileBytes, LIMITS.rpcBytes),
  entries: LIMITS.files,
  ratio: Math.min(LIMITS.inputFileBytes, LIMITS.rpcBytes) / CAPABILITY_MAX_REQUEST_BYTES,
} as const;
export type ZipEntry = { name: string; size: number; compressedSize: number; directory: boolean };
type Entry = ZipEntry & { start: number; method: number };
export type ZipSource = { name: string; data: string | Blob | Uint8Array | ArrayBuffer };
const invalid = (message: string): never => {
  throw new CloudError("invalid", message);
};
const limit = (message: string): never => {
  throw new CloudError("limit", message);
};
function safeName(name: string) {
  if (!name || /^[\/\\]/.test(name) || /[\\:\0]/.test(name) || name.split("/").some((part) => part === ".." || part === "."))
    invalid("ZIP paths must be relative, without '..', '.', backslashes, drive letters or NUL bytes.");
}
function directory(data: Uint8Array): Entry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === data.length) {
      end = i;
      break;
    }
  }
  if (end < 0) return invalid("Invalid ZIP end record.");
  const count = view.getUint16(end + 10, true);
  const central = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count === 0xffff ||
    central === 0xffffffff
  )
    invalid("Multipart and ZIP64 archives are not supported.");
  if (count > ZIP_LIMITS.entries) limit(`ZIP exceeds the ${ZIP_LIMITS.entries} entry limit; split the archive.`);
  if (central + view.getUint32(end + 12, true) !== end) invalid("Invalid ZIP directory bounds.");
  const entries: Entry[] = [];
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let offset = central,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) invalid("Invalid ZIP directory entry.");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    if (flags & 0x41 || method === 99) invalid("Encrypted ZIP archives are not supported; supply an unencrypted ZIP.");
    if (method !== 0 && method !== 8) invalid("ZIP supports only stored or deflated files.");
    const compressedSize = view.getUint32(offset + 20, true),
      size = view.getUint32(offset + 24, true);
    const length = view.getUint16(offset + 28, true);
    const next = offset + 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end || view.getUint16(offset + 34, true)) invalid("Invalid ZIP entry bounds or disk.");
    const nameBytes = data.subarray(offset + 46, offset + 46 + length);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      return invalid("ZIP filenames must use UTF-8; recreate the archive with UTF-8 filenames.");
    }
    safeName(name);
    if (names.has(name)) invalid("ZIP contains duplicate entry names.");
    names.add(name);
    if (((view.getUint32(offset + 38, true) >>> 16) & 0xf000) === 0xa000) invalid("ZIP symbolic links are not supported.");
    total += size;
    if (total > ZIP_LIMITS.expandedBytes) limit("ZIP exceeds the 16 MiB expanded size limit; split the archive.");
    if (size > compressedSize * ZIP_LIMITS.ratio) limit(`ZIP exceeds the ${ZIP_LIMITS.ratio}:1 expansion ratio limit.`);
    const local = view.getUint32(offset + 42, true);
    if (local + 30 > central || view.getUint32(local, true) !== 0x04034b50) invalid("Invalid ZIP local header.");
    if (view.getUint16(local + 6, true) & 0x41) invalid("Encrypted ZIP archives are not supported; supply an unencrypted ZIP.");
    if (view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method)
      invalid("ZIP local header disagrees with its directory.");
    const localLength = view.getUint16(local + 26, true);
    const start = local + 30 + localLength + view.getUint16(local + 28, true);
    if (start + compressedSize > central || localLength !== length || !nameBytes.every((byte, n) => byte === data[local + 30 + n]))
      invalid("ZIP local path or data bounds disagree with its directory.");
    if (ranges.some(([from, to]) => local < to && start + compressedSize > from)) invalid("ZIP entries overlap.");
    ranges.push([local, start + compressedSize]);
    const isDirectory = name.endsWith("/");
    if ((isDirectory && size !== 0) || (method === 0 && size !== compressedSize)) invalid("Invalid ZIP entry size.");
    entries.push({ name, size, compressedSize, directory: isDirectory, start, method });
    offset = next;
  }
  if (offset !== end) invalid("Invalid ZIP directory length.");
  return entries;
}

/** No filesystem access: paths are identifiers and extraction stays in the runner isolate. */
export async function openZip(file: Blob) {
  if (!(file instanceof Blob)) return invalid("cloud.zip.open expects a ZIP File or Blob.");
  if (file.size > ZIP_LIMITS.fileBytes) limit("ZIP exceeds the 50 MiB file limit.");
  const data = new Uint8Array(await file.arrayBuffer());
  const records = directory(data);
  async function read(name: string): Promise<Uint8Array> {
    const entry = records.find((item) => item.name === name && !item.directory);
    if (!entry) throw new CloudError("not_found", "ZIP file entry not found.");
    const compressed = data.subarray(entry.start, entry.start + entry.compressedSize);
    if (entry.method === 0) return compressed.slice();
    // Read incrementally: a forged size never makes Response.arrayBuffer allocate the full expansion.
    // Small pulls also bound the decompressor's native output queue before our size check runs.
    // 256 KiB / 64 = 4 KiB compressed per pull (at most about 4 MiB with DEFLATE's maximum expansion).
    let at = 0;
    const step = CAPABILITY_MAX_REQUEST_BYTES / ZIP_LIMITS.ratio;
    const stream = new ReadableStream<BufferSource>({
      pull(controller) {
        if (at >= compressed.length) return controller.close();
        const end = Math.min(compressed.length, at + step);
        controller.enqueue(compressed.subarray(at, end));
        at = end;
      },
    }).pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const output = new Uint8Array(entry.size);
    let produced = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        produced += value.byteLength;
        if (produced > entry.size || produced > entry.compressedSize * ZIP_LIMITS.ratio)
          limit("ZIP output exceeds its declared size or expansion budget.");
        output.set(value, produced - value.byteLength);
      }
      if (produced !== entry.size) invalid("ZIP output does not match its declared size.");
      return output;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return Object.freeze({
    entries: Object.freeze(
      records.map(({ name, size, compressedSize, directory }) => Object.freeze({ name, size, compressedSize, directory })),
    ),
    read: guarded(read),
    text: guarded(async (name: string) => new TextDecoder("utf-8", { fatal: true }).decode(await read(name))),
  });
}

export async function createZipFile(sources: ZipSource[], name = "files.zip"): Promise<File> {
  safeName(name);
  if (name.includes("/")) invalid("ZIP output name must be a plain filename.");
  if (!Array.isArray(sources)) invalid("cloud.zip.create expects an array of files.");
  if (sources.length > ZIP_LIMITS.entries) limit(`ZIP exceeds the ${ZIP_LIMITS.entries} entry limit.`);
  const names = new Set<string>();
  let total = 0;
  const files = sources.map((source) => {
    safeName(source.name);
    if (source.name.endsWith("/") || names.has(source.name)) invalid("ZIP needs unique file names, without directory entries.");
    names.add(source.name);
    const value = source.data;
    if (typeof value !== "string" && !(value instanceof Blob) && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer))
      invalid("ZIP file data must be text, a Blob, Uint8Array or ArrayBuffer.");
    total += typeof value === "string" ? new TextEncoder().encode(value).byteLength : value instanceof Blob ? value.size : value.byteLength;
    if (total > ZIP_LIMITS.expandedBytes) limit("ZIP source files exceed the 16 MiB expanded size limit.");
    return { filename: source.name, source: value };
  });
  const bytes = await createZip(files);
  if (bytes.byteLength > ZIP_LIMITS.fileBytes) limit("ZIP exceeds the 50 MiB file limit.");
  // Do not produce an archive the reader would refuse, including unusually high compression.
  directory(bytes);
  return new File([new Uint8Array(bytes)], name, { type: "application/zip", lastModified: 0 });
}
