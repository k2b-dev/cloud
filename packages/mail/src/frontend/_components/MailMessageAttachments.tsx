import { SAVE_FILES_ICON, type SaveFileSource, SaveFilesButton, saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  canPreviewFile,
  FileGrid,
  FileTypeIcon,
  type FileViewContent,
  type FileViewPreviewKind,
  fileKindLabel,
  formatFileViewSize,
  getFileViewPreviewKind,
  IconButton,
  IconButtonLink,
  Lightbox,
  type LightboxAction,
  type LightboxItem,
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

/** Plain text, a table and JSON can show no code box with its own Copy, so Copy text sits in the action pill. */
const COPY = new Set<FileViewPreviewKind>(["text", "delimited-text", "json"]);

/**
 * An attachment in the Lightbox, with the actions of the former preview dialog: Copy text for text, Save to Files and
 * Download. A previewable attachment reads from its inline address; any other one shows its facts and Download.
 */
export const attachmentLightboxItem = (attachment: Attachment, downloadHref: string, locale: string): LightboxItem => {
  const messages = mailMessageMessages.resolve([locale]).t;
  const name = attachment.filename ?? messages.attachment;
  const file = attachmentFile(attachment);
  const kind = canPreviewAttachment(attachment) ? getFileViewPreviewKind(file) : null;
  const previewHref = `${downloadHref}?inline=true`;
  let text: string | undefined;
  const load = async (): Promise<FileViewContent> => {
    const response = await fetch(previewHref, { credentials: "same-origin" });
    if (!response.ok) throw new Error(await readApiError(response, messages.previewAttachmentFailed));
    text = await response.text();
    return { encoding: "utf8", content: text, mediaType: response.headers.get("content-type")?.split(";", 1)[0] || attachment.contentType };
  };
  const copy: LightboxAction = {
    label: messages.copyText,
    icon: "ti ti-copy",
    onClick: () => {
      if (text === undefined) return;
      void navigator.clipboard.writeText(text).then(
        () => toast.success(messages.textCopied),
        () => toast.error(messages.textNotCopied),
      );
    },
  };
  const read = kind === "image" || kind === "pdf" || kind === "video" || kind === "audio";
  return {
    name,
    meta: [fileKindLabel({ name, mediaType: attachment.contentType }, locale), formatFileViewSize(attachment.sizeBytes, locale)].join(
      " · ",
    ),
    file,
    src: read ? previewHref : undefined,
    load: kind && !read ? load : undefined,
    thumbnail: kind === "image" ? previewHref : undefined,
    downloadUrl: downloadHref,
    actions: [
      ...(kind && COPY.has(kind) ? [copy] : []),
      {
        label: saveFilesLabel(locale),
        icon: SAVE_FILES_ICON,
        onClick: () => void saveFiles([saveSource(attachment, downloadHref)]),
      },
    ],
  };
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
 * "Show all N", which opens files as rows and images as tiles in place. A click opens the Lightbox with all of them; a
 * format without a preview downloads. Each row carries its own actions.
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
  // The message's attachments in the Lightbox, every one of them, so the arrow keys step through them all.
  const [shown, setShown] = createSignal<number | null>(null);
  const lightboxItems = createMemo(() =>
    props.attachments.map((attachment) => attachmentLightboxItem(attachment, baseUrl(attachment), locale())),
  );
  /** A previewable attachment opens in the Lightbox; any other one downloads at once, as before. */
  const openAttachment = (attachment: Attachment) => {
    if (canPreviewAttachment(attachment)) setShown(Math.max(0, props.attachments.indexOf(attachment)));
    else downloadUrl(baseUrl(attachment), fileName(attachment));
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
      <Show when={shown() !== null && lightboxItems().length > 0}>
        <Lightbox items={lightboxItems()} index={shown() ?? 0} onIndexChange={setShown} onClose={() => setShown(null)} />
      </Show>
    </section>
  );
}
