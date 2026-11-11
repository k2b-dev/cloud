import { previewSourceKind } from "@k2b/cloud/shared";
import type { FileEntry } from "../contracts";

export type PreviewVariant = "small" | "large" | "pdf" | "text";

/**
 * The version a preview belongs to: Filegate's revision where the root has one, otherwise modification time and size,
 * the same tag the server derives. A new version gets a new address, so the browser may keep every preview forever.
 */
export const previewRevision = (entry: Pick<FileEntry, "revision" | "modified" | "size">) =>
  entry.revision ?? `fs:${entry.modified}:${entry.size}`;

/** What the preview service draws for this file; folders and unknown types keep their type icon without a request. */
export const previewSource = (entry: FileEntry) => (entry.directory ? null : previewSourceKind(entry.name));

/** The cacheable address of one preview; it carries the version, so a cached image is valid until the file changes. */
export const previewUrl = (baseId: string, entry: FileEntry, variant: PreviewVariant) =>
  `/api/filesv2/bases/${encodeURIComponent(baseId)}/preview?${new URLSearchParams({
    path: entry.path,
    rev: previewRevision(entry),
    size: variant,
  })}`;

/** Requests in flight at once from this page; the browser's own image loads are not counted. */
const CONCURRENCY = 4;
/** About half a minute in all; a preview that takes longer shows its type icon until the folder is opened again. */
const MAX_POLLS = 8;
let active = 0;
const waiting: (() => void)[] = [];
const slot = async (signal: AbortSignal) => {
  if (active < CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      waiting.splice(waiting.indexOf(start), 1);
      reject(signal.reason);
    };
    waiting.push(start);
    signal.addEventListener("abort", cancel, { once: true });
  });
};
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else active--;
};
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
  });

/** `failed` can be tried again; `none` means this file has no preview of that kind (too large or not drawable). */
export type PreviewResult = { state: "ready"; blob: Blob } | { state: "failed" } | { state: "none" };

/**
 * Loads one preview, waiting while the service still draws it (202 with Retry-After), within a bounded number of polls.
 * A 200 lands in the browser's cache under the versioned address, so the next view needs no request at all.
 */
export async function loadPreview(url: string, signal: AbortSignal): Promise<PreviewResult> {
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await slot(signal);
    let wait = 0;
    try {
      const response = await fetch(url, { signal, credentials: "same-origin" });
      if (response.status === 200) return { state: "ready", blob: await response.blob() };
      if (response.status !== 202) {
        const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
        return { state: body?.code === "preview_failed" ? "failed" : "none" };
      }
      await response.body?.cancel();
      const after = Number(response.headers.get("Retry-After"));
      wait = Math.min(8, Math.max(1, Number.isFinite(after) && after > 0 ? after : 1 + poll)) * 1000;
    } finally {
      release();
    }
    await pause(wait, signal);
  }
  return { state: "none" };
}

/** Clears a remembered failure for the file's current version and asks for a new attempt. */
export async function retryPreview(baseId: string, entry: FileEntry) {
  const response = await fetch(`/api/filesv2/bases/${encodeURIComponent(baseId)}/preview/retry`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: entry.path }),
  });
  if (!response.ok) throw new Error(`preview retry ${response.status}`);
}

const prefetched = new Set<string>();
/**
 * Warms the browser's cache with the large preview while the pointer rests on a file, so Space shows it without waiting.
 * A preview still being drawn is only requested; the quick view asks again when it opens.
 */
export function prefetchPreview(baseId: string, entry: FileEntry) {
  const kind = previewSource(entry);
  if (kind !== "image" && kind !== "pdf" && kind !== "office") return;
  const url = previewUrl(baseId, entry, "large");
  if (prefetched.has(url)) return;
  prefetched.add(url);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
}
