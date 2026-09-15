import { isAssistantChatTurn } from "./assistant-models";
import { estimateTokens, type Provider } from "@k2b/nessi";
import type { AccessSubject } from "../server/services/access";
import { aiQuotas } from "./quotas";
import { logger } from "../services/logging";
const log = logger("ai:quotas");

/** Only direct chat streaming. In particular, compaction's complete() is untouched. */
export function quotaProvider(provider: Provider, subject: AccessSubject, model: string, turnId: string, quotas = aiQuotas): Provider {
  return {
    name: provider.name,
    family: provider.family,
    model: provider.model,
    contextWindow: provider.contextWindow,
    capabilities: provider.capabilities,
    complete: (request) => provider.complete(request),
    stream: async function* (request) {
      const constrained = await quotas.assertAllowed(subject, model);
      let id: string | undefined;
      try {
        id = await quotas.begin(subject, model, turnId);
      } catch (error) {
        log.warn("Chat usage admission failed", { code: "quota_admission_failed", turnId });
        if (constrained) throw error;
      }
      let usage: { input: number; output: number; estimated?: boolean } | undefined;
      let completed = false;
      let failed = false;
      const outputBlocks = new Map<string, number>();
      let generated = false;
      try {
        for await (const event of provider.stream(request)) {
          if (event.type === "issue" && event.issue.kind === "provider_error") failed = true;
          if (event.type === "block_delta") outputBlocks.set(event.blockId, (outputBlocks.get(event.blockId) ?? 0) + event.delta.length);
          if (event.type === "block_end") {
            const block = event.block;
            const size = block.type === "text" ? block.text.length
              : block.type === "thinking" ? block.thinking.length
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
        if (id) {
          try {
            // Interrupted adapters commonly omit their final usage event. Charge an
            // explicitly labelled estimate, never invent a measured zero.
            const interrupted = !completed || failed || request.signal?.aborted;
            if (!usage && interrupted) {
              // Encoded files are not text tokens. Their provider-specific costs
              // cannot be reconstructed after interruption.
              const messages = request.messages.map(message => message.role === "user" ? {
                ...message,
                content: message.content.filter(part => typeof part === "string" || part.type !== "file"),
              } : message);
              const instructionSize = (request.systemPrompt?.length ?? 0)
                + JSON.stringify(request.tools ?? []).length
                + JSON.stringify(request.responseFormat ?? {}).length;
              usage = {
                input: estimateTokens(messages) + Math.ceil(instructionSize / 4),
                output: Math.ceil(Array.from(outputBlocks.values()).reduce((sum, size) => sum + size, 0) / 4),
                estimated: true,
              };
            }
            await quotas.finish(id, usage);
          } catch (error) {
            log.warn("Chat usage booking failed", { code: "quota_booking_failed", turnId, callId: id });
            if (constrained) throw error;
          }
        }
      }
    },
  };
}

export function assistantQuotaProvider(provider: Provider, config: Parameters<typeof isAssistantChatTurn>[0], subject: AccessSubject | null, model: string, turnId: string) {
  return isAssistantChatTurn(config) && subject ? quotaProvider(provider, subject, model, turnId) : provider;
}
