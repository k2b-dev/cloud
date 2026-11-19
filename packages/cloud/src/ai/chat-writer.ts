import type { AccessSubject } from "../server";

export class AiChatWriterDenied extends Error {}

/** Personal chats are owned by a person; an automation's actor grants no access. */
export const assertPersonalChatWriter = (subject: AccessSubject, ownerUserId: string | null): string => {
  if (subject.type !== "user" || subject.userId !== ownerUserId)
    throw new AiChatWriterDenied("Only the owning person's access subject may write this chat.");
  return subject.userId;
};
