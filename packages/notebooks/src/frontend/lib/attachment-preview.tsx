/**
 * One way to open a notebook attachment from every place that shows one: the attachments overview, the details
 * panel, a file pill or image in the editor, and a link or image in Book. Images open in the lightbox; PDFs, Markdown,
 * text, JSON and tables open in a preview dialog that follows the Files preview; every other file keeps the confirmed
 * download.
 */
import { SAVE_FILES_ICON, SaveFilesButton, saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
import { encoding, fileIcons } from "@k2b/stdlib";
import {
  CopyButton,
  dialogCore,
  FileView,
  type FileViewContent,
  type FileViewPreviewKind,
  Format,
  getFileViewPreviewKind,
  IconButtonLink,
  Lightbox,
  PanelDialog,
  PdfPreview,
  panelDialogWorkspaceOptions,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { apiClient } from "@/api/client";
import { notebookWorkspaceMessages } from "../[id]/messages";
import { buildAttachmentContentUrl, confirmAndDownload } from "./editor/attachment-url";

export type PreviewAttachment = { id: string; filename: string; mimeType: string; sizeBytes: number };

/**
 * How a click shows this attachment, or null when it downloads instead. The content endpoint serves images other
 * than SVG and PDFs inline, which the lightbox and a new tab need. It serves audio and video only as downloads, so they
 * keep the download.
 */
export const attachmentPreviewKind = (attachment: PreviewAttachment): FileViewPreviewKind | null => {
  const kind = getFileViewPreviewKind({ path: attachment.filename, mediaType: attachment.mimeType, size: attachment.sizeBytes });
  if (kind === "image") return attachment.mimeType.startsWith("image/") && attachment.mimeType !== "image/svg+xml" ? kind : null;
  if (kind === "pdf") return attachment.mimeType === "application/pdf" ? kind : null;
  return kind === "audio" || kind === "video" ? null : kind;
};

/** Shows one image in the shared lightbox, captioned with its name, with download and "Save to Files" actions. */
const openAttachmentImage = (src: string, name: string): void => {
  const host = document.createElement("div");
  document.body.append(host);
  const save = () => void saveFiles([{ name, content: src }]);
  const dispose = render(
    () => (
      <Lightbox
        images={[
          {
            src,
            alt: name,
            downloadUrl: src,
            actions: [{ label: saveFilesLabel(useLocale()()), icon: SAVE_FILES_ICON, onClick: save }],
          },
        ]}
        onClose={() =>
          queueMicrotask(() => {
            dispose();
            host.remove();
          })
        }
      />
    ),
    host,
  );
};

/** Opens the attachment's preview, or asks to download a file that has none. */
export const openAttachment = (notebookId: string, attachment: PreviewAttachment): void => {
  const contentUrl = buildAttachmentContentUrl(notebookId, attachment.id);
  const kind = attachmentPreviewKind(attachment);
  if (kind === "image") openAttachmentImage(contentUrl, attachment.filename);
  else if (kind) openAttachmentDialog(attachment, kind, contentUrl);
  else void confirmAndDownload(attachment.filename, contentUrl);
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

/**
 * Opens an attachment a note shows as an image. One the browser has shown opens in the lightbox at once; one it could
 * not show, such as an SVG the content endpoint serves only as a download or a PDF written with image syntax, reads
 * its stored type first like a file reference.
 */
export const openAttachedImage = (image: HTMLImageElement, notebookId: string, attachmentId: string, label: string): void => {
  if (image.complete && image.naturalWidth > 0) openAttachmentImage(buildAttachmentContentUrl(notebookId, attachmentId), label);
  else void openAttachmentById(notebookId, attachmentId, label || "image");
};

/** Documents and text read in a column; PDFs and tables get the wide workspace frame. */
const READING = new Set<FileViewPreviewKind>(["markdown", "text", "json"]);
/** These take the body's height: a PDF fills the frame, and a table scrolls inside it with its header row in view. */
const STRETCH = new Set<FileViewPreviewKind>(["pdf", "delimited-text"]);
/**
 * Plain text and JSON show no code box with its own Copy, so copying sits in the header. A table offers none: its
 * encoding setting can read the file differently from the text the header would copy, as in the Files preview.
 */
const COPY = new Set<FileViewPreviewKind>(["text", "json"]);

const openAttachmentDialog = (attachment: PreviewAttachment, kind: FileViewPreviewKind, contentUrl: string) => {
  const classes = [panelDialogWorkspaceOptions.panelClassName, "notebooks-attachment-dialog"];
  if (READING.has(kind)) classes.push("notebooks-attachment-dialog--reading");
  if (STRETCH.has(kind)) classes.push("notebooks-attachment-dialog--stretch");
  return dialogCore.open<void>(
    (close) => <AttachmentPreviewDialog attachment={attachment} kind={kind} contentUrl={contentUrl} close={() => close()} />,
    {
      ...panelDialogWorkspaceOptions,
      panelClassName: classes.join(" "),
      // Reading comes first: focus starts on the content, so arrow keys and Page Down scroll it at once.
      initialFocus: (dialog) => dialog.querySelector<HTMLElement>(".notebooks-attachment-dialog__content"),
    },
  );
};

/**
 * Follows the Files preview: the document's own title (or the file name), a quiet line with the file facts, the
 * actions in the header, and the content on the dialog surface without a second frame.
 */
function AttachmentPreviewDialog(props: {
  attachment: PreviewAttachment;
  kind: FileViewPreviewKind;
  contentUrl: string;
  close: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => notebookWorkspaceMessages.resolve([locale()]).t);
  const filename = () => props.attachment.filename;
  // The content endpoint serves a PDF inline only on request; that address also opens it in a new tab.
  const inlineUrl = () => `${props.contentUrl}&inline=true`;
  // Undefined until a Markdown file shows whether it starts with a heading; every other file is titled by its name.
  const [documentTitle, setDocumentTitle] = createSignal<string | null | undefined>(props.kind === "markdown" ? undefined : null);
  const [text, setText] = createSignal<string | null>(null);
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const read = async (url: string): Promise<Response> => {
    const response = await fetch(url, { credentials: "same-origin", signal: abort.signal });
    if (!response.ok) throw new Error(t().previewAttachmentFailed);
    return response;
  };
  const load = async (): Promise<FileViewContent> => {
    const bytes = new Uint8Array(await (await read(props.contentUrl)).arrayBuffer());
    const content = new TextDecoder().decode(bytes);
    setText(content);
    // The download response says only octet-stream; the stored type names the file. A table keeps its original bytes,
    // so its encoding setting can still read a Windows-1252 or UTF-16 export.
    return props.kind === "delimited-text"
      ? { encoding: "base64", content: encoding.toBase64(bytes), mediaType: props.attachment.mimeType }
      : { encoding: "utf8", content, mediaType: props.attachment.mimeType };
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={
          <Show
            when={documentTitle() !== undefined}
            fallback={
              <>
                <span class="k2b-sr-only">{filename()}</span>
                <span class="notebooks-attachment-dialog__title-pending" aria-hidden="true" />
              </>
            }
          >
            {documentTitle() ?? filename()}
          </Show>
        }
        subtitle={
          // Held invisibly until the title is known, then shown with it, so nothing visible moves when it arrives.
          <span class="notebooks-attachment-dialog__facts" data-pending={documentTitle() === undefined ? "" : undefined}>
            <i
              class={`ti ${fileIcons.getFileIcon({ name: filename(), type: "file", mimeType: props.attachment.mimeType })}`}
              aria-hidden="true"
            />
            <Show when={documentTitle()}>
              <span class="notebooks-attachment-dialog__facts-name" title={filename()}>
                {filename()}
              </span>
              <span aria-hidden="true">·</span>
            </Show>
            <Format.Bytes value={props.attachment.sizeBytes} />
          </span>
        }
        actions={
          <>
            <Show when={COPY.has(props.kind)}>
              <CopyButton size="sm" variant="ghost" text={text() ?? ""} disabled={text() === null} />
            </Show>
            {/* Safari on iOS shows only the first page of an embedded PDF; the new tab shows the whole document. */}
            <Show when={props.kind === "pdf"}>
              <IconButtonLink size="sm" label={t().openInNewTab} href={inlineUrl()} target="_blank" rel="noopener">
                <i class="ti ti-external-link" aria-hidden="true" />
              </IconButtonLink>
            </Show>
            <SaveFilesButton
              size="sm"
              files={() => [
                { name: filename(), content: props.contentUrl, mediaType: props.attachment.mimeType, size: props.attachment.sizeBytes },
              ]}
            />
            <IconButtonLink size="sm" label={t().download} href={props.contentUrl} download={filename()}>
              <i class="ti ti-download" aria-hidden="true" />
            </IconButtonLink>
          </>
        }
        close={props.close}
      />
      <PanelDialog.Body>
        <div class="notebooks-attachment-dialog__content" tabindex="-1">
          <Show
            when={props.kind === "pdf"}
            fallback={
              <FileView
                variant="plain"
                headingScale="normal"
                file={{ path: filename(), mediaType: props.attachment.mimeType, size: props.attachment.sizeBytes }}
                load={load}
                onDocumentTitle={setDocumentTitle}
              />
            }
          >
            {/* The header owns the viewer actions, so the preview is only the document. */}
            <PdfPreview autoLoad title={filename()} buttonLabel={t().retry} request={() => read(inlineUrl())}>
              {(parts) => <div class="notebooks-attachment-dialog__pdf">{parts.content}</div>}
            </PdfPreview>
          </Show>
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}
