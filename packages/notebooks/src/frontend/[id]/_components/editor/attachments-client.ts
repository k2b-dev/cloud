/**
 * Attachment upload + insertion helpers — single entry point for every
 * upload trigger (drag-drop, paste, slash-command modal, footer button).
 *
 * Browser-only. Uses the typed notebooks API client (same-origin via gateway).
 */

import type { EditorView } from "@codemirror/view";
import { images } from "@k2b/stdlib/browser";
import { apiClient } from "../../../../api/client";

// =============================================================================
// Auto-shrink oversize images
// =============================================================================

/** Frontend mirror of the API's `MAX_ATTACHMENT_SIZE`. If the admin
 *  raises the server-side limit, frontend stays conservative — never
 *  causes an upload failure, only triggers shrinking on files the
 *  server would have accepted anyway. If admin lowers it, frontend
 *  may attempt uploads that the server rejects (clear error path). */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

/** Longest-side cap when an oversize image is shrunk before upload.
 *  2048 covers most "looks-fine-on-retina" use cases for body images;
 *  much larger and we're storing wasted pixels. */
export const MAX_IMAGE_DIMENSION_PX = 2048;

const IMAGE_MIME_RE = /^image\/(jpe?g|png|webp|gif|avif|heic|heif|bmp)$/i;

const isImageFile = (file: File): boolean => IMAGE_MIME_RE.test(file.type);

/** Attempt to bring an oversize image under `MAX_ATTACHMENT_SIZE_BYTES`
 *  by scaling its longer side to `MAX_IMAGE_DIMENSION_PX` and re-encoding.
 *
 *  Returns `null` when no shrinking happened (small enough already, or
 *  not an image, or the resize pipeline errored). Caller uploads the
 *  original in that case — for non-image oversize files this surfaces
 *  the same "file too large" server error as before.
 *
 *  Format policy: PNG inputs stay PNG (preserves transparency, even
 *  though it's bigger). Everything else becomes WebP — well supported
 *  by all modern browsers, smaller than JPEG at equal quality. GIF
 *  loses animation, accepted tradeoff since >10MB GIFs are rare.
 *  Aspect ratio is always preserved (only one dimension passed to
 *  `images.resize`; the other is computed from the source ratio). */
export const maybeShrinkOversizeImage = async (file: File): Promise<File | null> => {
  if (file.size <= MAX_ATTACHMENT_SIZE_BYTES) return null;
  if (!isImageFile(file)) return null;
  try {
    const data = await images.create(file);
    const longerIsWidth = data.width >= data.height;
    const transform = longerIsWidth ? images.resize(MAX_IMAGE_DIMENSION_PX) : images.resize(undefined, MAX_IMAGE_DIMENSION_PX);
    const isPng = /png/i.test(file.type);
    const fmt: "png" | "webp" = isPng ? "png" : "webp";
    const baseName = file.name.replace(/\.[^.]+$/, "");
    return await transform(data).then(images.toFile(`${baseName}.${fmt}`, fmt, 0.85));
  } catch {
    // Decode / canvas tainting / encoder failure — fall back to
    // uploading the original. Server will reject if oversize; user
    // gets the same error message they would have seen pre-shrink.
    return null;
  }
};

// Re-exports — single import surface for components that want both upload
// flow and the click-to-download confirm. Underlying helpers live in
// `lib/editor/attachment-url.ts` (browser-safe, no editor deps).
export {
  buildAttachmentContentUrl,
  confirmAndDownload,
  extractAttachmentId,
  extractAttachmentIds,
} from "../../../lib/editor/attachment-url";

import { formatBytes as sharedFormatBytes } from "@k2b/cloud/shared";

export type AttachmentRef = {
  id: string;
  kind: "image" | "file";
  filename: string;
};

export type Attachment = AttachmentRef & {
  notebookId: string;
  mimeType: string;
  sizeBytes: number;
  createdBy: string | null;
  createdAt: string;
};

/** POST a file to the notebooks API. Throws on non-2xx with the server message. */
export const uploadFile = async (notebookId: string, file: File, signal?: AbortSignal): Promise<Attachment> => {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiClient[":id"].attachments.$post({ param: { id: notebookId } }, { init: { body: fd, signal } });
  if (!res.ok) {
    const msg = await res
      .json()
      .then((d: { message?: string }) => d?.message)
      .catch(() => null);
    throw new Error(msg ?? `Upload failed (${res.status})`);
  }
  return await res.json();
};

/** Human-readable file size — used by picker, detail panel, overview. */
/** Markdown form for inserting an attachment reference. Image vs file.
 *  Uses the short-id `attach://` scheme — see `service/attachments.ts`
 *  for why we picked `attach://` over `file://`. */
export const attachmentMarkdown = (att: AttachmentRef): string =>
  att.kind === "image" ? `![${att.filename}](attach://${att.id})` : `[${att.filename}](attach://${att.id})`;

/**
 * Insert an attachment reference at the current cursor position. Images
 * get padded with newlines so they land on their own line — non-image
 * pills go inline.
 */
export const insertAttachment = (view: EditorView, att: AttachmentRef): void => {
  const md = attachmentMarkdown(att);
  const { from, to } = view.state.selection.main;
  let text = md;
  if (att.kind === "image") {
    const lineStart = view.state.doc.lineAt(from).from;
    const before = view.state.sliceDoc(lineStart, from);
    const after = view.state.sliceDoc(from, view.state.doc.lineAt(from).to);
    if (before.trim().length > 0) text = `\n\n${text}`;
    if (after.trim().length > 0) text = `${text}\n`;
  }
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  view.focus();
};

/** Upload a file and insert its reference at the cursor in one go. */
export const uploadAndInsert = async (view: EditorView, notebookId: string, file: File): Promise<void> => {
  const att = await uploadFile(notebookId, file);
  insertAttachment(view, att);
};

/** Re-exported for existing callers; the implementation is shared. */
export const formatBytes = (bytes: number): string => sharedFormatBytes(bytes);
