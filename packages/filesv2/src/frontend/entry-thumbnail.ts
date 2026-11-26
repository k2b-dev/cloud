import { type Accessor, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import type { FileEntry } from "../contracts";
import { loadPreview, type PreviewVariant, previewSource, previewUrl } from "./preview-client";

/** Previews this page remembers; the oldest drawn ones are forgotten first (their pictures stay in the browser's cache). */
export const THUMBNAIL_LIMIT = 1000;
type Slot = { shown: Accessor<boolean>; settled: boolean };
const slots = new Map<string, Slot>();

/** Forgets drawn previews beyond the limit; a preview still being drawn stays, so it is never asked for twice at once. */
const forgetOld = () => {
  for (const [url, slot] of slots) {
    if (slots.size <= THUMBNAIL_LIMIT) return;
    if (slot.settled) slots.delete(url);
  }
};

/**
 * The picture of a photo for its mark or tile, once the preview service has drawn it. The server and the first picture
 * in the browser show the type mark. Ask only for a photo in view (the table keeps only the rows in view; the grid asks
 * for the tiles it sees), with the signal of the folder it stands in: leaving the folder cancels its waiting previews,
 * so the next folder and an opened file's large preview do not queue behind them. A cancelled photo asks again when it
 * shows again. The picture lies over the mark in the same place, so nothing moves.
 */
export function entryThumbnail(
  baseId: string | undefined,
  entry: FileEntry,
  variant: Extract<PreviewVariant, "small" | "large">,
  signal: AbortSignal,
) {
  if (isServer || !baseId || previewSource(entry) !== "image" || signal.aborted) return undefined;
  const url = previewUrl(baseId, entry, variant);
  let slot = slots.get(url);
  if (!slot) {
    const [shown, setShown] = createSignal(false);
    const created: Slot = { shown, settled: false };
    slot = created;
    slots.set(url, created);
    // a 200 lands in the browser's cache under the versioned address, so the mark's picture loads from there
    void loadPreview(url, signal).then(
      (result) => {
        created.settled = true;
        setShown(result.state === "ready");
        forgetOld();
      },
      () => {
        if (slots.get(url) === created) slots.delete(url);
      },
    );
    forgetOld();
  }
  return slot.shown() ? url : undefined;
}

/** For tests: forgets every preview. */
export const forgetThumbnails = () => slots.clear();
