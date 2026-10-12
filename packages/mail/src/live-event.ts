import { isResourceShortId } from "./resource-short-id";

/** A changed conversation's public ID, or null for a mailbox-wide change. */
export type MailLiveEvent = { conversationId: string | null };

export const parseMailLiveEvent = (value: unknown): MailLiveEvent => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("conversationId" in value)) {
    throw new Error("Invalid Mail live event");
  }
  for (const key in value) {
    if (key !== "conversationId") throw new Error("Invalid Mail live event");
  }
  const conversationId = value.conversationId;
  if (conversationId !== null && !isResourceShortId(conversationId)) throw new Error("Invalid Mail live event");
  return { conversationId };
};
