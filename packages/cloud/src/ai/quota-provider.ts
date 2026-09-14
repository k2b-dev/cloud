import type { Provider } from "@k2b/nessi";
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
      let usage: { input: number; output: number } | undefined;
      let generated = false;
      try {
        for await (const event of provider.stream(request)) {
          if (event.type === "block_start" || event.type === "block_delta" || event.type === "block_end") generated = true;
          if (event.type === "issue" && event.issue.kind === "provider_error" && event.issue.contextOverflow && !generated && !usage)
            usage = { input: 0, output: 0 };
          if (event.type === "usage") {
            const { input, output } = event.usage;
            // Some adapters synthesize all-zero usage when the endpoint reports none.
            if (Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0 && input + output > 0)
              usage = { input, output };
          }
          yield event;
        }
      } finally {
        if (id) {
          try {
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
