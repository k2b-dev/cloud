import { setTimeout as delay } from "node:timers/promises";
import { estimateTokens, type Provider } from "@k2b/nessi";
import type { GenerateRequest, TransportReport } from "@k2b/nessi/ai";
import { sql } from "../runtime/clients";

import type { AccessSubject } from "../server/services/access";
import { logger } from "../services/logging";
import type { AiResolvedModelRef } from "../shared/ai-models";
import { isAssistantChatTurn } from "./assistant-models";
import { AiBackgroundAdmissionError, type AiCallContext, type AiCallDetails, beginAiCall, finishAiCall } from "./inference-calls";
import { aiOutputBudget } from "./output-budget";
import { observeTransport, transportRefused } from "./provider-transport";
import type { AiModelProfile } from "./types";

/** A dispatch guard refused the call before any provider request could leave. */
export class AiProviderAdmissionError extends Error {}

const log = logger("ai:quotas");

/** One wrapper owns call accounting. */
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
  lifecycle = callLifecycle,
): Provider {
  // createAiProvider normalizes adapter diagnostics before trusted dispatch guards wrap it.
  // Accounting must preserve those guards' error identity and zero-usage semantics.
  const begin = async (request: GenerateRequest, ctx: AiCallContext) => {
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
            aiOutputBudget(profile, provider, inputTokens, request),
            provider.contextWindow,
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
  const finish = async (
    id: string,
    usage: Parameters<typeof finishAiCall>[1],
    status: Parameters<typeof finishAiCall>[2],
    details?: AiCallDetails,
  ) => {
    try {
      await lifecycle.finish(id, usage, status, details);
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
    stream: async function* (request) {
      const call = await begin(request, context);
      const id = call.id;
      let usage: { input: number; output: number; estimated?: boolean } | undefined;
      let completed = false;
      let failed = false;
      let error: string | undefined;
      const outputBlocks = new Map<string, number>();
      let generated = false;
      const requestStartedAt = Date.now();
      let transport: TransportReport | undefined;
      let firstBlockAt: number | undefined;
      const events = provider
        .stream(observeTransport({ ...request, maxOutputTokens: call.maxOutputTokens }, (report) => (transport = report)))
        [Symbol.asyncIterator]();
      const next = () => events.next();
      try {
        for (let step = await next(); !step.done; step = await next()) {
          const event = step.value;
          if (event.type === "issue" && (event.issue.kind === "provider_error" || event.issue.kind === "timeout")) {
            failed = true;
            error ??= event.issue.message;
          }
          if ((event.type === "block_start" || event.type === "block_delta") && firstBlockAt === undefined) firstBlockAt = Date.now();
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
          // A provider that refused the request, or never received it, did not process it.
          if (
            event.type === "issue" &&
            event.issue.kind === "provider_error" &&
            (event.issue.contextOverflow || event.issue.notSent || transportRefused(transport)) &&
            !generated &&
            !usage
          )
            usage = { input: 0, output: 0 };
          if (event.type === "usage") {
            if (event.finishReason === "aborted" || event.finishReason === "interrupted" || event.finishReason === "error") {
              failed = true;
              error ??= `The provider finished with ${event.finishReason}.`;
            }
            const { input, output } = event.usage;
            // Some adapters synthesize all-zero usage when the endpoint reports none.
            if (Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0 && input + output > 0)
              usage = { input, output };
          }
          yield event;
        }
        completed = true;
      } catch (thrown) {
        if (thrown instanceof AiProviderAdmissionError) usage = { input: 0, output: 0 };
        error ??= thrown instanceof Error ? thrown.message : String(thrown);
        throw thrown;
      } finally {
        call.stop();
        await events.return?.().catch(() => undefined);
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
            const cancelled = request.signal?.aborted === true;
            await finish(id, usage, cancelled ? "aborted" : completed && !failed ? "ok" : "failed", {
              error: cancelled ? null : (error ?? (completed ? null : "The provider stream ended before completion.")),
              cancelled,
              requestStartedAt,
              headersMs: transport?.headersAt === undefined ? undefined : transport.headersAt - requestStartedAt,
              firstByteMs: transport?.firstByteAt === undefined ? undefined : transport.firstByteAt - requestStartedAt,
              firstBlockMs: firstBlockAt === undefined ? undefined : firstBlockAt - requestStartedAt,
            });
          } catch {
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
  modelRef: AiResolvedModelRef,
) {
  const common = { subject, turnId, conversationId, modelRef };
  return inferenceProvider(provider, profile, {
    ...common,
    kind: isAssistantChatTurn(config) ? "chat" : "background",
    task: isAssistantChatTurn(config) ? "chat" : "agent-turn",
  });
}
