import { type Accessor, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import type { FileEntry } from "../contracts";
import { loadPreview, type PreviewVariant, previewSource, previewUrl } from "./preview-client";

/** Previews this page has asked for; the oldest are forgotten first (their pictures stay in the browser's cache). */
const LIMIT = 1000;
const ready = new Map<string, Accessor<boolean>>();

/**
 * The picture of a photo for its mark or tile, once the preview service has drawn it. The server and the first picture
 * in the browser show the type mark; the preview is asked for when a row or tile shows (the lists keep only the rows in
 * view), waits while the service draws it, and lies over the mark in the same place, so nothing moves.
 */
export function entryThumbnail(baseId: string | undefined, entry: FileEntry, variant: Extract<PreviewVariant, "small" | "large">) {
  if (isServer || !baseId || previewSource(entry) !== "image") return undefined;
  const url = previewUrl(baseId, entry, variant);
  let shown = ready.get(url);
  if (!shown) {
    const [get, set] = createSignal(false);
    shown = get;
    ready.set(url, get);
    if (ready.size > LIMIT) ready.delete(ready.keys().next().value!);
    // a 200 lands in the browser's cache under the versioned address, so the mark's picture loads from there
    void loadPreview(url, new AbortController().signal).then(
      (result) => set(result.state === "ready"),
      () => {},
    );
  }
  return shown() ? url : undefined;
}
