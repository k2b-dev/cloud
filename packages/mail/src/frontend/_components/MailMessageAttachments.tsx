import { fileIcons } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  canPreviewFile,
  dialogCore,
  FileView,
  type FileViewContent,
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
import { createMemo, For, onCleanup, Show } from "solid-js";
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

function MailAttachmentPreviewDialog(props: { attachment: Attachment; downloadHref: string; previewHref: string; close: () => void }) {
  const locale = useLocale();
  const messages = createMemo(() => mailMessageMessages.resolve([locale()]).t);
  const filename = () => props.attachment.filename ?? messages().attachment;
  const load = async (): Promise<FileViewContent> => {
    const response = await fetch(props.previewHref, { credentials: "same-origin" });
    if (!response.ok) throw new Error(await readApiError(response, messages().previewAttachmentFailed));
    return {
      encoding: "utf8",
      content: await response.text(),
      mediaType: response.headers.get("content-type")?.split(";", 1)[0] || props.attachment.contentType,
    };
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={filename()}
        subtitle={`${props.attachment.contentType} · ${formatFileViewSize(props.attachment.sizeBytes)}`}
        icon={`ti ${fileIcons.getFileIcon({
          name: filename(),
          type: "file",
          mimeType: props.attachment.contentType,
        })}`}
        actions={
          <Tooltip.Anchor content={messages().downloadAttachment}>
            <IconButtonLink href={props.downloadHref} download={filename()} label={messages().downloadNamed({ name: filename() })}>
              <i class="ti ti-download" aria-hidden="true" />
              <span class="sr-only">{messages().downloadNamed({ name: filename() })}</span>
            </IconButtonLink>
          </Tooltip.Anchor>
        }
        close={props.close}
      />
      <PanelDialog.Body>
        <FileView
          file={attachmentFile(props.attachment)}
          load={load}
          previewHref={props.previewHref}
          downloadHref={props.downloadHref}
          class="min-h-[24rem]"
        />
      </PanelDialog.Body>
    </PanelDialog>
  );
}

const openAttachmentPreview = (attachment: Attachment, downloadHref: string, previewHref: string) =>
  dialogCore.open<void>(
    (close) => (
      <MailAttachmentPreviewDialog attachment={attachment} downloadHref={downloadHref} previewHref={previewHref} close={() => close()} />
    ),
    panelDialogWorkspaceOptions,
  );

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
    onError: (error) => prompts.error(error.message),
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
      <p class="mb-1.5 text-xs font-medium text-dimmed">{messages().attachments}</p>
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
