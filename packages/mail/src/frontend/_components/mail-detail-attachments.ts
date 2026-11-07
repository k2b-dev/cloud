import type { MailWorkspaceMessage } from "../../service/workspace";
import { attachmentPreviewKind } from "./mail-message-presentation";

type Message = Pick<MailWorkspaceMessage, "id" | "from" | "attachments">;
type Attachment = MailWorkspaceMessage["attachments"][number];

/** One file of a conversation: its first attachment, and every message that carries the same content. */
export type MailDetailFile = {
  key: string;
  attachment: Attachment;
  messageId: string;
  messageIds: string[];
  /** The sender of the first message, when another file with the same name has different content. */
  from: string | null;
};

const sender = (message: Message): string => message.from[0]?.name || message.from[0]?.address || "";

/** An image the panel can show as a thumbnail through the attachment's inline preview route. */
export const isThumbnailImage = (attachment: Pick<Attachment, "contentType" | "sizeBytes">): boolean =>
  attachmentPreviewKind(attachment.contentType, attachment.sizeBytes) === "image";

/** Files before images, each in the order it first appears; the short and the full list share this order. */
export const filesBeforeImages = <T extends { attachment: Attachment }>(files: readonly T[]): T[] => [
  ...files.filter((file) => !isThumbnailImage(file.attachment)),
  ...files.filter((file) => isThumbnailImage(file.attachment)),
];

/**
 * Merges attachments only when their content is equal: the same checksum. The same name with different content
 * stays separate and names its sender. An attachment without a checksum is never merged.
 */
export const mergeMailAttachments = (messages: readonly Message[]): { files: MailDetailFile[]; occurrences: number; merged: number } => {
  const byKey = new Map<string, MailDetailFile>();
  let occurrences = 0;
  for (const message of messages) {
    for (const attachment of message.attachments) {
      occurrences += 1;
      const key = attachment.checksum ? `sha256:${attachment.checksum}` : `${message.id}:${attachment.id}`;
      const known = byKey.get(key);
      if (known) {
        if (!known.messageIds.includes(message.id)) known.messageIds.push(message.id);
        continue;
      }
      byKey.set(key, {
        key,
        attachment,
        messageId: message.id,
        messageIds: [message.id],
        from: null,
      });
    }
  }
  const files = [...byKey.values()];
  const names = new Map<string, number>();
  for (const file of files) {
    const name = file.attachment.filename ?? "";
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const senders = new Map(messages.map((message) => [message.id, sender(message)]));
  for (const file of files) {
    if ((names.get(file.attachment.filename ?? "") ?? 0) > 1) file.from = senders.get(file.messageId) || null;
  }
  return {
    files: filesBeforeImages(files),
    occurrences,
    merged: occurrences - files.length,
  };
};

/** Every message with all of its own attachments, for the "By message" arrangement. */
export const attachmentsByMessage = (messages: readonly Message[]): Array<{ message: Message; files: MailDetailFile[] }> =>
  messages
    .filter((message) => message.attachments.length > 0)
    .map((message) => ({
      message,
      files: filesBeforeImages(
        message.attachments.map((attachment) => ({
          key: `${message.id}:${attachment.id}`,
          attachment,
          messageId: message.id,
          messageIds: [message.id],
          from: null,
        })),
      ),
    }));
