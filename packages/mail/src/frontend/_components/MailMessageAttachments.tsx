import { type SaveFileSource, SaveFilesButton } from "@k2b/cloud/browser/files";
import { fileIcons } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CopyButton,
  canPreviewFile,
  dialogCore,
  FileView,
  type FileViewContent,
  type FileViewPreviewKind,
  Format,
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
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { CreateAttachmentLinkInput, CreatedAttachmentLink } from "../../contracts";
import { readApiError } from "./api-response";
import { promptAttachmentLinkOptions } from "./attachment-link-ui";
import { mailMessageMessages } from "./mail-message-messages";
import { attachmentPreviewKind } from "./mail-message-presentation";

type Attachment = {
  id: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
};

/** What "Save to Files" reads: the attachment's own download route, with its known size. */
const saveSource = (attachment: Attachment, downloadHref: string): SaveFileSource => ({
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

const canPreviewAttachment = (attachment: Attachment): boolean => {
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

const openAttachmentPreview = (attachment: Attachment, downloadHref: string, previewHref: string) => {
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

export default function MailMessageAttachments(props: {
  mailboxId: string;
  messageId: string;
  attachments: Attachment[];
  canShare?: boolean;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailMessageMessages.resolve([locale()]).t);
  let disposed = false;
  const baseUrl = (attachment: Attachment) =>
    `/api/mail/mailboxes/${props.mailboxId}/messages/${props.messageId}/attachments/${attachment.id}`;

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
    <div class="mt-4">
      <div class="mb-1.5 flex items-center justify-between gap-2 pr-2">
        <p class="text-xs font-medium text-dimmed">{messages().attachments}</p>
        <Show when={props.attachments.length > 1}>
          <SaveFilesButton
            all
            size="xs"
            class="text-sm"
            files={() => props.attachments.map((attachment) => saveSource(attachment, baseUrl(attachment)))}
          />
        </Show>
      </div>
      <div class="flex flex-col gap-1.5">
        <For each={props.attachments}>
          {(attachment) => {
            const downloadHref = baseUrl(attachment);
            const previewHref = `${downloadHref}?inline=true`;
            return (
              <div class="flex min-h-8 min-w-0 items-center gap-1.5 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-0.5">
                <i class="ti ti-paperclip shrink-0 text-sm text-dimmed" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-primary">
                  {attachment.filename ?? attachment.contentType}
                </span>
                <span class="shrink-0 text-xs text-dimmed">{formatFileViewSize(attachment.sizeBytes)}</span>
                <Show when={canPreviewAttachment(attachment)}>
                  <Button
                    variant="ghost"
                    type="button"
                    class="mail-attachment-preview"
                    onClick={() => void openAttachmentPreview(attachment, downloadHref, previewHref)}
                  >
                    <i class="ti ti-eye" aria-hidden="true" />
                    {messages().preview}
                  </Button>
                </Show>
                <Show when={props.canShare}>
                  <IconButton
                    type="button"
                    class="!h-7 !w-7 !p-0 text-sm"
                    label={messages().shareNamed({ name: attachment.filename ?? messages().attachment.toLowerCase() })}
                    disabled={createLink.loading()}
                    onClick={() => void shareAttachment(attachment)}
                  >
                    <i class={`ti ${createLink.loading() ? "ti-loader-2 animate-spin" : "ti-link"}`} aria-hidden="true" />
                  </IconButton>
                </Show>
                <SaveFilesButton class="!h-7 !w-7 !p-0 text-sm" files={() => [saveSource(attachment, downloadHref)]} />
                <IconButtonLink
                  class="!h-7 !w-7 !p-0 text-sm"
                  href={downloadHref}
                  label={messages().downloadNamed({ name: attachment.filename ?? messages().attachment.toLowerCase() })}
                >
                  <i class="ti ti-download" aria-hidden="true" />
                  <span class="sr-only">
                    {messages().downloadNamed({ name: attachment.filename ?? messages().attachment.toLowerCase() })}
                  </span>
                </IconButtonLink>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
