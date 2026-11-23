/**
 * Deterministic, synchronous ZIP writer with stored (uncompressed) entries.
 * Callers pass validated ASCII names; no ZIP64, encryption, comments or extra fields.
 */
export type ZipStoreEntry = { name: string; bytes: Uint8Array };

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Exact archive size for the given entries, without building it. */
export function zipStoreSize(entries: readonly ZipStoreEntry[]): number {
  return entries.reduce((size, entry) => size + 30 + 46 + 2 * entry.name.length + entry.bytes.byteLength, 22);
}

/** `modified` is a local wall-clock time `YYYY-MM-DDTHH:mm:ss` in 1980–2107, stored as MS-DOS date and time. */
export function zipStore(entries: readonly ZipStoreEntry[], modified: string): Uint8Array {
  const [year, month, day, hour, minute, second] = modified.split(/[-T:]/).map(Number) as [number, number, number, number, number, number];
  if (year < 1980 || year > 2107) throw new RangeError("ZIP timestamps must be in 1980–2107.");
  const dosTime = (hour << 11) | (minute << 5) | (second >> 1);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  if (entries.length > 0xffff) throw new RangeError("Too many ZIP entries without ZIP64.");
  const size = zipStoreSize(entries);
  if (size > 0xffffffff) throw new RangeError("ZIP archive exceeds 4 GiB without ZIP64.");
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  const u16 = (value: number) => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
  const name = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) throw new RangeError("ZIP entry names must be printable ASCII.");
      out[offset++] = code;
    }
  };
  const records = entries.map(entry => ({ ...entry, crc: crc32(entry.bytes), offset: 0 }));
  for (const record of records) {
    record.offset = offset;
    u32(0x04034b50); u16(10); u16(0); u16(0); u16(dosTime); u16(dosDate);
    u32(record.crc); u32(record.bytes.byteLength); u32(record.bytes.byteLength);
    u16(record.name.length); u16(0); name(record.name);
    out.set(record.bytes, offset); offset += record.bytes.byteLength;
  }
  const directory = offset;
  for (const record of records) {
    u32(0x02014b50); u16(10); u16(10); u16(0); u16(0); u16(dosTime); u16(dosDate);
    u32(record.crc); u32(record.bytes.byteLength); u32(record.bytes.byteLength);
    u16(record.name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(record.offset);
    name(record.name);
  }
  const directorySize = offset - directory;
  u32(0x06054b50); u16(0); u16(0); u16(records.length); u16(records.length); u32(directorySize); u32(directory); u16(0);
  return out;
}
