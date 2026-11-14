/**
 * One way to open a notebook attachment from every place that shows one: the attachments overview, the details
 * panel, a file pill or image in the editor, and a link or image in Book. Every preview opens in the shared Lightbox:
 * images, PDFs, Markdown, text, JSON and tables. A list opens with all its attachments, so the arrow keys step through
 * them; a file without a preview shows its facts and Download there. Clicked on its own, such a file keeps the
 * confirmed download.
 */
import { SAVE_FILES_ICON, saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
import { encoding } from "@k2b/stdlib";
import {
  type FileViewContent,
  type FileViewPreviewKind,
  fileKindLabel,
  formatFileViewSize,
  getFileViewPreviewKind,
  Lightbox,
  type LightboxAction,
  type LightboxItem,
  toast,
} from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { apiClient } from "@/api/client";
import { notebookWorkspaceMessages } from "../[id]/messages";
import { buildAttachmentContentUrl, confirmAndDownload } from "./editor/attachment-url";

export type PreviewAttachment = { id: string; filename: string; mimeType: string; sizeBytes: number };

/**
 * How the Lightbox shows this attachment, or null when it has no preview. The content endpoint serves images other
 * than SVG and PDFs inline, which the Lightbox needs. It serves audio and video only as downloads, so they have none.
 */
export const attachmentPreviewKind = (attachment: PreviewAttachment): FileViewPreviewKind | null => {
  const kind = getFileViewPreviewKind({ path: attachment.filename, mediaType: attachment.mimeType, size: attachment.sizeBytes });
  if (kind === "image") return attachment.mimeType.startsWith("image/") && attachment.mimeType !== "image/svg+xml" ? kind : null;
  if (kind === "pdf") return attachment.mimeType === "application/pdf" ? kind : null;
  return kind === "audio" || kind === "video" ? null : kind;
};

/** Plain text and JSON show no code box with its own Copy, so copying sits in the action pill, as in Files. */
const COPY = new Set<FileViewPreviewKind>(["text", "json"]);

const messages = () => notebookWorkspaceMessages.resolve([document.documentElement.lang]).t;

/** The attachment in the Lightbox, with Copy text for plain text, Save to Files and Download. */
const lightboxItem = (notebookId: string, attachment: PreviewAttachment): LightboxItem => {
  const contentUrl = buildAttachmentContentUrl(notebookId, attachment.id);
  const kind = attachmentPreviewKind(attachment);
  const locale = document.documentElement.lang || "en";
  const t = messages();
  let text: string | undefined;
  const load = async (): Promise<FileViewContent> => {
    const response = await fetch(contentUrl, { credentials: "same-origin" });
    if (!response.ok) throw new Error(t.previewAttachmentFailed);
    const bytes = new Uint8Array(await response.arrayBuffer());
    text = new TextDecoder().decode(bytes);
    // The download response says only octet-stream; the stored type names the file. A table keeps its original bytes,
    // so its encoding setting can still read a Windows-1252 or UTF-16 export.
    return kind === "delimited-text"
      ? { encoding: "base64", content: encoding.toBase64(bytes), mediaType: attachment.mimeType }
      : { encoding: "utf8", content: text, mediaType: attachment.mimeType };
  };
  const actions: LightboxAction[] = [];
  // The PDF also opens on its own address in a new tab, as from the former preview dialog.
  if (kind === "pdf")
    actions.push({
      label: t.openInNewTab,
      icon: "ti ti-external-link",
      onClick: () => void window.open(`${contentUrl}&inline=true`, "_blank", "noopener"),
    });
  if (kind && COPY.has(kind))
    actions.push({
      label: t.copyText,
      icon: "ti ti-copy",
      onClick: () => {
        if (text === undefined) return;
        void navigator.clipboard.writeText(text).then(
          () => toast.success(t.copied),
          () => toast.error(t.previewAttachmentFailed),
        );
      },
    });
  actions.push({
    label: saveFilesLabel(locale),
    icon: SAVE_FILES_ICON,
    onClick: () =>
      void saveFiles([{ name: attachment.filename, content: contentUrl, mediaType: attachment.mimeType, size: attachment.sizeBytes }]),
  });
  return {
    name: attachment.filename,
    meta: `${fileKindLabel({ name: attachment.filename, mediaType: attachment.mimeType }, locale)} · ${formatFileViewSize(attachment.sizeBytes, locale)}`,
    file: { path: attachment.filename, mediaType: attachment.mimeType, size: attachment.sizeBytes },
    // The content endpoint serves a PDF inline only on request.
    src: kind === "image" ? contentUrl : kind === "pdf" ? `${contentUrl}&inline=true` : undefined,
    load: kind && kind !== "image" && kind !== "pdf" ? load : undefined,
    thumbnail: kind === "image" ? contentUrl : undefined,
    downloadUrl: contentUrl,
    actions,
  };
};

/** Shows the attachments in the Lightbox, starting at `index`, until it closes. */
const showLightbox = (notebookId: string, attachments: readonly PreviewAttachment[], index: number): void => {
  const host = document.createElement("div");
  document.body.append(host);
  const items = attachments.map((attachment) => lightboxItem(notebookId, attachment));
  const dispose = render(() => {
    const [shown, setShown] = createSignal(index);
    return (
      <Lightbox
        items={items}
        index={shown()}
        onIndexChange={setShown}
        onClose={() =>
          queueMicrotask(() => {
            dispose();
            host.remove();
          })
        }
      />
    );
  }, host);
};

/**
 * Opens the attachment's preview, or asks to download a file that has none. Given the list it was clicked in, the
 * Lightbox holds every attachment of that list, so the others are one arrow key away.
 */
export const openAttachment = (
  notebookId: string,
  attachment: PreviewAttachment,
  attachments: readonly PreviewAttachment[] = [attachment],
): void => {
  if (!attachmentPreviewKind(attachment)) {
    void confirmAndDownload(attachment.filename, buildAttachmentContentUrl(notebookId, attachment.id));
    return;
  }
  const index = attachments.findIndex((entry) => entry.id === attachment.id);
  if (index < 0) showLightbox(notebookId, [attachment], 0);
  else showLightbox(notebookId, attachments, index);
};

/** The reference lookup still in flight; a newer one replaces it. */
let lookup: AbortController | null = null;

/**
 * Opens an attachment known only by its reference, as in a note. Its stored type and size decide the preview; when
 * they cannot be read, the reference keeps the confirmed download it always had. Only the latest request opens
 * anything, so a double click or a second reference clicked while the first loads opens one preview.
 */
export const openAttachmentById = async (notebookId: string, attachmentId: string, label: string): Promise<void> => {
  lookup?.abort();
  const request = new AbortController();
  lookup = request;
  const response = await apiClient[":id"].attachments[":attId"]
    .$get({ param: { id: notebookId, attId: attachmentId } }, { init: { signal: request.signal } })
    .catch(() => null);
  const attachment = response?.ok ? await response.json().catch(() => null) : null;
  if (request.signal.aborted) return;
  lookup = null;
  if (attachment) openAttachment(notebookId, attachment);
  else void confirmAndDownload(label, buildAttachmentContentUrl(notebookId, attachmentId));
};
