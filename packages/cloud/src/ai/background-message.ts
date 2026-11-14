import type { SQL } from "bun";
import { withAiShortIdForDb } from "./short-id";
import type { AiStoredMessage } from "./types";

/** Runtime hosts call this inside the destination conversation's row lock. */
export const appendAiBackgroundMessage = async (
  db: SQL,
  input: { conversationId: string; text: string; meta?: AiStoredMessage["meta"] },
): Promise<{ id: string; shortId: string }> => {
  const rows = await withAiShortIdForDb(
    db,
    "idx_ai_messages_conversation_short_id",
    (attempt, shortId) => attempt<{ id: string; short_id: string }[]>`
    INSERT INTO ai.messages(short_id, conversation_id, seq, kind, role, message, search_text, meta)
    VALUES (${shortId}, ${input.conversationId}::uuid,
      (SELECT COALESCE(MAX(seq),0)+1 FROM ai.messages WHERE conversation_id=${input.conversationId}::uuid),
      'message', 'assistant', ${JSON.stringify({ role: "assistant", content: [{ type: "text", text: input.text }] })}::text::jsonb,
      ${input.text}, ${input.meta ? JSON.stringify(input.meta) : null}::text::jsonb)
    RETURNING id, short_id
  `,
  );
  await db`UPDATE ai.conversations SET done=NULL, last_used_at=now(), updated_at=now(), background_received_at=now()
    WHERE id=${input.conversationId}::uuid`;
  return { id: rows[0]!.id, shortId: rows[0]!.short_id };
};
