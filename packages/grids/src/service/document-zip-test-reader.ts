import { crc32, inflateRawSync } from "node:zlib";

/**
 * Test-only ZIP reader, written against the specification rather than the
 * writer: end record, central directory, then every local header and CRC.
 */
export const readZipArchive = (archive: Uint8Array): { path: string; method: number; bytes: Uint8Array }[] => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`Invalid ZIP archive: ${message}`);
  };
  let end = -1;
  for (let offset = archive.byteLength - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  check(end >= 0, "missing end of central directory");
  const entryCount = view.getUint16(end + 10, true);
  check(view.getUint16(end + 8, true) === entryCount, "entry counts differ");
  const directoryBytes = view.getUint32(end + 12, true);
  let cursor = view.getUint32(end + 16, true);
  check(cursor + directoryBytes === end, "central directory size");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: { path: string; method: number; bytes: Uint8Array }[] = [];
  for (let index = 0; index < entryCount; index++) {
    check(view.getUint32(cursor, true) === 0x02014b50, "central header signature");
    const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const sizeBytes = view.getUint32(cursor + 24, true);
    const nameBytes = view.getUint16(cursor + 28, true);
    const extraBytes = view.getUint16(cursor + 30, true);
    const commentBytes = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    const path = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameBytes));
    check(view.getUint32(local, true) === 0x04034b50, `local header signature for ${path}`);
    check(view.getUint16(local + 8, true) === method, `method for ${path}`);
    check(view.getUint32(local + 14, true) === checksum, `crc for ${path}`);
    check(view.getUint32(local + 18, true) === compressedBytes, `compressed size for ${path}`);
    check(view.getUint32(local + 22, true) === sizeBytes, `size for ${path}`);
    const localNameBytes = view.getUint16(local + 26, true);
    const localExtraBytes = view.getUint16(local + 28, true);
    check(decoder.decode(archive.subarray(local + 30, local + 30 + localNameBytes)) === path, `local name for ${path}`);
    const dataStart = local + 30 + localNameBytes + localExtraBytes;
    const data = archive.subarray(dataStart, dataStart + compressedBytes);
    check(method === 0 || method === 8, `method ${method} for ${path}`);
    const bytes = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
    check(bytes.byteLength === sizeBytes, `inflated size for ${path}`);
    check(crc32(bytes) === checksum, `crc mismatch for ${path}`);
    entries.push({ path, method, bytes });
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  return entries;
};
