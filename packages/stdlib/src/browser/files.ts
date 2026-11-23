/**
 * File utilities for downloading, zipping, file dialogs, path building,
 * MIME type handling, compression, and Origin Private File System (OPFS) access.
 *
 * Requires a browser environment with DOM access. ZIP and compression operations
 * use native CompressionStream/DecompressionStream (no external dependencies).
 */

type Progress = { current: number; total: number; percent: number };

// ============ Built-in MIME Type Mapping ============

/** Maps MIME types to their associated file extensions (first entry is canonical). */
const MIME_TO_EXT: Record<string, string[]> = {
  // Images
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/svg+xml": ["svg"],
  "image/bmp": ["bmp"],
  "image/tiff": ["tif", "tiff"],
  "image/x-icon": ["ico"],
  "image/avif": ["avif"],
  "image/apng": ["apng"],
  "image/heic": ["heic"],
  "image/heif": ["heif"],
  "image/jxl": ["jxl"],

  // Audio
  "audio/mpeg": ["mp3"],
  "audio/wav": ["wav"],
  "audio/ogg": ["ogg"],
  "audio/flac": ["flac"],
  "audio/aac": ["aac"],
  "audio/mp4": ["m4a"],
  "audio/webm": ["weba"],
  "audio/midi": ["mid", "midi"],
  "audio/x-aiff": ["aif", "aiff"],

  // Video
  "video/mp4": ["mp4"],
  "video/webm": ["webm"],
  "video/x-matroska": ["mkv"],
  "video/x-msvideo": ["avi"],
  "video/quicktime": ["mov"],
  "video/ogg": ["ogv"],
  "video/mpeg": ["mpeg", "mpg"],
  "video/3gpp": ["3gp"],
  "video/x-flv": ["flv"],

  // Documents
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/vnd.oasis.opendocument.text": ["odt"],
  "application/vnd.oasis.opendocument.spreadsheet": ["ods"],
  "application/vnd.oasis.opendocument.presentation": ["odp"],
  "application/rtf": ["rtf"],
  "application/epub+zip": ["epub"],
  "application/vnd.visio": ["vsd"],

  // Text & Code
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "text/tab-separated-values": ["tsv"],
  "text/html": ["html", "htm"],
  "text/css": ["css"],
  "text/javascript": ["js", "mjs"],
  "text/typescript": ["ts"],
  "text/x-typescript": ["tsx"],
  "text/jsx": ["jsx"],
  "text/markdown": ["md"],
  "text/xml": ["xml"],
  "text/calendar": ["ics"],
  "text/x-python": ["py"],
  "text/x-java-source": ["java"],
  "text/x-c": ["c", "h"],
  "text/x-c++src": ["cpp", "cxx"],
  "text/x-shellscript": ["sh"],
  "text/x-ruby": ["rb"],
  "text/x-go": ["go"],
  "text/x-rustsrc": ["rs"],

  // Data & Config
  "application/json": ["json"],
  "application/ld+json": ["jsonld"],
  "application/xml": ["xml"],
  "application/yaml": ["yaml", "yml"],
  "application/toml": ["toml"],
  "application/sql": ["sql"],
  "application/graphql": ["graphql"],

  // Archives
  "application/zip": ["zip"],
  "application/gzip": ["gz"],
  "application/x-tar": ["tar"],
  "application/x-7z-compressed": ["7z"],
  "application/x-rar-compressed": ["rar"],
  "application/x-bzip2": ["bz2"],
  "application/x-xz": ["xz"],
  "application/zstd": ["zst"],

  // Fonts
  "font/ttf": ["ttf"],
  "font/otf": ["otf"],
  "font/woff": ["woff"],
  "font/woff2": ["woff2"],
  "application/vnd.ms-fontobject": ["eot"],

  // Binary & Misc
  "application/wasm": ["wasm"],
  "application/octet-stream": ["bin"],
  "application/x-shockwave-flash": ["swf"],
  "application/java-archive": ["jar"],
  "application/x-apple-diskimage": ["dmg"],
  "application/x-iso9660-image": ["iso"],
  "application/x-deb": ["deb"],
  "application/x-rpm": ["rpm"],
  "model/gltf-binary": ["glb"],
  "model/gltf+json": ["gltf"],
  "model/stl": ["stl"],
  "model/obj": ["obj"],
};

/** Reverse map: file extension to MIME type. */
const EXT_TO_MIME: Record<string, string> = {};
for (const [mimeType, exts] of Object.entries(MIME_TO_EXT)) {
  for (const ext of exts) EXT_TO_MIME[ext] = mimeType;
}

/**
 * Returns the canonical file extension for a MIME type, or `null` if unknown.
 */
export const getExtension = (mimeType: string): string | null =>
  MIME_TO_EXT[mimeType]?.[0] ?? null;

/**
 * Returns the MIME type for a filename or bare extension, or `null` if unknown.
 */
export const getMimeType = (filenameOrExt: string): string | null => {
  const ext = filenameOrExt.includes(".")
    ? filenameOrExt.split(".").pop()!.toLowerCase()
    : filenameOrExt.toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
};

// ============ Download Utilities ============

/**
 * Triggers a file download by creating a temporary anchor element in the DOM.
 *
 * Side effects: briefly appends and removes an `<a>` element to `document.body`,
 * creates and revokes an object URL.
 *
 * @example
 * downloadFileFromContent("hello world", "greeting.txt");
 * downloadFileFromContent(pngBytes, "photo.png", "image/png");
 */
export const downloadFileFromContent = (
  content: string | Uint8Array | ArrayBuffer | Blob,
  filename: string,
  mimeType: string = "text/plain",
): void => {
  const blob = content instanceof Blob ? content : new Blob([content as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Defer revocation: revoking immediately can race the browser's download
  // fetch in some implementations (especially when the tab is busy), causing
  // the download to fail silently.
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

// ============ ZIP Utilities ============

/** Input data that can be added to a ZIP archive. */
export type ZipSource = string | Blob | ArrayBuffer | Uint8Array;

/**
 * Describes a single entry in a ZIP archive.
 *
 * Note: `mimeType` is stored for caller convenience but is not used by
 * {@link createZip} (ZIP format does not carry per-file MIME metadata).
 */
export type ZipFile = {
  filename: string;
  source: ZipSource;
  mimeType?: string;
};

/**
 * Convert various source types to Uint8Array for ZIP compression.
 */
const toUint8Array = async (source: ZipSource): Promise<Uint8Array> => {
  if (source instanceof Uint8Array) {
    return source;
  } else if (source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  } else if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  } else {
    return new TextEncoder().encode(source);
  }
};

// ============ Native Compression Helpers ============

/** CRC32 lookup table (standard polynomial 0xEDB88320). */
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  crc32Table[i] = c;
}

/**
 * Ensure a Uint8Array is backed by a plain ArrayBuffer (not SharedArrayBuffer).
 * Modern DOM APIs (`WritableStream.write`, `Blob` constructor in strict TS)
 * require `Uint8Array<ArrayBuffer>` not `Uint8Array<ArrayBufferLike>`. This
 * helper narrows the type and copies through a fresh ArrayBuffer when needed.
 */
const asPlainBuffer = (data: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (data.buffer instanceof ArrayBuffer) {
    return data as Uint8Array<ArrayBuffer>;
  }
  // SharedArrayBuffer-backed: copy to a plain ArrayBuffer.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
};

/** Compute CRC32 checksum for a Uint8Array. */
const crc32 = (data: Uint8Array): number => {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = crc32Table[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
};

/** Compress data using native deflate-raw (no zlib/gzip wrapper). */
const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(asPlainBuffer(data));
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};

/** Decompress deflate-raw data using native DecompressionStream. */
const inflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(asPlainBuffer(data));
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
};

/**
 * Creates an in-memory ZIP archive from an array of files.
 *
 * Uses native `CompressionStream("deflate-raw")` for compression and builds
 * the ZIP file structure (local headers, central directory, EOCD) manually.
 * The `mimeType` field on {@link ZipFile} entries is ignored.
 *
 * @example
 * const zipData = await createZip([
 *   { filename: "hello.txt", source: "Hello World" },
 *   { filename: "data.json", source: JSON.stringify({ foo: "bar" }) }
 * ]);
 *
 * // With progress reporting
 * const zipData = await createZip(files, {
 *   onProgress: ({ percent }) => console.log(`${Math.round(percent * 100)}%`)
 * });
 */
export const createZip = async (
  files: ZipFile[],
  options?: { compressionLevel?: number; onProgress?: (progress: Progress) => void },
): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const total = files.length;

  // Process each file: convert to bytes, compute CRC, compress
  type ProcessedEntry = {
    nameBytes: Uint8Array;
    rawData: Uint8Array;
    compressedData: Uint8Array;
    crc: number;
    method: number; // 0 = stored, 8 = deflated
  };

  // Reject Zip-Slip-style filenames at archive-creation time. Downstream
  // extractors (including our own `extractZip`) won't see absolute paths,
  // path-traversal segments, or backslashes — all common Zip-Slip vectors.
  const ZIP_FILENAME_FORBIDDEN = /(^[/\\])|(\\)|(^|[/])\.\.([/]|$)/;

  const entries: ProcessedEntry[] = [];
  for (let i = 0; i < total; i++) {
    const { filename, source } = files[i]!;
    if (ZIP_FILENAME_FORBIDDEN.test(filename)) {
      throw new Error(
        `createZip: refusing to add unsafe filename ${JSON.stringify(filename)} ` +
          "(absolute path, backslash, or '..' segment).",
      );
    }
    const nameBytes = encoder.encode(filename);
    const rawData = await toUint8Array(source);
    const crcValue = crc32(rawData);

    // Compress; fall back to stored if compression doesn't help
    const compressed = await deflate(rawData);
    const useDeflate = compressed.length < rawData.length;

    entries.push({
      nameBytes,
      rawData,
      compressedData: useDeflate ? compressed : rawData,
      crc: crcValue,
      method: useDeflate ? 8 : 0,
    });

    options?.onProgress?.({ current: i + 1, total, percent: (i + 1) / total });
  }

  // Calculate total size
  let localHeadersSize = 0;
  let centralDirSize = 0;
  let totalUncompressed = 0;
  for (const entry of entries) {
    localHeadersSize += 30 + entry.nameBytes.length + entry.compressedData.length;
    centralDirSize += 46 + entry.nameBytes.length;
    totalUncompressed += entry.rawData.length;
  }

  // ZIP (no ZIP64) restrictions. Throw a clear error rather than silently
  // emit a corrupt archive.
  if (entries.length > 0xffff) {
    throw new Error(
      `createZip: too many files (${entries.length}); ZIP64 not supported (max ${0xffff}).`,
    );
  }
  if (totalUncompressed > 0xffffffff) {
    throw new Error(
      `createZip: total uncompressed size exceeds 4 GiB; ZIP64 not supported.`,
    );
  }
  for (const entry of entries) {
    if (
      entry.compressedData.length > 0xffffffff ||
      entry.rawData.length > 0xffffffff
    ) {
      throw new Error("createZip: a single file exceeds 4 GiB; ZIP64 not supported.");
    }
  }

  const eocdSize = 22;
  const totalSize = localHeadersSize + centralDirSize + eocdSize;

  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let localOffset = 0;
  const centralDirOffset = localHeadersSize;
  let cdPos = centralDirOffset;
  const offsets: number[] = [];

  // Write local file headers + data
  for (const entry of entries) {
    offsets.push(localOffset);
    const compSize = entry.compressedData.length;
    const uncompSize = entry.rawData.length;

    // Local file header signature
    view.setUint32(localOffset, 0x04034b50, true); localOffset += 4;
    // Version needed to extract
    view.setUint16(localOffset, 20, true); localOffset += 2;
    // General purpose bit flag — bit 11 set so the filename is interpreted
    // as UTF-8 (we always encode via TextEncoder which is UTF-8).
    view.setUint16(localOffset, 0x0800, true); localOffset += 2;
    // Compression method
    view.setUint16(localOffset, entry.method, true); localOffset += 2;
    // Last mod file time & date (zero)
    view.setUint16(localOffset, 0, true); localOffset += 2;
    view.setUint16(localOffset, 0, true); localOffset += 2;
    // CRC-32
    view.setUint32(localOffset, entry.crc, true); localOffset += 4;
    // Compressed size
    view.setUint32(localOffset, compSize, true); localOffset += 4;
    // Uncompressed size
    view.setUint32(localOffset, uncompSize, true); localOffset += 4;
    // Filename length
    view.setUint16(localOffset, entry.nameBytes.length, true); localOffset += 2;
    // Extra field length
    view.setUint16(localOffset, 0, true); localOffset += 2;
    // Filename
    result.set(entry.nameBytes, localOffset); localOffset += entry.nameBytes.length;
    // File data
    result.set(entry.compressedData, localOffset); localOffset += compSize;
  }

  // Write central directory entries
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const compSize = entry.compressedData.length;
    const uncompSize = entry.rawData.length;

    // Central directory file header signature
    view.setUint32(cdPos, 0x02014b50, true); cdPos += 4;
    // Version made by
    view.setUint16(cdPos, 20, true); cdPos += 2;
    // Version needed to extract
    view.setUint16(cdPos, 20, true); cdPos += 2;
    // General purpose bit flag (matches the local header — UTF-8 filename).
    view.setUint16(cdPos, 0x0800, true); cdPos += 2;
    // Compression method
    view.setUint16(cdPos, entry.method, true); cdPos += 2;
    // Last mod file time & date (zero)
    view.setUint16(cdPos, 0, true); cdPos += 2;
    view.setUint16(cdPos, 0, true); cdPos += 2;
    // CRC-32
    view.setUint32(cdPos, entry.crc, true); cdPos += 4;
    // Compressed size
    view.setUint32(cdPos, compSize, true); cdPos += 4;
    // Uncompressed size
    view.setUint32(cdPos, uncompSize, true); cdPos += 4;
    // Filename length
    view.setUint16(cdPos, entry.nameBytes.length, true); cdPos += 2;
    // Extra field length
    view.setUint16(cdPos, 0, true); cdPos += 2;
    // File comment length
    view.setUint16(cdPos, 0, true); cdPos += 2;
    // Disk number start
    view.setUint16(cdPos, 0, true); cdPos += 2;
    // Internal file attributes
    view.setUint16(cdPos, 0, true); cdPos += 2;
    // External file attributes
    view.setUint32(cdPos, 0, true); cdPos += 4;
    // Relative offset of local header
    view.setUint32(cdPos, offsets[i]!, true); cdPos += 4;
    // Filename
    result.set(entry.nameBytes, cdPos); cdPos += entry.nameBytes.length;
  }

  // Write End of Central Directory record
  view.setUint32(cdPos, 0x06054b50, true); cdPos += 4;
  // Disk number
  view.setUint16(cdPos, 0, true); cdPos += 2;
  // Disk where central directory starts
  view.setUint16(cdPos, 0, true); cdPos += 2;
  // Number of central directory records on this disk
  view.setUint16(cdPos, entries.length, true); cdPos += 2;
  // Total number of central directory records
  view.setUint16(cdPos, entries.length, true); cdPos += 2;
  // Size of central directory
  view.setUint32(cdPos, centralDirSize, true); cdPos += 4;
  // Offset of start of central directory
  view.setUint32(cdPos, centralDirOffset, true); cdPos += 4;
  // Comment length
  view.setUint16(cdPos, 0, true);

  return result;
};

/**
 * Extracts files from a ZIP archive.
 *
 * Parses the ZIP central directory, reads each entry, and decompresses
 * using native `DecompressionStream("deflate-raw")`. Supports stored
 * (method 0) and deflated (method 8) entries.
 *
 * @throws {Error} If the ZIP structure is invalid or uses an unsupported compression method.
 *
 * @example
 * const entries = await extractZip(zipBytes);
 * for (const { filename, data } of entries) {
 *   console.log(filename, data.length);
 * }
 */
export const extractZip = async (
  data: Uint8Array,
  options?: {
    onProgress?: (progress: Progress) => void;
    /** Maximum number of entries to extract. Defaults to 65 535 (ZIP spec).
     *  Throws when the archive declares more entries — protects against
     *  zip-bomb-style abuse where a tiny archive declares millions of files. */
    maxEntries?: number;
    /** Maximum total decompressed bytes to produce. Defaults to 256 MiB.
     *  Throws once decompression output exceeds this — second zip-bomb gate. */
    maxBytes?: number;
  },
): Promise<{ filename: string; data: Uint8Array }[]> => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  const maxEntries = options?.maxEntries ?? 0xffff;
  const maxBytes = options?.maxBytes ?? 256 * 1024 * 1024;

  // Find End of Central Directory record (scan backwards for signature 0x06054b50)
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Invalid ZIP: End of Central Directory not found");

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (entryCount > maxEntries) {
    throw new Error(
      `extractZip: archive declares ${entryCount} entries; refusing (max ${maxEntries}).`,
    );
  }

  const results: { filename: string; data: Uint8Array }[] = [];
  let cdPos = centralDirOffset;
  let bytesProduced = 0;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP: bad Central Directory entry signature");
    }

    const method = view.getUint16(cdPos + 10, true);
    const compressedSize = view.getUint32(cdPos + 20, true);
    const uncompressedSize = view.getUint32(cdPos + 24, true);
    const filenameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const localHeaderOffset = view.getUint32(cdPos + 42, true);

    const filename = decoder.decode(data.subarray(cdPos + 46, cdPos + 46 + filenameLen));

    // Skip directory entries
    if (!filename.endsWith("/")) {
      // Read filename + extra length from the LOCAL header. The local
      // header may declare different lengths than the central directory
      // (e.g. macOS Finder, Python `zipfile` add extended timestamps in
      // local extras only). Using the central-directory lengths here would
      // miscompute the data offset and corrupt every file.
      const localFilenameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localFilenameLen + localExtraLen;
      const compressedData = data.subarray(dataStart, dataStart + compressedSize);

      // Pre-flight bomb check: refuse before inflating if the declared
      // uncompressed size would already exceed the budget.
      if (bytesProduced + uncompressedSize > maxBytes) {
        throw new Error(
          `extractZip: declared uncompressed size exceeds maxBytes (${maxBytes}).`,
        );
      }

      let fileData: Uint8Array;
      if (method === 0) {
        // Stored (no compression)
        fileData = compressedData;
      } else if (method === 8) {
        // Deflated
        fileData = await inflate(compressedData);
      } else {
        throw new Error(`Unsupported compression method ${method} for ${filename}`);
      }

      // Post-decompress check (covers cases where the declared size lied).
      bytesProduced += fileData.length;
      if (bytesProduced > maxBytes) {
        throw new Error(
          `extractZip: actual decompressed output exceeds maxBytes (${maxBytes}).`,
        );
      }

      results.push({ filename, data: fileData });
    }

    cdPos += 46 + filenameLen + extraLen + commentLen;
    options?.onProgress?.({ current: i + 1, total: entryCount, percent: (i + 1) / entryCount });
  }

  return results;
};

/**
 * Convenience wrapper that creates a ZIP archive and triggers a browser download.
 *
 * Combines {@link createZip} and {@link downloadFileFromContent}.
 *
 * @example
 * await downloadAsZip([
 *   { filename: "image.webp", source: imageBlob },
 *   { filename: "data.json", source: jsonString }
 * ], "my-files.zip");
 */
export const downloadAsZip = async (
  files: ZipFile[],
  zipFilename: string = "download.zip",
  options?: { compressionLevel?: number; onProgress?: (progress: Progress) => void },
): Promise<void> => {
  const zipData = await createZip(files, options);
  downloadFileFromContent(zipData, zipFilename, "application/zip");
};

/**
 * Creates a reusable download link (`<a>` element) without appending it to the DOM.
 *
 * The returned element holds an object URL. Cleanup strategy:
 * - The object URL is revoked 100 ms after the link is clicked.
 * - If the link is never clicked, the URL is automatically revoked after 60 seconds.
 *
 * Side effects: allocates a blob object URL that persists until cleanup fires.
 */
export const createDownloadLink = (
  content: BlobPart,
  filename: string,
  mimeType: string = "text/plain",
  linkText: string = "Download",
  className: string = "hover-text",
): HTMLAnchorElement => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.textContent = linkText;
  link.className = className;

  let revoked = false;
  const cleanup = () => {
    if (revoked) return;
    revoked = true;
    URL.revokeObjectURL(url);
  };
  link.addEventListener("click", () => setTimeout(cleanup, 100));
  // Auto-cleanup after 60 seconds if never clicked
  setTimeout(cleanup, 60_000);

  return link;
};

// ============ File Dialogs ============

/**
 * Opens the native file picker for single-file selection.
 *
 * Side effects: creates a hidden `<input type="file">`, appends it to the body,
 * triggers a click, and removes it after selection or cancellation.
 *
 * @throws {Error} If the user cancels the dialog or selects no file.
 *
 * @example
 * const file = await showFileDialog({ accept: ".pdf" });
 */
export function showFileDialog(conf: { accept?: string; multiple?: false }): Promise<File>;

/**
 * Opens the native file picker for multi-file selection.
 *
 * Side effects: creates a hidden `<input type="file">`, appends it to the body,
 * triggers a click, and removes it after selection or cancellation.
 *
 * @throws {Error} If the user cancels the dialog or selects no files.
 *
 * @example
 * const files = await showFileDialog({ accept: ".jpg,.png", multiple: true });
 */
export function showFileDialog(conf: { accept?: string; multiple: true }): Promise<File[]>;

/**
 * Implementation of file dialog (overloaded above).
 */
export function showFileDialog(conf?: { accept?: string; multiple?: boolean }): Promise<File | File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";

    if (conf?.accept) {
      input.accept = conf.accept;
    }

    if (conf?.multiple) {
      input.multiple = true;
    }

    input.addEventListener("change", ({ target }) => {
      const files = (target as HTMLInputElement).files;

      document.body.removeChild(input);

      if (!files || files.length === 0) {
        return reject(new Error("No file selected"));
      }

      if (conf?.multiple) {
        resolve(Array.from(files));
      } else {
        resolve(files[0]!);
      }
    });

    input.addEventListener("cancel", () => {
      document.body.removeChild(input);
      reject(new Error("File dialog cancelled"));
    });

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Opens a native folder picker dialog using the `webkitdirectory` attribute.
 *
 * Returns all files in the selected directory (recursively). When `accept` is
 * provided, files are filtered client-side using {@link checkMimeType}.
 *
 * Side effects: creates a hidden `<input type="file">`, appends it to the body,
 * triggers a click, and removes it after selection or cancellation.
 *
 * Assumes the browser supports `webkitdirectory` (Chrome, Edge, Firefox, Safari).
 *
 * @throws {Error} If the user cancels, selects nothing, or no files match `accept`.
 */
export const showFolderDialog = (accept?: string): Promise<File[]> => {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";

    // Enable directory selection
    input.webkitdirectory = true;
    input.multiple = true;

    input.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement;
      const files = target.files;

      document.body.removeChild(input);

      if (files && files.length > 0) {
        let fileArray = Array.from(files);

        // User-space filtering if accept parameter provided
        if (accept) {
          fileArray = fileArray.filter((file) => checkMimeType(file, accept));

          if (fileArray.length === 0) {
            return reject(new Error("No files matched the accepted types"));
          }
        }

        resolve(fileArray);
      } else {
        reject(new Error("No folder selected"));
      }
    });

    input.addEventListener("cancel", () => {
      document.body.removeChild(input);
      reject(new Error("Folder dialog cancelled"));
    });

    document.body.appendChild(input);
    input.click();
  });
};

// ============ Path & MIME Utilities ============

/**
 * Tagged template literal that builds sanitized file paths.
 *
 * Each interpolated value is sanitized per path segment: non-word characters
 * (except `.` and `-`) are replaced with hyphens, leading dots are stripped,
 * and the result is lowercased and truncated to 20 characters. A short
 * non-cryptographic hash suffix is appended to each segment to reduce
 * collision risk when different inputs produce the same sanitized prefix.
 *
 * Static template parts are passed through without hashing but are still
 * joined and cleaned.
 *
 * @example
 * const p = path`uploads/${userName}/${fileName}.txt`;
 * // "uploads/john-doe-a3f2b1/my-file-c8d4e9.txt"
 */
export const path = (strings: TemplateStringsArray, ...values: unknown[]): string => {
  const sanitize = (segment: string): string => {
    const cleaned = segment
      .toString()
      .replace(/[^\w.-]/g, "-")
      .replace(/^\.+/, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 20); // Limit length for readability

    // Create hash synchronously using a simple hash function
    let hashValue = 0;
    for (let i = 0; i < segment.length; i++) {
      hashValue = (hashValue << 5) - hashValue + segment.charCodeAt(i);
      hashValue = hashValue | 0;  // Force 32-bit integer
    }
    const shortHash = Math.abs(hashValue).toString(36).slice(0, 6);

    return cleaned ? `${cleaned}-${shortHash}` : shortHash;
  };

  let result = "";
  strings.forEach((str, i) => {
    result += str;
    if (i < values.length) {
      const value = values[i];
      result += String(value).split("/").map(sanitize).filter(Boolean).join("/");
    }
  });

  return result
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
};

/**
 * Converts a comma-separated MIME type string into an HTML `<input accept>` value.
 *
 * Wildcard types (e.g. `image/*`) are kept as-is. Specific MIME types are
 * resolved to file extensions via the built-in MIME map and both the extension
 * and the original MIME type are included. Duplicates are removed.
 *
 * @example
 * mimeTypesToAccept("image/*,application/pdf"); // "image/*,.pdf,application/pdf"
 * mimeTypesToAccept("image/jpeg,image/png");    // ".jpg,.jpeg,.png,image/jpeg,image/png"
 */
export const mimeTypesToAccept = (mimeTypes: string): string => {
  if (!mimeTypes) return "";

  const results = mimeTypes
    .split(",")
    .map((t) => t.trim())
    .flatMap((t) => {
      if (t.endsWith("/*")) return t;

      const ext = getExtension(t);
      return ext ? [`.${ext}`, t] : t;
    });

  return [...new Set(results)].join(",");
};

/**
 * Checks whether a file or MIME type string matches an `accept` filter.
 *
 * Supports three match formats in the `accept` string (comma-separated):
 * - Extension: `".pdf"` -- matches by file extension or by resolving the
 *   extension to a MIME type via the built-in MIME map.
 * - Wildcard: `"image/*"` -- matches any MIME type with the given prefix.
 * - Exact: `"application/pdf"` -- matches the MIME type exactly.
 *
 * When given a `File`, the file's `.type` is used. If the file has no
 * `.type`, a MIME lookup by filename is attempted as a fallback.
 *
 * Returns `true` if `accept` is empty (everything is accepted).
 *
 * @example
 * checkMimeType(file, "image/*");           // true for any image
 * checkMimeType(file, ".pdf,image/*");      // true for PDFs or any image
 * checkMimeType("application/pdf", ".pdf"); // true
 */
export const checkMimeType = (fileOrType: File | string, accept: string): boolean => {
  if (!accept) return true;

  const isFile = typeof fileOrType !== "string";
  const fileName = isFile ? fileOrType.name.toLowerCase() : "";
  const mimeType = (isFile ? fileOrType.type : fileOrType) || getMimeType(fileName) || "";

  return accept
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .some((p) => {
      if (p.startsWith(".")) {
        return fileName.endsWith(p) || getMimeType(p.slice(1)) === mimeType;
      }
      if (p.endsWith("/*")) {
        return mimeType.startsWith(p.slice(0, -1));
      }
      return mimeType === p;
    });
};

// ============ Compression Utilities ============

/**
 * Compresses data using native gzip via `CompressionStream`.
 *
 * @example
 * const compressed = await compress(new TextEncoder().encode("hello world"));
 */
export const compress = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await new Response(
    new Blob([asPlainBuffer(data)]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer());

/**
 * Decompresses gzip data using native `DecompressionStream`.
 *
 * @example
 * const original = await decompress(compressedBytes);
 */
export const decompress = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await new Response(
    new Blob([asPlainBuffer(data)]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer());

// ============ OPFS (Origin Private File System) ============

/**
 * Wrapper around the Origin Private File System (OPFS) browser API.
 *
 * OPFS provides a sandboxed, persistent filesystem private to the origin.
 * Data survives page reloads and is not visible to other origins or the
 * user's regular filesystem.
 *
 * Requires a browser that supports `navigator.storage.getDirectory()`.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
 */
export const OPFS = {
  /**
   * Navigates to a directory by walking the given path segments from the OPFS root.
   *
   * When `create` is true, missing directories are created along the way.
   *
   * @throws {DOMException} If a segment does not exist and `create` is false.
   *
   * @example
   * const dir = await OPFS.getDirHandle(["data", "images"], true);
   */
  getDirHandle: async (segments: string[], create: boolean = false): Promise<FileSystemDirectoryHandle> => {
    let dir = await navigator.storage.getDirectory();

    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }

    return dir;
  },

  /**
   * Writes a file at the given slash-separated path, creating parent directories as needed.
   *
   * Overwrites the file if it already exists. The writable stream is always closed,
   * even if the write throws.
   *
   * @example
   * await OPFS.write("data/images/photo.bin", uint8Array);
   */
  write: async (name: string, data: Uint8Array): Promise<void> => {
    const segments = name.split("/").filter(Boolean);
    if (segments.length === 0) throw new Error("Invalid path: empty");
    const fileName = segments.pop()!;
    const dir = await OPFS.getDirHandle(segments, true);

    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data));
    } finally {
      await writable.close();
    }
  },

  /**
   * Reads a file from the given slash-separated path.
   *
   * Returns `undefined` (instead of throwing) if the file or any parent
   * directory does not exist.
   *
   * @example
   * const data = await OPFS.read("data/images/photo.bin");
   * if (data) processData(data);
   */
  read: async (name: string): Promise<Uint8Array | undefined> => {
    const segments = name.split("/").filter(Boolean);
    if (segments.length === 0) throw new Error("Invalid path: empty");
    const fileName = segments.pop()!;
    try {
      const dir = await OPFS.getDirHandle(segments);
      const fileHandle = await dir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (err) {
      // "File not found" is the documented sentinel for `undefined`. Other
      // failures (permissions, quota, corruption) are real errors and must
      // propagate so callers can surface them — silently returning undefined
      // for them was hiding important failures.
      if (err instanceof DOMException && err.name === "NotFoundError") {
        return undefined;
      }
      throw err;
    }
  },

  /**
   * Deletes a file or directory (recursively) at the given slash-separated path.
   *
   * @throws {DOMException} If the entry does not exist.
   */
  delete: async (name: string): Promise<void> => {
    const segments = name.split("/").filter(Boolean);
    if (segments.length === 0) throw new Error("Invalid path: empty");

    const fileName = segments.pop()!;
    const dir = await OPFS.getDirHandle(segments);

    await dir.removeEntry(fileName, { recursive: true });
  },

  /**
   * Lists the entries (files and subdirectories) in the given directory.
   *
   * Directory names are suffixed with `/`. Returns an empty array if the
   * directory does not exist.
   *
   * @example
   * const entries = await OPFS.ls("data/images");
   * // ["photo.bin", "thumbnails/"]
   */
  ls: async (dirPath: string = ""): Promise<string[]> => {
    try {
      const segments = dirPath.split("/").filter(Boolean);
      const dir = await OPFS.getDirHandle(segments);

      const entries: string[] = [];
      for await (const entry of (dir as any).values()) {
        entries.push(entry.name + (entry.kind === "directory" ? "/" : ""));
      }
      return entries.sort();
    } catch {
      return [];
    }
  },
};

/** File utilities namespace exposing all file-related helpers. */
export const files = {
  downloadFileFromContent,
  createZip,
  extractZip,
  downloadAsZip,
  createDownloadLink,
  showFileDialog,
  showFolderDialog,
  path,
  mimeTypesToAccept,
  checkMimeType,
  compress,
  decompress,
  OPFS,
  getMimeType,
  getExtension,
} as const;
