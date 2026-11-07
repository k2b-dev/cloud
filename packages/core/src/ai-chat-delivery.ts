import { sql } from "@k2b/cloud";
import { AI_SHORT_ID_PATTERN } from "@k2b/cloud/ai";
import { appendAiBackgroundMessage } from "@k2b/cloud/ai/runtime";
import { type CapabilityExecutionContext, CapabilityIdempotencyKeySchema, capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";

// Match the existing inter-chat message budget, comfortably below the capability envelope.
export const aiChatDeliveryInput = z.strictObject({
  text: z.string().trim().min(1).max(10_000).describe("Result text to append to your own chat; at most 10,000 characters."),
});
const destination = (context: CapabilityExecutionContext) => (context.target?.type === "core.ai.chat" ? context.target.id : "");
const personalRun = (context: CapabilityExecutionContext) => {
  const delegation = context.actor.delegation;
  return context.actor.kind === "user" &&
    context.user?.id === context.actor.user.id &&
    context.accessSubject.type === "user" &&
    context.accessSubject.userId === context.user.id &&
    delegation?.credentialKind === "mandate" &&
    delegation.workloadType === "code.version" &&
    delegation.workloadId &&
    delegation.workloadRun &&
    ["core", "runner"].includes(delegation.callingAppId)
    ? { userId: context.user.id, versionId: delegation.workloadId, runId: delegation.workloadRun }
    : null;
};

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
    const run = personalRun(context);
    if (!run) return fail(err.forbidden("Chat delivery requires personal Code"));
    const [chat] = await sql<{ title: string }[]>`SELECT conversation.title FROM ai.conversations conversation
      JOIN code.runs run ON run.id=${run.runId}::uuid JOIN code.codes code ON code.id=run.code_id
      WHERE run.version_id=${run.versionId}::uuid AND code.owner_kind='person' AND code.owner_user_id=${run.userId}::uuid
        AND conversation.short_id=${destination(context)} AND conversation.created_by_user_id=${run.userId}::uuid
        AND conversation.archived_at IS NULL`;
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
    const run = personalRun(context);
    if (!run) return fail(err.forbidden("Chat delivery requires personal Code"));
    const effectKey = CapabilityIdempotencyKeySchema.safeParse(context.idempotencyKey);
    if (!effectKey.success) return fail(err.badInput("A valid idempotency key is required"));
    const parsed = aiChatDeliveryInput.safeParse(input);
    if (!parsed.success) return fail(err.badInput("Supply 1–10,000 characters of result text"));
    const key = effectKey.data;
    const requestHash = approvalArgsDigest({ chat: destination(context), text: parsed.data.text });
    return sql.begin(async (db) => {
      // Serialize one effect key even if concurrent retries name different destination chats.
      await db`SELECT pg_advisory_xact_lock(hashtextextended(${`code.chat.deliver:${run.runId}:${key}`},0))`;
      const [chat] = await db<
        { id: string; short_id: string; code_id: string }[]
      >`SELECT conversation.id,conversation.short_id,code.id AS code_id
        FROM ai.conversations conversation JOIN code.runs run ON run.id=${run.runId}::uuid
        JOIN code.codes code ON code.id=run.code_id
        WHERE run.version_id=${run.versionId}::uuid AND code.owner_kind='person' AND code.owner_user_id=${run.userId}::uuid
          AND conversation.short_id=${destination(context)} AND conversation.created_by_user_id=${run.userId}::uuid
          AND conversation.archived_at IS NULL FOR UPDATE OF conversation`;
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
