import { fileIcons } from "@k2b/stdlib";
import { getFileViewPreviewKind } from "@k2b/ui";
import { apiClient } from "../api/client";
import { ErrorSchema, type FileEntry } from "../contracts";

export const fileIcon = (entry: FileEntry) =>
  `ti ${fileIcons.getFileIcon({ name: entry.name, type: entry.directory ? "directory" : "file" })}`;
export const previewFile = (entry: FileEntry) => ({ path: entry.path, size: entry.size, mediaType: mimeType(entry.name) });
export const previewKind = (entry: FileEntry) => (entry.directory ? null : getFileViewPreviewKind(previewFile(entry)));
function mimeType(name: string) {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv",
  };
  return types[extension];
}
export async function apiFailure(response: { json: () => Promise<unknown> }, fallback: string): Promise<never> {
  const error = ErrorSchema.safeParse(await response.json().catch(() => null));
  throw new Error(error.success ? error.data.message : fallback);
}
export async function contentLease(baseId: string, path: string, signal: AbortSignal, fallback: string) {
  const response = await apiClient.bases[":baseId"].download.$post({ param: { baseId }, json: { path } }, { init: { signal } });
  if (!response.ok) return apiFailure(response, fallback);
  const lease = await response.json();
  const url = new URL(lease.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || lease.method !== "GET") throw new Error(fallback);
  return lease;
}

/** Byte bound is enforced while reading, even if a file changed after stat. No Cloud cookies or token reach Filegate. */
export async function readPreview(baseId: string, entry: FileEntry, signal: AbortSignal, fallback: string) {
  const lease = await contentLease(baseId, entry.path, signal, fallback);
  const limit = (previewKind(entry) === "pdf" ? 50 : 2) * 1024 * 1024;
  try {
    const response = await fetch(lease.url, { signal, credentials: "omit", redirect: "error" });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new Error();
        chunks.push(new Uint8Array(part.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return new Blob(chunks, { type: previewFile(entry).mediaType ?? "text/plain" });
  } catch {
    throw new Error(fallback);
  }
}
