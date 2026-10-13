import type { Provider, ReasoningEffort } from "@k2b/nessi/ai";
import { anthropic, completeFromStream, gemini, mistral, ollama, openAICompatible, openai, openrouter } from "@k2b/nessi/ai";
import type { AiModelProfile } from "./types";

/** Bound the first response chunk and every gap between chunks to 60s, for chat and complete() calls. */
export const PROVIDER_TIMEOUTS = { firstByteMs: 60_000, idleMs: 60_000 } as const;

// Native complete() receives headers only after the whole answer, so until then Nessi can bound it only by total time
// (totalMs), which cuts off slow healthy answers or detects a stall late. Streaming bounds the first response chunk and
// every gap between chunks, as for chat. Any body chunk counts, including SSE keep-alive comments.
export const completeThroughStream = (provider: Provider): Provider => ({
  ...provider,
  complete: (request) => completeFromStream(provider, request),
});

/**
 * Reasoning for structured tasks and compaction: the requests every provider accepted before Nessi 0.17. A global
 * "none" breaks models that cannot turn reasoning off, so Anthropic, Mistral and Ollama keep their model defaults.
 */
export const taskReasoningEffort = (provider: Pick<Provider, "family">): ReasoningEffort | undefined => {
  switch (provider.family) {
    case "openai-compatible":
      return "low";
    case "gemini":
      return "none";
    default:
      return undefined;
  }
};

const commonOptions = (profile: AiModelProfile, apiKey?: string) => ({
  apiKey,
  baseURL: profile.baseURL,
  contextWindow: profile.contextWindow,
  temperature: profile.temperature,
  timeouts: PROVIDER_TIMEOUTS,
  extraBody: profile.extraBody,
});

export const createAiProvider = (profile: AiModelProfile, apiKey?: string, headers?: Record<string, string>): Provider => {
  if (profile.capabilities.includes("transcription")) throw new Error("Transcription profiles cannot be used for chat generation.");
  return completeThroughStream(createAdapter(profile, apiKey, headers));
};

const createAdapter = (profile: AiModelProfile, apiKey?: string, headers?: Record<string, string>): Provider => {
  switch (profile.provider) {
    case "openai":
      return openai(profile.model, commonOptions(profile, apiKey));
    case "openrouter":
      return openrouter(profile.model, commonOptions(profile, apiKey));
    case "anthropic":
      return anthropic(profile.model, commonOptions(profile, apiKey));
    case "mistral":
      // Mistral requires nine alphanumeric characters; map stored and other providers' ids at the transport boundary.
      return mistral(profile.model, { ...commonOptions(profile, apiKey), normalizeToolCallIds: "strict9" });
    case "gemini":
      return gemini(profile.model, commonOptions(profile, apiKey));
    case "ollama":
      return ollama(profile.model, {
        baseURL: profile.baseURL,
        contextWindow: profile.contextWindow,
        temperature: profile.temperature,
        timeouts: PROVIDER_TIMEOUTS,
        extraBody: profile.extraBody,
      });
    case "vllm":
      return openAICompatible({
        name: "vllm",
        model: profile.model,
        baseURL: profile.baseURL ?? "http://localhost:8000/v1",
        apiKey,
        headers,
        contextWindow: profile.contextWindow,
        temperature: profile.temperature,
        timeouts: PROVIDER_TIMEOUTS,
        extraBody: profile.extraBody,
        compat: {
          toolCallIdPolicy: "passthrough",
          supportsUsageInStreaming: true,
          thinkingFormat: "text",
          maxTokensField: "max_tokens",
          // Guided decoding for nessi.structured — matches nessi's own vllm() preset.
          structuredOutput: "vllm_structured_outputs",
        },
      });
    case "openai-compatible":
      if (!profile.baseURL) throw new Error(`AI model profile "${profile.id}" requires baseURL for openai-compatible provider.`);
      return openAICompatible({
        name: profile.id,
        model: profile.model,
        baseURL: profile.baseURL,
        apiKey,
        headers,
        contextWindow: profile.contextWindow,
        temperature: profile.temperature,
        timeouts: PROVIDER_TIMEOUTS,
        extraBody: profile.extraBody,
      });
  }
};
