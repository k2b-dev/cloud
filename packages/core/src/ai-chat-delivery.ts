import { sql } from "@k2b/cloud";
import { AI_SHORT_ID_PATTERN } from "@k2b/cloud/ai";
import { appendAiBackgroundMessage } from "@k2b/cloud/ai/runtime";
import { type CapabilityExecutionContext, CapabilityIdempotencyKeySchema, capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { codeChatDestination, ownedCodeRunChat, personalCodeRun } from "./ai-code-chat";

// Match the existing inter-chat message budget, comfortably below the capability envelope.
export const aiChatDeliveryInput = z.strictObject({
  text: z.string().trim().min(1).max(10_000).describe("Result text to append to your own chat; at most 10,000 characters."),
});
/** Core's capability boundary: the delegated Code owner and destination owner must be the same person. */
export const aiChatDeliveryAction = {
  target: "ai.chat",
  title: "Deliver a Code result to your chat",
  description: "Append a result to a personal Code owner's own Assistant chat and notify its owner, without starting an AI turn.",
  input: aiChatDeliveryInput,
  data: z.strictObject({
    id: z.string().regex(AI_SHORT_ID_PATTERN),
    status: z.literal("delivered"),
    targetChatId: z.string().regex(AI_SHORT_ID_PATTERN),
  }),
  destructive: false,
  openWorld: false,
  idempotency: "required" as const,
  policy: { silent: "you" as const },
  async review(_input: z.infer<typeof aiChatDeliveryInput>, context: CapabilityExecutionContext) {
    const run = personalCodeRun(context);
    if (!run) return fail(err.forbidden("Chat delivery requires personal Code"));
    const chat = await ownedCodeRunChat(context, sql);
    if (!chat) return fail(err.notFound("Chat"));
    const de = context.locale.split("-")[0] === "de";
    return ok({
      locale: context.locale,
      sentence: {
        action: de ? "Ergebnis in {chat} ablegen" : "Deliver a result to {chat}",
        running: de ? "Ergebnis wird in {chat} abgelegt" : "Delivering a result to {chat}",
        done: de ? "Ergebnis in {chat} abgelegt" : "Delivered a result to {chat}",
        confirm: de ? "Ablegen" : "Deliver",
        decline: de ? "Abbrechen" : "Cancel",
      },
      slots: { chat: { kind: "object" as const, title: chat.title } },
    });
  },
  async run(input: z.infer<typeof aiChatDeliveryInput>, context: CapabilityExecutionContext) {
    const run = personalCodeRun(context);
    if (!run) return fail(err.forbidden("Chat delivery requires personal Code"));
    const effectKey = CapabilityIdempotencyKeySchema.safeParse(context.idempotencyKey);
    if (!effectKey.success) return fail(err.badInput("A valid idempotency key is required"));
    const parsed = aiChatDeliveryInput.safeParse(input);
    if (!parsed.success) return fail(err.badInput("Supply 1–10,000 characters of result text"));
    const key = effectKey.data;
    const requestHash = approvalArgsDigest({ chat: codeChatDestination(context), text: parsed.data.text });
    return sql.begin(async (db) => {
      // Serialize one effect key even if concurrent retries name different destination chats.
      await db`SELECT pg_advisory_xact_lock(hashtextextended(${`code.chat.deliver:${run.runId}:${key}`},0))`;
      const chat = await ownedCodeRunChat(context, db, { lock: true });
      if (!chat) return fail(err.notFound("Chat"));
      const [previous] = await db<{ request_hash: string; message_short_id: string }[]>`SELECT request_hash,message_short_id
        FROM code.chat_deliveries WHERE run_id=${run.runId}::uuid AND key=${key}`;
      if (previous && previous.request_hash !== requestHash)
        return fail(capabilityIdempotencyConflict("The delivery key was used for a different result"));
      let messageId = previous?.message_short_id;
      if (!messageId) {
        const message = await appendAiBackgroundMessage(db, {
          conversationId: chat.id,
          text: parsed.data.text,
          meta: { codeDelivery: { codeId: chat.code_id, runId: run.runId, effectKey: key } },
        });
        await db`INSERT INTO code.chat_deliveries(run_id,key,request_hash,message_id,message_short_id,conversation_id)
          VALUES (${run.runId}::uuid,${key},${requestHash},${message.id}::uuid,${message.shortId},${chat.id}::uuid)`;
        messageId = message.shortId;
      }
      return ok({
        data: { id: messageId, status: "delivered" as const, targetChatId: chat.short_id },
        refs: [{ type: "core.ai.chat", id: chat.short_id }],
        links: [{ rel: "open" as const, href: `/app/assistant?conversation=${encodeURIComponent(chat.short_id)}` }],
      });
    });
  },
};
