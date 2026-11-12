import type { sql } from "bun";
import type { DraftDeliveryClass } from "../contracts";

/** All reply creators and F6 share this transaction lock before occupying the reply box. */
export const lockConversationReplyDraft = async (db: typeof sql, conversationId: string) => {
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`mail:reply-draft:${conversationId}`}, 0))`;
  const [existing] = await db<{ id: string; revision: number | string; sender_identity_id: string; delivery_class: DraftDeliveryClass }[]>`
    SELECT id, revision, sender_identity_id, delivery_class FROM mail.drafts
    WHERE conversation_id = ${conversationId}::uuid AND intent <> 'new' AND state IN ('draft', 'scheduled', 'sending')
    FOR UPDATE`;
  return existing ?? null;
};
