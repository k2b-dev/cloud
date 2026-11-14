import { encoding, text } from "@k2b/stdlib";
import {
  type FileViewContent,
  type FileViewPreviewKind,
  getFileViewPreviewKind,
  type LightboxAction,
  type LightboxItem,
  type MessageRowAttachment,
} from "@k2b/ui";
import type { chatMessages } from "../messages";
import type { AttachmentView } from "../service/contracts";

type Messages = ReturnType<(typeof chatMessages)["resolve"]>["t"];

/** "PDF · 1.2 MB": what kind of file it is and how large, as the second line of a file. */
export const attachmentDetail = (attachment: AttachmentView, t: Messages, locale: string) => {
  const kind =
    attachment.mimeType === "application/pdf"
      ? t.fileKindPdf
      : attachment.mimeType.startsWith("text/")
        ? t.fileKindText
        : attachment.kind === "image"
          ? t.fileKindImage
          : (/\.([a-z0-9]{1,5})$/i.exec(attachment.name)?.[1]?.toUpperCase() ?? t.fileKindOther);
  return `${kind} · ${text.pprintBytes(attachment.size, { locale, mode: "si" })}`;
};

/** An image with its stored size opens in place; anything else, an image without a size included, is a file. */
export const isShownImage = (attachment: AttachmentView): attachment is AttachmentView & { width: number; height: number } =>
  attachment.kind === "image" && attachment.width !== undefined && attachment.height !== undefined;

/** Every attachment opens in the Lightbox; a file without a preview shows its facts and Download there. */
export const rowAttachments = (
  attachments: readonly AttachmentView[],
  t: Messages,
  locale: string,
  open: (attachment: AttachmentView) => void,
): MessageRowAttachment[] =>
  attachments.map((attachment) =>
    isShownImage(attachment)
      ? {
          kind: "image",
          src: attachment.href,
          alt: attachment.name,
          width: attachment.width,
          height: attachment.height,
          onOpen: () => open(attachment),
        }
      : {
          kind: "file",
          name: attachment.name,
          detail: attachmentDetail(attachment, t, locale),
          mediaType: attachment.mimeType,
          href: attachment.href,
          onOpen: () => open(attachment),
        },
  );

/** Reads a text attachment for the Lightbox; a table keeps its bytes, so its encoding setting can read other exports. */
const readText = async (attachment: AttachmentView, kind: FileViewPreviewKind): Promise<FileViewContent> => {
  const response = await fetch(attachment.href, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return kind === "delimited-text"
    ? { encoding: "base64", content: encoding.toBase64(bytes), mediaType: attachment.mimeType }
    : { encoding: "utf8", content: new TextDecoder().decode(bytes), mediaType: attachment.mimeType };
};

/**
 * A message's attachment in the Lightbox. The browser reads images it shows, PDFs, video and audio from the address;
 * text, Markdown and tables load. Other images, such as an SVG the server only offers as a download, show Download.
 */
export const lightboxItem = (attachment: AttachmentView, t: Messages, locale: string, actions: readonly LightboxAction[]): LightboxItem => {
  const file = { path: attachment.name, mediaType: attachment.mimeType, size: attachment.size };
  const kind = getFileViewPreviewKind(file);
  const read = kind === "pdf" || kind === "video" || kind === "audio" || (kind === "image" && isShownImage(attachment));
  return {
    name: attachment.name,
    meta: attachmentDetail(attachment, t, locale),
    file,
    src: read ? attachment.href : undefined,
    load: kind && !read && kind !== "image" ? () => readText(attachment, kind) : undefined,
    thumbnail: isShownImage(attachment) ? attachment.href : undefined,
    downloadUrl: attachment.href,
    actions,
  };
};
