import { sql } from "@k2b/cloud";
import { AiChatOriginSchema } from "@k2b/cloud/ai";
import { isAiQueueRetryableError } from "@k2b/cloud/ai/runtime";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";

export const aiChatSendData = z.strictObject({
  id: z.uuid(),
  chatId: z.string(),
  status: z.enum(["queued", "running", "waiting", "done", "failed", "cancelled"]),
  reason: z.string().nullable(),
  origin: AiChatOriginSchema,
});

/** Immutable admission is independent of mutable queue payloads and the current chat binding. */
export const chatSendSnapshot = async (conversationId: string, chatId: string, id: string) => {
  const [entry] = await sql<
    {
      status: string;
      error: string | null;
      origin: unknown;
      turn_id: string | null;
      turn_status: string | null;
      turn_error: string | null;
    }[]
  >`
    SELECT COALESCE(q.status,'cancelled') AS status,q.error,r.origin,
      latest.id AS turn_id,latest.status AS turn_status,latest.error AS turn_error
    FROM ai.chat_send_receipts r LEFT JOIN ai.queued_messages q ON q.id=r.queued_message_id
    LEFT JOIN LATERAL (
      SELECT id,status,error FROM ai.turns WHERE conversation_id=r.conversation_id AND run_config->'send'->>'id'=r.id::text
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) latest ON true WHERE r.id=${id}::uuid AND r.conversation_id=${conversationId}::uuid`;
  if (!entry) return fail(err.notFound("Sent chat message"));
  const origin = AiChatOriginSchema.safeParse(entry.origin);
  if (!origin.success) return fail(err.notFound("Sent chat message"));
  const status: z.infer<typeof aiChatSendData>["status"] =
    entry.status === "cancelled" || entry.turn_status === "aborted" || (entry.status === "submitted" && !entry.turn_id)
      ? "cancelled"
      : entry.turn_status === "completed"
        ? "done"
        : entry.turn_status === "waiting_for_action"
          ? "waiting"
          : entry.turn_status === "failed" ||
              (entry.status === "failed" && (origin.data.kind !== "person" || !isAiQueueRetryableError(entry.error)))
            ? "failed"
            : entry.turn_status === "running"
              ? "running"
              : "queued";
  return ok({ data: { id, chatId, status, reason: entry.turn_error ?? entry.error, origin: origin.data }, turnId: entry.turn_id });
};
