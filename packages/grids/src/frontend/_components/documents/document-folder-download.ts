import type { PublicDocument, PublicDocumentBrowseResponse } from "./public-document-types";

// Keep a browser archive within the existing stored-document byte budget.
// Only one request runs at a time, so downloading a folder cannot fan out load.
export const FOLDER_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const FOLDER_DOWNLOAD_MAX_DOCUMENTS = 1_000;

export class FolderDownloadError extends Error {
  constructor(readonly reason: "limit" | "empty" | "incomplete") {
    super(reason);
  }
}

const safeSegment = (value: string) =>
  value
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
    .trim()
    .replace(/^\.+$/, "_") || "document";

type Entry = { filename: string; source: Uint8Array };
type Options = {
  path: string[];
  signal: AbortSignal;
  loadPage: (path: string[], cursor: string | null, signal: AbortSignal) => Promise<PublicDocumentBrowseResponse>;
  download: (document: PublicDocument, signal: AbortSignal) => Promise<Response>;
  onProgress: (count: number) => void;
};

export async function collectDocumentFolder(options: Options): Promise<Entry[]> {
  const entries: Entry[] = [];
  const documentIds = new Set<string>();
  const visited = new Set<string>();
  let bytes = 0;
  const walk = async (path: string[], prefix: string[]) => {
    options.signal.throwIfAborted();
    const pathKey = JSON.stringify(path);
    if (visited.has(pathKey)) throw new FolderDownloadError("incomplete");
    visited.add(pathKey);
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      options.signal.throwIfAborted();
      const page = await options.loadPage(path, cursor, options.signal);
      for (const document of page.items) {
        if (documentIds.has(document.id)) throw new FolderDownloadError("incomplete");
        documentIds.add(document.id);
        const primary = document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey);
        if (!primary) throw new FolderDownloadError("incomplete");
        if (documentIds.size > FOLDER_DOWNLOAD_MAX_DOCUMENTS || bytes + primary.sizeBytes > FOLDER_DOWNLOAD_MAX_BYTES) {
          throw new FolderDownloadError("limit");
        }
        const response = await options.download(document, options.signal);
        if (!response.ok || !response.body) throw new FolderDownloadError("incomplete");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            options.signal.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (bytes + size > FOLDER_DOWNLOAD_MAX_BYTES || size > primary.sizeBytes) throw new FolderDownloadError("limit");
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (size !== primary.sizeBytes) throw new FolderDownloadError("incomplete");
        const source = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          source.set(chunk, offset);
          offset += chunk.byteLength;
        }
        bytes += size;
        // The stable id prevents collisions even when document filenames repeat.
        entries.push({ filename: [...prefix, `${document.id}-${safeSegment(primary.filename)}`].join("/"), source });
        options.onProgress(entries.length);
      }
      for (const folder of page.folders) {
        if (folder.path.length <= path.length || !path.every((part, index) => folder.path[index] === part)) {
          throw new FolderDownloadError("incomplete");
        }
        await walk(folder.path, [...prefix, safeSegment(folder.key)]);
      }
      cursor = page.hasMore ? page.cursor : null;
      if (page.hasMore && (!cursor || cursors.has(cursor))) throw new FolderDownloadError("incomplete");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  };
  await walk(options.path, []);
  if (!entries.length) throw new FolderDownloadError("empty");
  return entries;
}

export async function downloadDocumentFolder(options: Options): Promise<void> {
  const entries = await collectDocumentFolder(options);
  options.signal.throwIfAborted();
  const { createZip, downloadFileFromContent } = await import("@k2b/stdlib/browser");
  // Stored PDFs are compressed already; avoiding recompression keeps the UI responsive.
  const zip = await createZip(entries, { compressionLevel: 0 });
  options.signal.throwIfAborted();
  downloadFileFromContent(zip, `${safeSegment(options.path.at(-1) ?? "documents")}.zip`, "application/zip");
}
