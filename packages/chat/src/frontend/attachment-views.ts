import { text } from "@k2b/stdlib";
import type { MessageRowAttachment } from "@k2b/ui";
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

export const rowAttachments = (
  attachments: readonly AttachmentView[],
  t: Messages,
  locale: string,
  openImage: (attachment: AttachmentView) => void,
): MessageRowAttachment[] =>
  attachments.map((attachment) =>
    isShownImage(attachment)
      ? {
          kind: "image",
          src: attachment.href,
          alt: attachment.name,
          width: attachment.width,
          height: attachment.height,
          onOpen: () => openImage(attachment),
        }
      : {
          kind: "file",
          name: attachment.name,
          detail: attachmentDetail(attachment, t, locale),
          mediaType: attachment.mimeType,
          href: attachment.href,
        },
  );
