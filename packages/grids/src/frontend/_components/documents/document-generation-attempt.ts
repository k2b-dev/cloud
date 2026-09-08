import { createSignal } from "solid-js";
import type { requestDocumentTemplateGeneration } from "./document-transfer-client";

type GenerationRequest = Omit<Parameters<typeof requestDocumentTemplateGeneration>[0], "signal">;

/** Keep retries tied to the original request, including after an uncertain response. */
export const createDocumentGenerationAttempt = () => {
  const [request, setRequest] = createSignal<GenerationRequest | null>(null);
  return {
    request,
    start(input: Omit<GenerationRequest, "idempotencyKey">): GenerationRequest {
      const current = request();
      if (current) return current;
      const next = { ...input, tags: [...(input.tags ?? [])], idempotencyKey: crypto.randomUUID() };
      setRequest(next);
      return next;
    },
    reset: () => setRequest(null),
  };
};
