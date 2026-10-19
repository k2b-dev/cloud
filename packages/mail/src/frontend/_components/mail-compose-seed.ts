import type { MailAddress } from "../../contracts";

/** What a new message starts with: empty from the mailbox, or the fields of a mailto link. */
export type MailComposeSeedIntent = { to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; subject: string; body: string };

const EMPTY_INTENT: MailComposeSeedIntent = { to: [], cc: [], bcc: [], subject: "", body: "" };

/**
 * The draft-seeds request body for a new message. The compose page and the mailbox's Compose both send it, so a
 * message started from either place begins the same.
 */
export const mailComposeDraftSeedInput = (senderIdentityId: string, intent: MailComposeSeedIntent = EMPTY_INTENT) => ({
  origin: {
    kind: "compose" as const,
    input: {
      senderIdentityId,
      to: intent.to,
      cc: intent.cc,
      bcc: intent.bcc,
      subject: intent.subject,
      body: intent.body,
      ...(intent.body ? { format: "plain" as const } : {}),
      intent: "new" as const,
      conversationId: null,
      sourceMessageId: null,
      includeSourceAttachments: false,
    },
  },
});
