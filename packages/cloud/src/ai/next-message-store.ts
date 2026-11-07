import { sql } from "../runtime/clients";
import type { AiStoredMessage } from "./types";

/** Separate answer metadata: model history, exports, indexing and notifications never load these columns. */
export const migrateAiNextMessages = async () => {
  await sql`ALTER TABLE ai.messages
    ADD COLUMN IF NOT EXISTS suggested_next_message JSONB,
    ADD COLUMN IF NOT EXISTS suggestion_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`.simple();
  // Context history unions the interactive and background tables with SELECT *.
  // Keep their shapes equal; background runs never write these fields.
  await sql`ALTER TABLE ai.task_messages
    ADD COLUMN IF NOT EXISTS suggested_next_message JSONB,
    ADD COLUMN IF NOT EXISTS suggestion_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`.simple();
  await sql`ALTER TABLE ai.user_prefs ADD COLUMN IF NOT EXISTS suggest_next_message BOOLEAN NOT NULL DEFAULT true`.simple();
};

export const saveAiNextMessage = async (input: { conversationId: string; turnId: string; userId: string; text: string }) => {
  await sql`
    UPDATE ai.messages SET suggested_next_message = ${JSON.stringify({ text: input.text, dismissedAt: null })}::jsonb,
      suggestion_user_id = ${input.userId}::uuid
    WHERE id = (
      SELECT m.id FROM ai.messages m JOIN ai.turns t ON t.id::text = m.loop_id
      WHERE m.conversation_id = ${input.conversationId}::uuid AND m.loop_id = ${input.turnId}
        AND m.role = 'assistant' AND m.kind = 'message' AND m.compacted_at IS NULL
        AND t.status = 'running' AND t.cancel_requested_at IS NULL
        AND t.run_config->'actor'->>'kind' = 'user' AND t.run_config->'actor'->'user'->>'id' = ${input.userId}
        AND NOT EXISTS (SELECT 1 FROM ai.turn_steers WHERE turn_id = t.id AND status <> 'discarded')
        AND NOT EXISTS (SELECT 1 FROM ai.pending_actions WHERE turn_id = t.id AND status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM ai.queued_messages WHERE conversation_id = m.conversation_id AND status IN ('pending','failed'))
      ORDER BY m.seq DESC LIMIT 1
    ) AND suggested_next_message IS NULL
  `;
};

/** Viewer identity comes from the authorized request, never from the conversation owner. */
export const projectAiNextMessages = async (
  messages: AiStoredMessage[],
  conversationId: string,
  viewerUserId?: string | null,
): Promise<AiStoredMessage[]> => {
  if (!viewerUserId || messages.length === 0) return messages.map(({ suggestedNextMessage: _, ...message }) => message);
  const rows = await sql<{ short_id: string; suggested_next_message: NonNullable<AiStoredMessage["suggestedNextMessage"]> }[]>`
    SELECT m.short_id, m.suggested_next_message FROM ai.messages m JOIN ai.turns t ON t.id::text = m.loop_id
    WHERE m.conversation_id = ${conversationId}::uuid AND m.short_id IN ${sql(messages.map((message) => message.shortId))}
      AND m.suggestion_user_id = ${viewerUserId}::uuid AND m.suggested_next_message IS NOT NULL
      AND t.status = 'completed' AND t.cancel_requested_at IS NULL
      AND t.id = (SELECT id FROM ai.turns WHERE conversation_id = m.conversation_id ORDER BY created_at DESC, id DESC LIMIT 1)
      AND m.seq = (SELECT max(seq) FROM ai.messages WHERE conversation_id = m.conversation_id AND kind = 'message')
      AND NOT EXISTS (SELECT 1 FROM ai.turn_steers WHERE turn_id = t.id AND status <> 'discarded')
      AND NOT EXISTS (SELECT 1 FROM ai.pending_actions WHERE turn_id = t.id AND status = 'pending')
      AND NOT EXISTS (SELECT 1 FROM ai.queued_messages WHERE conversation_id = m.conversation_id AND status IN ('pending','failed'))
  `;
  const suggestions = new Map(rows.map((row) => [row.short_id, row.suggested_next_message]));
  return messages.map(({ suggestedNextMessage: _, ...message }) => {
    const suggestion = suggestions.get(message.shortId);
    return suggestion ? { ...message, suggestedNextMessage: suggestion } : message;
  });
};

export const dismissAiNextMessage = async (input: { conversationId: string; messageShortId: string; userId: string }) => {
  const rows = await sql`
    UPDATE ai.messages SET suggested_next_message = jsonb_set(suggested_next_message, '{dismissedAt}',
      COALESCE(NULLIF(suggested_next_message->'dismissedAt', 'null'::jsonb), to_jsonb(now())))
    WHERE conversation_id = ${input.conversationId}::uuid AND short_id = ${input.messageShortId}
      AND suggestion_user_id = ${input.userId}::uuid AND suggested_next_message IS NOT NULL
    RETURNING id
  `;
  return rows.length > 0;
};
