import { sql } from "@k2b/cloud";
import { AiChatOriginSchema } from "@k2b/cloud/ai";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";

export const aiChatSendData = z.strictObject({
  id: z.uuid(),
  chatId: z.string(),
  status: z.enum(["queued", "running", "waiting", "done", "failed", "cancelled"]),
  reason: z.string().nullable(),
  origin: AiChatOriginSchema,
});

/** Slice 1 uses the existing queue. A separate automation receipt and capacity belong to slice 2. */
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
    SELECT q.status,q.error,q.origin,
      latest.id AS turn_id,latest.status AS turn_status,latest.error AS turn_error
    FROM ai.queued_messages q LEFT JOIN LATERAL (
      SELECT id,status,error FROM ai.turns WHERE conversation_id=q.conversation_id AND run_config->'send'->>'id'=q.id::text
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) latest ON true WHERE q.id=${id}::uuid AND q.conversation_id=${conversationId}::uuid`;
  if (!entry) return fail(err.notFound("Sent chat message"));
  const origin = AiChatOriginSchema.safeParse(entry.origin);
  if (!origin.success) return fail(err.notFound("Sent chat message"));
  const status: z.infer<typeof aiChatSendData>["status"] =
    entry.status === "cancelled" || entry.turn_status === "aborted"
      ? "cancelled"
      : entry.turn_status === "completed"
        ? "done"
        : entry.turn_status === "waiting_for_action"
          ? "waiting"
          : entry.turn_status === "failed" || entry.status === "failed"
            ? "failed"
            : entry.turn_status === "running"
              ? "running"
              : "queued";
  return ok({ data: { id, chatId, status, reason: entry.turn_error ?? entry.error, origin: origin.data }, turnId: entry.turn_id });
};
