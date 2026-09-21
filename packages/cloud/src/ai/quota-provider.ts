import { setTimeout as delay } from "node:timers/promises";
import { estimateTokens, type Provider } from "@k2b/nessi";
import { sql } from "bun";
import type { AccessSubject } from "../server/services/access";
import { logger } from "../services/logging";
import { isAssistantChatTurn } from "./assistant-models";
import { AiBackgroundAdmissionError, type AiCallContext, beginAiCall, finishAiCall } from "./inference-calls";
import type { AiModelProfile } from "./types";

const log = logger("ai:quotas");

/** One wrapper owns call accounting. complete() can have a separate compaction purpose. */
const callLifecycle = {
  begin: beginAiCall,
  finish: finishAiCall,
  heartbeat: async (id: string) => {
    await sql`UPDATE ai.inference_calls SET lease_expires_at=now()+interval '2 minutes' WHERE id=${id}::uuid AND finished_at IS NULL`;
  },
};
export function inferenceProvider(
  provider: Provider,
  profile: AiModelProfile,
  context: AiCallContext,
  completeContext = context,
  lifecycle = callLifecycle,
): Provider {
  const begin = async (request: Parameters<Provider["complete"]>[0], ctx: AiCallContext) => {
    const messages = request.messages.map((message) =>
      message.role === "user"
        ? {
            ...message,
            content: message.content.filter((part) => typeof part === "string" || part.type !== "file"),
          }
        : message,
    );
    const inputTokens =
      estimateTokens(messages) +
      Math.ceil(
        ((request.systemPrompt?.length ?? 0) +
          JSON.stringify(request.tools ?? []).length +
          JSON.stringify(request.responseFormat ?? {}).length) /
          4,
      );
    // Wait up to one reservation lease before delegating to the caller's retry policy.
    // No provider request or new reservation exists while waiting; cancellation stays active.
    const deadline = Date.now() + 120_000;
    const admit = async () => {
      for (;;) {
        request.signal?.throwIfAborted();
        try {
          return await lifecycle.begin(
            profile,
            ctx,
            inputTokens,
            request.maxOutputTokens ?? profile.maxOutputTokens,
            // Nessi's Anthropic adapter defaults to 1024; other adapters use the model default.
            provider.family === "anthropic" ? 1024 : provider.contextWindow,
          );
        } catch (error) {
          if (!(error instanceof AiBackgroundAdmissionError) || !error.retryable || Date.now() >= deadline) throw error;
          await delay(1_000, undefined, { signal: request.signal });
        }
      }
    };
    const call = await admit();
    const heartbeat = setInterval(() => {
      void lifecycle.heartbeat(call.id).catch(() => log.warn("AI accounting heartbeat failed", { callId: call.id }));
    }, 30_000);
    return { ...call, inputTokens, stop: () => clearInterval(heartbeat) };
  };
  const finish = async (id: string, usage: Parameters<typeof finishAiCall>[1], status: "ok" | "failed") => {
    try {
      await lifecycle.finish(id, usage, status);
    } catch {
      log.error("AI cost booking failed", { callId: id, code: "ai_cost_booking_failed" });
    }
  };
  return {
    name: provider.name,
    family: provider.family,
    model: provider.model,
    contextWindow: provider.contextWindow,
    capabilities: provider.capabilities,
    complete: async (request) => {
      const call = await begin(request, completeContext);
      let usage: Parameters<typeof finishAiCall>[1];
      let status: "ok" | "failed" = "failed";
      try {
        const result = await provider.complete({ ...request, maxOutputTokens: call.maxOutputTokens });
        if (
          result.usage &&
          [result.usage.input, result.usage.output].every((n) => Number.isSafeInteger(n) && n >= 0) &&
          result.usage.input + result.usage.output > 0
        )
          usage = { input: result.usage.input, output: result.usage.output };
        status = ["error", "aborted", "interrupted"].includes(result.finishReason) ? "failed" : "ok";
        return result;
      } finally {
        call.stop();
        if (!usage && status === "failed") usage = { input: call.inputTokens, output: 0, estimated: true };
        await finish(call.id, usage, status);
      }
    },
    stream: async function* (request) {
      const call = await begin(request, context);
      const id = call.id;
      let usage: { input: number; output: number; estimated?: boolean } | undefined;
      let completed = false;
      let failed = false;
      const outputBlocks = new Map<string, number>();
      let generated = false;
      try {
        for await (const event of provider.stream({ ...request, maxOutputTokens: call.maxOutputTokens })) {
          if (event.type === "issue" && event.issue.kind === "provider_error") failed = true;
          if (event.type === "block_delta") outputBlocks.set(event.blockId, (outputBlocks.get(event.blockId) ?? 0) + event.delta.length);
          if (event.type === "block_end") {
            const block = event.block;
            const size =
              block.type === "text"
                ? block.text.length
                : block.type === "thinking"
                  ? block.thinking.length
                  : block.name.length + JSON.stringify(block.args).length;
            outputBlocks.set(event.blockId, size);
          }
          if (event.type === "block_start" || event.type === "block_delta" || event.type === "block_end") generated = true;
          if (event.type === "issue" && event.issue.kind === "provider_error" && event.issue.contextOverflow && !generated && !usage)
            usage = { input: 0, output: 0 };
          if (event.type === "usage") {
            if (event.finishReason === "aborted" || event.finishReason === "interrupted" || event.finishReason === "error") failed = true;
            const { input, output } = event.usage;
            // Some adapters synthesize all-zero usage when the endpoint reports none.
            if (Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0 && input + output > 0)
              usage = { input, output };
          }
          yield event;
        }
        completed = true;
      } finally {
        call.stop();
        if (id) {
          try {
            // Interrupted adapters commonly omit their final usage event. Charge an
            // explicitly labelled estimate, never invent a measured zero.
            const interrupted = !completed || failed || request.signal?.aborted;
            if (!usage && interrupted) {
              // Encoded files are not text tokens. Their provider-specific costs
              // cannot be reconstructed after interruption.
              const messages = request.messages.map((message) =>
                message.role === "user"
                  ? {
                      ...message,
                      content: message.content.filter((part) => typeof part === "string" || part.type !== "file"),
                    }
                  : message,
              );
              const instructionSize =
                (request.systemPrompt?.length ?? 0) +
                JSON.stringify(request.tools ?? []).length +
                JSON.stringify(request.responseFormat ?? {}).length;
              usage = {
                input: estimateTokens(messages) + Math.ceil(instructionSize / 4),
                output: Math.ceil(Array.from(outputBlocks.values()).reduce((sum, size) => sum + size, 0) / 4),
                estimated: true,
              };
            }
            await finish(id, usage, completed && !failed && !request.signal?.aborted ? "ok" : "failed");
          } catch (error) {
            log.warn("Chat usage booking failed", { code: "quota_booking_failed", turnId: context.turnId, callId: id });
          }
        }
      }
    },
  };
}

export function assistantQuotaProvider(
  provider: Provider,
  config: Parameters<typeof isAssistantChatTurn>[0],
  subject: AccessSubject | null,
  profile: AiModelProfile,
  turnId: string,
  conversationId: string,
) {
  const common = { subject, turnId, conversationId };
  return inferenceProvider(
    provider,
    profile,
    { ...common, kind: isAssistantChatTurn(config) ? "chat" : "background", task: isAssistantChatTurn(config) ? "chat" : "agent-turn" },
    { ...common, kind: "background", task: "chat-compaction" },
  );
}
