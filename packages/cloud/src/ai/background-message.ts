import type { SQL } from "bun";
import { createAiShortId, withAiShortIdForDb } from "./short-id";
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

/** Set-based background delivery. Caller holds every destination row lock and supplies only free chats. */
export async function appendAiBackgroundMessages(
  db: SQL,
  inputs: readonly { key: string; conversationId: string; text: string; meta: AiStoredMessage["meta"] }[],
): Promise<{ key: string; id: string }[]> {
  if (!inputs.length) return [];
  const messages = inputs.map((input, ordinal) => ({ ...input, ordinal, id: crypto.randomUUID() }));
  await withAiShortIdForDb(db, "idx_ai_messages_conversation_short_id", async (attempt) => {
    const rows = messages.map((input) => ({ ...input, shortId: createAiShortId() }));
    await attempt`WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb)
        AS i(id uuid, "shortId" text, "conversationId" uuid, text text, meta jsonb, ordinal int)
    ), inserted AS (
      INSERT INTO ai.messages(id,short_id,conversation_id,seq,kind,role,message,search_text,meta)
      SELECT i.id,i."shortId",i."conversationId",
        COALESCE((SELECT max(m.seq) FROM ai.messages m WHERE m.conversation_id=i."conversationId"),0)
          + row_number() OVER (PARTITION BY i."conversationId" ORDER BY i.ordinal),
        'message','assistant',jsonb_build_object('role','assistant','content',jsonb_build_array(jsonb_build_object('type','text','text',i.text))),
        i.text,i.meta FROM input i RETURNING conversation_id
    ) UPDATE ai.conversations SET done=NULL,last_used_at=now(),updated_at=now(),background_received_at=now()
      WHERE id IN (SELECT conversation_id FROM inserted)`;
  });
  return messages.map(({ key, id }) => ({ key, id }));
}
