import { SAVE_FILES_ICON, type SaveFileSource, SaveFilesButton, saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  canPreviewFile,
  Dropdown,
  type DropdownItem,
  FileTypeIcon,
  type FileViewContent,
  type FileViewPreviewKind,
  fileKindLabel,
  formatFileViewSize,
  getFileViewPreviewKind,
  Lightbox,
  type LightboxAction,
  type LightboxItem,
  prompts,
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
import { mailReaderMessages } from "./mail-reader-messages";

export type MailAttachment = {
  id: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
};
type Attachment = MailAttachment;

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
 * A message's attachments as tiles inside the open message (Mail v5): an icon by type, the name, and the kind with
 * its size. A click opens the attachment, in the conversation's Lightbox when the reader passes `onOpen`; a format
 * without a preview downloads. Each tile's "…" downloads, saves to Files, or shares a link; from two attachments on,
 * "Download all n" packs them into one ZIP.
 */
export default function MailMessageAttachments(props: {
  mailboxId: string;
  messageId: string;
  attachments: Attachment[];
  canShare?: boolean;
  /** The name of the ZIP with all attachments, such as the conversation's subject. */
  archiveName?: string;
  /** Opens a previewable attachment in the conversation's Lightbox; without it, the message's own Lightbox opens. */
  onOpen?: (attachment: Attachment) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailMessageMessages.resolve([locale()]).t);
  const reader = createMemo(() => mailReaderMessages.resolve([locale()]).t);
  let disposed = false;
  const baseUrl = (attachment: Attachment) =>
    `/api/mail/mailboxes/${props.mailboxId}/messages/${props.messageId}/attachments/${attachment.id}`;
  const fileName = (attachment: Attachment) => attachment.filename ?? messages().attachment;
  const meta = (attachment: Attachment) =>
    [
      fileKindLabel({ name: fileName(attachment), mediaType: attachment.contentType }, locale()),
      formatFileViewSize(attachment.sizeBytes, locale()),
    ].join(" · ");
  // Without a conversation Lightbox, the message's attachments open in their own, so the arrow keys step through them.
  const [shown, setShown] = createSignal<number | null>(null);
  const lightboxItems = createMemo(() =>
    props.attachments.map((attachment) => attachmentLightboxItem(attachment, baseUrl(attachment), locale())),
  );
  /** A previewable attachment opens in the Lightbox; any other one downloads at once, as before. */
  const openAttachment = (attachment: Attachment) => {
    if (!canPreviewAttachment(attachment)) return downloadUrl(baseUrl(attachment), fileName(attachment));
    if (props.onOpen) return props.onOpen(attachment);
    setShown(Math.max(0, props.attachments.indexOf(attachment)));
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
  // Packing belongs to this message: closing it stops the fetches.
  const [packing, setPacking] = createSignal(false);
  let packingAbort: AbortController | undefined;
  onCleanup(() => {
    disposed = true;
    createLink.abort();
    packingAbort?.abort();
  });

  const shareAttachment = async (attachment: Attachment) => {
    const input = await promptAttachmentLinkOptions(locale());
    if (!disposed && input) createLink.mutate({ attachment, input });
  };
  const downloadAll = async () => {
    if (packing()) return;
    const controller = new AbortController();
    packingAbort = controller;
    setPacking(true);
    const files = props.attachments.map((attachment) => ({
      name: fileName(attachment),
      href: baseUrl(attachment),
      size: attachment.sizeBytes,
    }));
    try {
      const zip = await importOnDemand(() => import("./mail-attachments-zip"));
      if (!zip || controller.signal.aborted) return;
      await zip.downloadMailAttachments(files, `${props.archiveName?.trim() || messages().attachments}.zip`, controller.signal);
    } catch {
      if (!controller.signal.aborted) toast.error(reader().downloadAllFailed);
    } finally {
      if (packingAbort === controller) {
        packingAbort = undefined;
        setPacking(false);
      }
    }
  };
  const tileMenu = (attachment: Attachment): DropdownItem[] => [
    { label: reader().download, icon: "ti ti-download", href: baseUrl(attachment) },
    {
      label: saveFilesLabel(locale()),
      icon: SAVE_FILES_ICON,
      action: () => void saveFiles([saveSource(attachment, baseUrl(attachment))]),
    },
    ...(props.canShare
      ? [
          {
            label: messages().shareNamed({ name: fileName(attachment) }),
            icon: "ti ti-link",
            disabled: createLink.loading(),
            action: () => void shareAttachment(attachment),
          },
        ]
      : []),
  ];

  return (
    <section
      class="mail-attachment-tiles"
      aria-label={reader().attachmentCount({ count: props.attachments.length })}
      data-mail-message-attachments
    >
      <ul class="mail-attachment-tiles__list">
        <For each={props.attachments}>
          {(attachment) => (
            <li class="mail-attachment-tile" data-mail-attachment={attachment.id}>
              <button
                type="button"
                class="mail-attachment-tile__open"
                aria-label={`${reader().openAttachment({ name: fileName(attachment) })}, ${meta(attachment)}`}
                onClick={() => openAttachment(attachment)}
              >
                <span class="mail-attachment-tile__icon" aria-hidden="true">
                  <FileTypeIcon name={fileName(attachment)} mediaType={attachment.contentType} />
                </span>
                <span class="mail-attachment-tile__text">
                  <span class="mail-attachment-tile__name" title={fileName(attachment)}>
                    {fileName(attachment)}
                  </span>
                  <span class="mail-attachment-tile__meta">{meta(attachment)}</span>
                </span>
              </button>
              <Dropdown.Root position="bottom-left" width="15rem" items={tileMenu(attachment)}>
                <Dropdown.Trigger
                  iconOnly
                  size="xs"
                  type="button"
                  variant="ghost"
                  class="mail-attachment-tile__menu"
                  label={reader().attachmentActions({ name: fileName(attachment) })}
                >
                  <i class="ti ti-dots" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </li>
          )}
        </For>
        <Show when={props.attachments.length > 1}>
          <li class="mail-attachment-tiles__all">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              loading={packing()}
              loadingLabel={reader().downloadingAll}
              data-mail-download-all
              onClick={() => void downloadAll()}
            >
              <i class="ti ti-download" aria-hidden="true" />
              {reader().downloadAll({ count: props.attachments.length })}
            </Button>
            <SaveFilesButton
              all
              size="sm"
              variant="ghost"
              files={() => props.attachments.map((attachment) => saveSource(attachment, baseUrl(attachment)))}
            />
          </li>
        </Show>
      </ul>
      <Show when={shown() !== null && lightboxItems().length > 0}>
        <Lightbox items={lightboxItems()} index={shown() ?? 0} onIndexChange={setShown} onClose={() => setShown(null)} />
      </Show>
    </section>
  );
}
