import { type SaveFileSource, SaveFilesButton } from "@k2b/cloud/browser/files";
import { fileIcons } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  CopyButton,
  canPreviewFile,
  dialogCore,
  FileGrid,
  FileTypeIcon,
  FileView,
  type FileViewContent,
  type FileViewPreviewKind,
  Format,
  fileKindLabel,
  formatFileViewSize,
  getFileViewPreviewKind,
  IconButton,
  IconButtonLink,
  PanelDialog,
  panelDialogWorkspaceOptions,
  prompts,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { CreateAttachmentLinkInput, CreatedAttachmentLink } from "../../contracts";
import { readApiError } from "./api-response";
import { promptAttachmentLinkOptions } from "./attachment-link-ui";
import { isThumbnailImage } from "./mail-detail-attachments";
import { mailDetailsMessages } from "./mail-details-messages";
import { mailMessageMessages } from "./mail-message-messages";
import { attachmentPreviewKind } from "./mail-message-presentation";

type Attachment = {
  id: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
};

/** What "Save to Files" reads: the attachment's own download route, with its known size. */
export const saveSource = (attachment: Attachment, downloadHref: string): SaveFileSource => ({
  name: attachment.filename ?? "attachment",
  content: downloadHref,
  mediaType: attachment.contentType,
  size: attachment.sizeBytes,
});

const attachmentFile = (attachment: Attachment) => ({
  path: attachment.filename ?? "attachment",
  mediaType: attachment.contentType,
  size: attachment.sizeBytes,
});

export const canPreviewAttachment = (attachment: Attachment): boolean => {
  const mailKind = attachmentPreviewKind(attachment.contentType, attachment.sizeBytes);
  const file = attachmentFile(attachment);
  if (!mailKind || !canPreviewFile(file)) return false;

  const fileViewKind = getFileViewPreviewKind(file);
  return mailKind === "text"
    ? fileViewKind === "markdown" || fileViewKind === "json" || fileViewKind === "delimited-text" || fileViewKind === "text"
    : fileViewKind === mailKind;
};

/** Documents and text read in a column; tables and media get the wide workspace frame. */
const READING = new Set<FileViewPreviewKind>(["markdown", "text", "json", "audio"]);
/** These take the body's height: media fits the frame, and a table scrolls inside it with its header row in view. */
const STRETCH = new Set<FileViewPreviewKind>(["image", "pdf", "video", "delimited-text"]);

/**
 * The attachment preview follows the Files preview: the document's own title (or the file name), a quiet line with
 * the file facts, the actions in the header, and the content on the dialog surface without a second frame.
 */
function MailAttachmentPreviewDialog(props: {
  attachment: Attachment;
  kind: FileViewPreviewKind | null;
  downloadHref: string;
  previewHref: string;
  close: () => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailMessageMessages.resolve([locale()]).t);
  const filename = () => props.attachment.filename ?? messages().attachment;
  // Undefined until a Markdown attachment shows whether it starts with a heading; every other file is titled by its name.
  const [documentTitle, setDocumentTitle] = createSignal<string | null | undefined>(props.kind === "markdown" ? undefined : null);
  // Plain text, a table's raw view and JSON that does not parse show no code box, so copying moves into the header.
  const [text, setText] = createSignal<string | null>(null);
  const load = async (): Promise<FileViewContent> => {
    const response = await fetch(props.previewHref, { credentials: "same-origin" });
    if (!response.ok) throw new Error(await readApiError(response, messages().previewAttachmentFailed));
    const content = await response.text();
    setText(content);
    return {
      encoding: "utf8",
      content,
      mediaType: response.headers.get("content-type")?.split(";", 1)[0] || props.attachment.contentType,
    };
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
                <span class="mail-attachment-dialog__title-pending" aria-hidden="true" />
              </>
            }
          >
            {documentTitle() ?? filename()}
          </Show>
        }
        subtitle={
          // Held invisibly until the title is known, then shown with it, so nothing visible moves when it arrives.
          <span class="mail-attachment-dialog__facts" data-pending={documentTitle() === undefined ? "" : undefined}>
            <i
              class={`ti ${fileIcons.getFileIcon({ name: filename(), type: "file", mimeType: props.attachment.contentType })}`}
              aria-hidden="true"
            />
            <Show when={documentTitle()}>
              <span class="mail-attachment-dialog__facts-name" title={filename()}>
                {filename()}
              </span>
              <span class="mail-attachment-dialog__facts-separator" aria-hidden="true">
                ·
              </span>
            </Show>
            <Format.Bytes value={props.attachment.sizeBytes} />
          </span>
        }
        actions={
          <>
            <Show when={props.kind === "text" || props.kind === "delimited-text" || props.kind === "json"}>
              <CopyButton size="sm" variant="ghost" text={text() ?? ""} disabled={text() === null} />
            </Show>
            <SaveFilesButton files={() => [saveSource(props.attachment, props.downloadHref)]} />
            <Tooltip.Anchor content={messages().downloadAttachment}>
              <IconButtonLink href={props.downloadHref} download={filename()} label={messages().downloadNamed({ name: filename() })}>
                <i class="ti ti-download" aria-hidden="true" />
                <span class="sr-only">{messages().downloadNamed({ name: filename() })}</span>
              </IconButtonLink>
            </Tooltip.Anchor>
          </>
        }
        close={props.close}
      />
      <PanelDialog.Body>
        <div class="mail-attachment-dialog__content" tabindex="-1">
          <FileView
            variant="plain"
            headingScale="normal"
            file={attachmentFile(props.attachment)}
            load={load}
            previewHref={props.previewHref}
            onDocumentTitle={setDocumentTitle}
          />
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export const openAttachmentPreview = (attachment: Attachment, downloadHref: string, previewHref: string) => {
  const kind = getFileViewPreviewKind(attachmentFile(attachment));
  const classes = [panelDialogWorkspaceOptions.panelClassName, "mail-attachment-dialog"];
  if (kind && READING.has(kind)) classes.push("mail-attachment-dialog--reading");
  if (kind && STRETCH.has(kind)) classes.push("mail-attachment-dialog--stretch");
  return dialogCore.open<void>(
    (close) => (
      <MailAttachmentPreviewDialog
        attachment={attachment}
        kind={kind}
        downloadHref={downloadHref}
        previewHref={previewHref}
        close={() => close()}
      />
    ),
    {
      ...panelDialogWorkspaceOptions,
      panelClassName: classes.join(" "),
      // Reading comes first: focus starts on the content, so arrow keys and Page Down scroll it at once.
      initialFocus: (dialog) => dialog.querySelector<HTMLElement>(".mail-attachment-dialog__content"),
    },
  );
};

/** Starts a download of a file the browser cannot preview. */
export const downloadUrl = (href: string, name: string) => {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
};

/**
 * A message's attachments where it is read: the count, the first few with an image preview or their type icon, and
 * "Show all N", which opens files as rows and images as tiles in place. A click opens the preview; a format without
 * one downloads. Each row carries its own actions.
 */
export default function MailMessageAttachments(props: {
  mailboxId: string;
  messageId: string;
  attachments: Attachment[];
  canShare?: boolean;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailMessageMessages.resolve([locale()]).t);
  const details = createMemo(() => mailDetailsMessages.resolve([locale()]).t);
  let disposed = false;
  const baseUrl = (attachment: Attachment) =>
    `/api/mail/mailboxes/${props.mailboxId}/messages/${props.messageId}/attachments/${attachment.id}`;
  const fileName = (attachment: Attachment) => attachment.filename ?? messages().attachment;
  const openAttachment = (attachment: Attachment) => {
    const href = baseUrl(attachment);
    if (canPreviewAttachment(attachment)) void openAttachmentPreview(attachment, href, `${href}?inline=true`);
    else downloadUrl(href, fileName(attachment));
  };

  const createLink = mutations.create<CreatedAttachmentLink, { attachment: Attachment; input: CreateAttachmentLinkInput }>({
    mutation: async ({ attachment, input }, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"].attachments[":attachmentId"].links.$post(
        {
          param: { mailboxId: props.mailboxId, messageId: props.messageId, attachmentId: attachment.id },
          json: input,
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().createLinkFailed));
      return response.json();
    },
    onSuccess: async ({ url }) => {
      try {
        await navigator.clipboard.writeText(url);
        toast.success(messages().publicLinkCopied);
      } catch {
        await prompts.alert(url, { title: messages().publicAttachmentLink });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  onCleanup(() => {
    disposed = true;
    createLink.abort();
  });

  const shareAttachment = async (attachment: Attachment) => {
    const input = await promptAttachmentLinkOptions(locale());
    if (!disposed && input) createLink.mutate({ attachment, input });
  };

  return (
    <section class="mail-message-attachments" aria-label={messages().attachments} data-mail-message-attachments>
      <div class="mail-message-attachments__head">
        <p class="mail-message-attachments__count">
          <i class="ti ti-paperclip" aria-hidden="true" />
          {messages().attachmentCount({ count: props.attachments.length })}
        </p>
        <Show when={props.attachments.length > 1}>
          <SaveFilesButton
            all
            size="xs"
            variant="ghost"
            files={() => props.attachments.map((attachment) => saveSource(attachment, baseUrl(attachment)))}
          />
        </Show>
      </div>
      <FileGrid
        rows={props.attachments}
        getRowId={(attachment) => attachment.id}
        label={messages().attachments}
        layout="list"
        limit={3}
        actionVisibility="progressive"
        groups={(rows) => [
          { id: "files", label: details().files, rows: rows.filter((attachment) => !isThumbnailImage(attachment)) },
          { id: "images", label: details().images, rows: rows.filter(isThumbnailImage), layout: "tiles" },
        ]}
        renderPreview={(attachment) =>
          isThumbnailImage(attachment) ? (
            <img src={`${baseUrl(attachment)}?inline=true`} alt="" loading="lazy" decoding="async" />
          ) : (
            <FileTypeIcon name={fileName(attachment)} mediaType={attachment.contentType} />
          )
        }
        renderLabel={fileName}
        renderMeta={(attachment) =>
          [
            fileKindLabel({ name: fileName(attachment), mediaType: attachment.contentType }, locale()),
            formatFileViewSize(attachment.sizeBytes, locale()),
          ].join(" · ")
        }
        renderActions={(attachment) => (
          <>
            <Show when={props.canShare}>
              <Tooltip.Anchor content={messages().shareNamed({ name: fileName(attachment) })}>
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={messages().shareNamed({ name: fileName(attachment) })}
                  disabled={createLink.loading()}
                  onClick={() => void shareAttachment(attachment)}
                >
                  <i class={`ti ${createLink.loading() ? "ti-loader-2 animate-spin" : "ti-link"}`} aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
            </Show>
            <Tooltip.Anchor content={messages().downloadNamed({ name: fileName(attachment) })}>
              <IconButtonLink
                size="sm"
                variant="ghost"
                href={baseUrl(attachment)}
                download={fileName(attachment)}
                label={messages().downloadNamed({ name: fileName(attachment) })}
              >
                <i class="ti ti-download" aria-hidden="true" />
              </IconButtonLink>
            </Tooltip.Anchor>
            <SaveFilesButton size="sm" variant="ghost" files={() => [saveSource(attachment, baseUrl(attachment))]} />
          </>
        )}
        onOpen={openAttachment}
      />
    </section>
  );
}
