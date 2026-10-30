import { files } from "@k2b/stdlib/browser";
import * as Y from "yjs";
import { z } from "zod";
import { type NotesStore, randomId } from "./local";
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_NOTE,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ENTRIES,
  MAX_NOTE_LENGTH,
  NOTE_TEXT,
  type NoteShare,
} from "./model";

export type ImportErrorCode = "too_large" | "too_many" | "unsafe_path" | "invalid";
export class ImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ImportError";
  }
}
const identifier = z.string().regex(/^[A-Za-z0-9]{22}$/);
const attachmentSchema = z.object({ key: identifier, name: z.string(), path: z.string(), type: z.string() });
const shareSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("own"), readId: identifier, editId: identifier, sharedAt: z.number().finite().nonnegative() }),
  z.object({
    kind: z.literal("foreign"),
    role: z.enum(["read", "edit"]),
    linkId: identifier,
    readId: identifier,
    addedAt: z.number().finite().nonnegative(),
  }),
]);
const manifestSchema = z.object({
  version: z.literal(1),
  app: z.literal("k2b-notes"),
  exportedAt: z.string().datetime(),
  notes: z.array(
    z.object({
      id: identifier,
      title: z.string(),
      tags: z.array(z.string()),
      createdAt: z.number().finite().nonnegative(),
      updatedAt: z.number().finite().nonnegative(),
      file: z.string(),
      files: z.array(attachmentSchema),
      share: shareSchema.optional(),
    }),
  ),
});
export type ImportEntry = {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  files: { key: string; name: string; blob: Blob }[];
  /** Present only when the export was made with "Links mitnehmen". */
  share?: NoteShare;
};
export type ImportPreview = { name: string; notes: number; images: number; duplicates: string[]; entries: ImportEntry[] };
export type ExportManifest = {
  version: 1;
  app: "k2b-notes";
  exportedAt: string;
  notes: {
    id: string;
    title: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    file: string;
    files: z.infer<typeof attachmentSchema>[];
    share?: NoteShare;
  }[];
};
function safePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f]/.test(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === ".." || part === ".")
  )
    throw new ImportError("unsafe_path");
}
function extension(name: string, type: string): string {
  return (
    /\.([a-zA-Z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ??
    { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[type] ??
    "bin"
  );
}
function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "note"
  );
}
function rewriteImages(text: string, replace: (target: string) => string): string {
  return text.replace(
    /(!\[[^\]]*\]\()([^\s)]+)(\))/g,
    (_match, before: string, target: string, after: string) => before + replace(target) + after,
  );
}
/** Includes links only on explicit request. Dates may be injected for deterministic exports. */
export async function exportAll(
  store: NotesStore,
  options: { includeLinks?: boolean; now?: Date } = {},
): Promise<{ blob: Blob; filename: string; notes: number; images: number }> {
  await store.flush();
  const now = options.now ?? new Date();
  const manifest: ExportManifest = { version: 1, app: "k2b-notes", exportedAt: now.toISOString(), notes: [] };
  const entries: { filename: string; source: string | Blob }[] = [];
  let images = 0;
  for (const record of store.records()) {
    const doc = new Y.Doc();
    let text: string;
    try {
      Y.applyUpdate(doc, await store.encodeState(record.id));
      text = doc.getText(NOTE_TEXT).toString();
    } finally {
      doc.destroy();
    }
    const attachments = await store.listFiles(record.id);
    const file = `notes/${slug(record.meta.title)}-${record.id}.md`;
    const paths = new Map<string, string>();
    const exportedFiles = attachments.map((attachment) => {
      const path = `files/${record.id}/${attachment.key}.${extension(attachment.name, attachment.blob.type)}`;
      paths.set(`file:${attachment.key}`, `../${path}`);
      entries.push({ filename: path, source: attachment.blob });
      images++;
      return { key: attachment.key, name: attachment.name, path, type: attachment.blob.type };
    });
    entries.push({ filename: file, source: rewriteImages(text, (target) => paths.get(target) ?? target) });
    manifest.notes.push({
      id: record.id,
      title: record.meta.title,
      tags: record.meta.tags,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      file,
      files: exportedFiles,
      ...(options.includeLinks && record.share ? { share: record.share } : {}),
    });
  }
  entries.unshift({ filename: "manifest.json", source: JSON.stringify(manifest, null, 2) });
  const zip = await files.createZip(entries);
  return {
    blob: new Blob([new Uint8Array(zip)], { type: "application/zip" }),
    filename: `notes-${now.toISOString().slice(0, 10)}.zip`,
    notes: manifest.notes.length,
    images,
  };
}

type ZipEntry = { filename: string; compressed: Uint8Array; method: number; size: number; crc: number };
/** Validate names (including directories), counts and declared bytes before decompression. */
function inspectZip(bytes: Uint8Array, budget: { bytes: number; entries: number }): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ImportError("invalid");
  const count = view.getUint16(end + 10, true);
  if (count > budget.entries) throw new ImportError("too_many");
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true))
    throw new ImportError("invalid");
  let offset = view.getUint32(end + 16, true);
  let total = 0;
  const names = new Set<string>();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new ImportError("invalid");
    const size = view.getUint32(offset + 24, true);
    total += size;
    if (total > budget.bytes) throw new ImportError("too_large");
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end) throw new ImportError("invalid");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    safePath(name);
    if (names.has(name) || view.getUint16(offset + 8, true) & 1) throw new ImportError("invalid");
    const local = view.getUint32(offset + 42, true);
    const method = view.getUint16(offset + 10, true);
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50 || method !== view.getUint16(local + 8, true))
      throw new ImportError("invalid");
    const localNameLength = view.getUint16(local + 26, true);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    const stop = start + view.getUint32(offset + 20, true);
    if (start > bytes.length || stop > view.getUint32(end + 16, true)) throw new ImportError("invalid");
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(local + 30, local + 30 + localNameLength));
    safePath(localName);
    if (name !== localName || (method !== 0 && method !== 8) || view.getUint16(local + 6, true) & 1) throw new ImportError("invalid");
    if (!name.endsWith("/"))
      entries.push({ filename: name, compressed: bytes.subarray(start, stop), method, size, crc: view.getUint32(offset + 16, true) });
    names.add(name);
    offset = next;
  }
  budget.entries -= count;
  return entries;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// stdlib extractZip checks actual sizes after allocation; this boundary must stop inflation earlier.
async function extractBounded(entries: ZipEntry[], budget: { bytes: number }): Promise<Map<string, Uint8Array>> {
  const archive = new Map<string, Uint8Array>();
  for (const entry of entries) {
    let data = entry.compressed;
    if (entry.method === 8) {
      const reader = new Blob([new Uint8Array(entry.compressed)]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > budget.bytes) throw new ImportError("too_large");
          if (size > entry.size) throw new ImportError("invalid");
          chunks.push(part.value);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
    }
    if (data.length > budget.bytes) throw new ImportError("too_large");
    if (data.length !== entry.size || checksum(data) !== entry.crc) throw new ImportError("invalid");
    budget.bytes -= data.length;
    archive.set(entry.filename, data);
  }
  return archive;
}
export async function readImport(input: File[], store: NotesStore): Promise<ImportPreview> {
  const entries: ImportEntry[] = [];
  const budget = { bytes: MAX_IMPORT_BYTES, entries: MAX_IMPORT_ENTRIES };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const seen = new Set<string>();
  try {
    for (const file of input) {
      safePath(file.name);
      if (file.name.toLowerCase().endsWith(".md")) {
        if (--budget.entries < 0) throw new ImportError("too_many");
        budget.bytes -= file.size;
        if (budget.bytes < 0) throw new ImportError("too_large");
        const text = decoder.decode(await file.arrayBuffer());
        if (text.length > MAX_NOTE_LENGTH) throw new ImportError("too_large");
        entries.push({ id: randomId(), text, createdAt: file.lastModified, updatedAt: file.lastModified, files: [] });
        continue;
      }
      if (!file.name.toLowerCase().endsWith(".zip")) throw new ImportError("invalid");
      // Bound the archive input itself as well as its decompressed output.
      if (file.size > MAX_IMPORT_BYTES) throw new ImportError("too_large");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const zipEntries = inspectZip(bytes, budget);
      const archive = await extractBounded(zipEntries, budget);
      const manifestBytes = archive.get("manifest.json");
      if (!manifestBytes) throw new ImportError("invalid");
      const input: unknown = JSON.parse(decoder.decode(manifestBytes));
      if (input && typeof input === "object" && "notes" in input && Array.isArray(input.notes)) {
        const notes: unknown[] = input.notes;
        if (notes.length > MAX_IMPORT_ENTRIES) throw new ImportError("too_many");
        for (const note of notes)
          if (note && typeof note === "object" && "files" in note && Array.isArray(note.files) && note.files.length > MAX_FILES_PER_NOTE)
            throw new ImportError("too_many");
      }
      const manifest = manifestSchema.parse(input);
      const consumed = new Set<string>(["manifest.json"]);
      const consume = (path: string): Uint8Array => {
        safePath(path);
        if (consumed.has(path)) throw new ImportError("invalid");
        const data = archive.get(path);
        if (!data) throw new ImportError("invalid");
        consumed.add(path);
        return data;
      };
      for (const note of manifest.notes) {
        safePath(note.file);
        if (seen.has(note.id)) throw new ImportError("invalid");
        seen.add(note.id);
        const markdown = consume(note.file);
        if (!note.file.endsWith(".md")) throw new ImportError("invalid");
        if (note.files.length > MAX_FILES_PER_NOTE) throw new ImportError("too_many");
        const paths = new Map<string, string>();
        const attached: ImportEntry["files"] = [];
        const keys = new Set<string>();
        for (const attachment of note.files) {
          safePath(attachment.path);
          if (keys.has(attachment.key)) throw new ImportError("invalid");
          keys.add(attachment.key);
          const data = consume(attachment.path);
          if (data.length > MAX_FILE_BYTES) throw new ImportError("too_large");
          const directory = note.file.split("/").slice(0, -1);
          let shared = 0;
          const target = attachment.path.split("/");
          while (directory[shared] !== undefined && directory[shared] === target[shared]) shared++;
          const relative = "../".repeat(directory.length - shared) + target.slice(shared).join("/");
          paths.set(relative, `file:${attachment.key}`);
          attached.push({ key: attachment.key, name: attachment.name, blob: new Blob([new Uint8Array(data)], { type: attachment.type }) });
        }
        const text = rewriteImages(decoder.decode(markdown), (target) => paths.get(target) ?? target);
        if (text.length > MAX_NOTE_LENGTH) throw new ImportError("too_large");
        entries.push({ id: note.id, text, createdAt: note.createdAt, updatedAt: note.updatedAt, files: attached, share: note.share });
      }
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("invalid", { cause: error });
  }
  const localIds = new Set(store.records().map((record) => record.id));
  return {
    name: input.map((file) => file.name).join(", "),
    notes: entries.length,
    images: entries.reduce((sum, entry) => sum + entry.files.length, 0),
    duplicates: entries.filter((entry) => localIds.has(entry.id)).map((entry) => entry.id),
    entries,
  };
}
/** Rechecks duplicates at apply time. Imported notes are local copies; links return only from an export that took them. */
export async function applyImport(
  preview: ImportPreview,
  store: NotesStore,
  mode: "skip" | "replace" | "both" = "skip",
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  for (const entry of preview.entries) {
    const duplicate = store.records().find((record) => record.id === entry.id);
    if (duplicate && (mode === "skip" || (mode === "replace" && duplicate.share !== null))) {
      skipped++;
      continue;
    }
    let id = entry.id;
    if (duplicate && mode === "both") id = randomId();
    if (duplicate && mode === "replace") {
      const note = await store.open(id);
      try {
        note.doc.transact(() => {
          note.text.delete(0, note.text.length);
          note.text.insert(0, entry.text);
        }, "import");
      } finally {
        await note.close();
      }
      const importedKeys = new Set(entry.files.map((file) => file.key));
      for (const file of await store.listFiles(id)) if (!importedKeys.has(file.key)) await store.removeFile(id, file.key);
    } else
      await store.create(entry.text, {
        id,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        // A second copy beside an existing one never shares its links.
        ...(entry.share && !duplicate ? { share: entry.share } : {}),
      });
    for (const attachment of entry.files) await store.putFile(id, attachment.blob, attachment.name, { key: attachment.key });
    imported++;
  }
  await store.flush();
  return { imported, skipped };
}
