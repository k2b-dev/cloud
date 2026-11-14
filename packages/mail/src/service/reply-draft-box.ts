import type { sql } from "bun";
import type { DraftDeliveryClass } from "../contracts";
import { draftAdoptionMessages } from "../draft-adoption-messages";

/** All reply creators and F6 share this transaction lock before occupying the reply box. */
export const lockConversationReplyDraft = async (db: typeof sql, conversationId: string) => {
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`mail:reply-draft:${conversationId}`}, 0))`;
  const [existing] = await db<
    { id: string; short_id: string; revision: number | string; sender_identity_id: string; delivery_class: DraftDeliveryClass }[]
  >`
    SELECT id, short_id, revision, sender_identity_id, delivery_class FROM mail.drafts
    WHERE conversation_id = ${conversationId}::uuid AND origin = 'user' AND intent <> 'new' AND state IN ('draft', 'scheduled', 'sending')
    FOR UPDATE`;
  return existing ?? null;
};

export const replyDraftOccupied = (draftId: string) => ({
  code: "DRAFT_REPLY_BOX_OCCUPIED",
  status: 409 as const,
  draftId,
  message: draftAdoptionMessages.resolve(["en"]).t.replyOccupied({ draftId }),
});

export const hasDraftCreationContent = (input: {
  body?: string;
  subject?: string;
  to?: readonly unknown[];
  cc?: readonly unknown[];
  bcc?: readonly unknown[];
  attachments?: readonly unknown[];
  includeSourceAttachments?: boolean;
}): boolean =>
  Boolean(
    input.body ||
      input.subject ||
      input.to?.length ||
      input.cc?.length ||
      input.bcc?.length ||
      input.attachments?.length ||
      input.includeSourceAttachments,
  );
