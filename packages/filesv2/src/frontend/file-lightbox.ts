import { text } from "@k2b/stdlib";
import { fileKindLabel, type LightboxAction, type LightboxItem, toast } from "@k2b/ui";
import type { FileEntry } from "../contracts";
import { contentLease, inlinePdfHref, previewFile, previewKind, readPreview } from "./file-preview";
import { loadPreview, previewSource, previewUrl } from "./preview-client";

/** What a file in the Lightbox can do in Files; each command keeps the place it had in the preview dialog. */
export type FileLightboxActions = {
  onDownload: (entry: FileEntry) => void;
  /** Opens the file in its editor, such as Markdown; the blue Open pill leads to it. */
  onOpen?: (entry: FileEntry) => void;
  /** The editor opens read-only, so Open says so. */
  readOnly?: (entry: FileEntry) => boolean;
  onShare?: (entry: FileEntry) => void;
};

export type FileLightboxMessages = {
  open: string;
  openReadOnly: string;
  openInTab: string;
  copyText: string;
  copied: string;
  share: string;
  failed: string;
};

const TEXT_KINDS = new Set(["markdown", "json", "delimited-text", "text"]);

/**
 * One stored file as the Lightbox shows it: pictures, videos and audio from a short-lived lease, PDFs from Files' own
 * inline address, text read within its bound, and Office documents through the preview service's PDF.
 */
export function fileLightboxItem(
  baseId: string,
  entry: FileEntry,
  actions: FileLightboxActions,
  t: FileLightboxMessages,
  locale: string,
): LightboxItem {
  const kind = previewKind(entry);
  const office = previewSource(entry) === "office";
  // Every read follows the Lightbox's signal, so moving on or closing stops it; Copy text reads on its own.
  const lease = (signal: AbortSignal) => contentLease(baseId, entry.path, signal, t.failed).then((granted) => granted.url);
  const readText = async (signal: AbortSignal) => {
    const blob = await readPreview(baseId, entry, signal, t.failed);
    return blob.text();
  };
  const commands: LightboxAction[] = [];
  if (kind && TEXT_KINDS.has(kind))
    commands.push({
      label: t.copyText,
      icon: "ti ti-copy",
      onClick: () =>
        void readText(new AbortController().signal)
          .then((content) => navigator.clipboard.writeText(content))
          .then(
            () => toast.success(t.copied),
            () => toast.error(t.failed),
          ),
    });
  if (kind === "pdf")
    commands.push({
      label: t.openInTab,
      icon: "ti ti-external-link",
      onClick: () => window.open(inlinePdfHref(baseId, entry.path), "_blank"),
    });
  if (actions.onShare) commands.push({ label: t.share, icon: "ti ti-share", onClick: () => actions.onShare!(entry) });
  const facts = [fileKindLabel({ name: entry.name }, locale), text.pprintBytes(entry.size, { locale })];
  return {
    name: entry.name,
    meta: facts.filter(Boolean).join(" · "),
    // A video streams through range requests, so its size never bounds the preview.
    file: kind === "video" ? { path: entry.path, mediaType: previewFile(entry).mediaType } : previewFile(entry),
    src: kind === "pdf" ? inlinePdfHref(baseId, entry.path) : kind === "image" || kind === "video" || kind === "audio" ? lease : undefined,
    load:
      kind && TEXT_KINDS.has(kind)
        ? async (signal: AbortSignal) => ({
            encoding: "utf8" as const,
            content: await readText(signal),
            mediaType: previewFile(entry).mediaType ?? "text/plain",
          })
        : undefined,
    preview: office
      ? async (signal: AbortSignal) => {
          const result = await loadPreview(previewUrl(baseId, entry, "pdf"), signal);
          if (result.state !== "ready") throw new Error(t.failed);
          return result.blob;
        }
      : undefined,
    thumbnail: previewSource(entry) && previewSource(entry) !== "text" ? previewUrl(baseId, entry, "small") : undefined,
    open: actions.onOpen ? { label: actions.readOnly?.(entry) ? t.openReadOnly : t.open, onOpen: () => actions.onOpen!(entry) } : undefined,
    actions: commands,
    onDownload: () => actions.onDownload(entry),
  };
}
