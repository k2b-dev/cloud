import type { SQL } from "bun";
import { enqueueAutomationChatMessage, type QueuedChatSubmission } from "./message-queue";
import type { AiDraftContentPart } from "./types";

/** Shared durable ai.chat.send admission. Callers check source authority and hold the destination lock.
 * The send receipt, queue entry and any schedule advancement commit in the same transaction. */
export async function enqueueAiChatSend(input: QueuedChatSubmission, content: AiDraftContentPart[], db: SQL): Promise<void> {
  const { send, writerOrigin, turnTrigger, chatId } = input.runConfig;
  if (!send || !writerOrigin || !turnTrigger || !chatId) throw new Error("A chat send requires its server-owned receipt and origin.");
  await enqueueAutomationChatMessage(send.id, input, content, db);
  await db`INSERT INTO ai.chat_send_receipts(id,account_id,operation,key_hash,input_hash,conversation_id,chat_id,origin,turn_trigger,queued_message_id)
    VALUES(${send.id}::uuid,${send.accountId}::uuid,'ai.chat.send',${send.keyHash},${send.requestHash},${input.conversationId}::uuid,${chatId},
      (${JSON.stringify(writerOrigin)}::text)::jsonb,(${JSON.stringify(turnTrigger)}::text)::jsonb,${send.id}::uuid)`;
}
