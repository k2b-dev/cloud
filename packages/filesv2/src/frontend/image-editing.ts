import type { ImageEditorFeatures, ImageEditorFormat } from "@k2b/ui";
import { apiClient } from "../api/client";
import { CONTENT_STREAM_LIMIT, type FileEntry } from "../contracts";
import { markdownRevision } from "../document-assets";
import { apiFailure, contentLease, previewFile } from "./file-preview";

export const filesImageFeatures = {
  crop: true,
  rotate: true,
  straighten: true,
  adjust: true,
  filters: true,
  annotate: true,
  redact: true,
  export: { formats: ["image/jpeg", "image/png", "image/webp"], quality: true, resize: true },
} satisfies ImageEditorFeatures;

export function imageOriginalFormat(entry: FileEntry): ImageEditorFormat | undefined {
  const type = previewFile(entry).mediaType;
  return type === "image/jpeg" || type === "image/png" || type === "image/webp" ? type : undefined;
}

export function imageCopyPath(path: string, type: ImageEditorFormat, edited: string, number: number) {
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash + 1);
  const stem = path.slice(slash + 1).replace(/\.[^.]+$/, "");
  const extension = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : "webp";
  return `${folder}${stem} (${edited}${number > 1 ? ` ${number}` : ""}).${extension}`;
}

/** Pin bytes and their revision together; later exports never read a mutable source URL. */
export async function loadImageForEditing(
  baseId: string,
  path: string,
  signal: AbortSignal,
  messages: { failed: string; tooLarge: string; changed: string },
) {
  const metadata = await apiClient.bases[":baseId"].entry.$get({ param: { baseId }, query: { path } }, { init: { signal } });
  if (!metadata.ok) await apiFailure(metadata, messages.failed);
  const initial = await metadata.json();
  if (initial.entry.actions?.write !== true) throw new Error(messages.failed);
  if (initial.entry.size > CONTENT_STREAM_LIMIT) throw new Error(messages.tooLarge);
  const lease = await contentLease(baseId, path, signal, messages.failed);
  const response = await fetch(lease.url, { signal, credentials: "omit", redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(messages.failed);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CONTENT_STREAM_LIMIT) throw new Error(messages.tooLarge);
      chunks.push(new Uint8Array(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let revision = markdownRevision(initial.entry);
  if (initial.base.managed) {
    const etag = response.headers.get("etag");
    if (!etag || !/^"[^"\\]+"$/.test(etag)) throw new Error(messages.failed);
    revision = etag.slice(1, -1);
  } else {
    const current = await apiClient.bases[":baseId"].entry.$get({ param: { baseId }, query: { path } }, { init: { signal } });
    if (!current.ok) await apiFailure(current, messages.failed);
    if (markdownRevision((await current.json()).entry) !== revision) throw new Error(messages.changed);
  }
  return {
    ...initial,
    revision,
    source: new Blob(chunks, { type: previewFile(initial.entry).mediaType ?? response.headers.get("content-type") ?? "" }),
  };
}
