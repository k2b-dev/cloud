import type { OpenAICompat, Provider, ReasoningEffort } from "@k2b/nessi/ai";
import { openAICompatible } from "@k2b/nessi/ai";
import type { AiProviderType } from "../shared/ai-models";
import { withProviderErrors } from "./provider-errors";
import type { AiModelProfile } from "./types";

/** Bound the first response chunk and every gap between chunks to 60s. Every model call is a stream. */
export const PROVIDER_TIMEOUTS = { firstByteMs: 60_000, idleMs: 60_000 } as const;

/**
 * Reasoning for structured tasks and compaction: the requests every provider accepted before Nessi 0.17. A global
 * "none" breaks models that cannot turn reasoning off, so Anthropic, Mistral and Ollama keep their model defaults.
 */
export const taskReasoningEffort = (type: AiProviderType): ReasoningEffort | undefined => {
  switch (type) {
    case "gemini":
      return "none";
    case "anthropic":
    case "mistral":
    case "ollama":
      return undefined;
    default:
      return "low";
  }
};

type Endpoint = {
  baseURL: string;
  compat: OpenAICompat;
  /** The window before Nessi 1.0, when the profile names none. */
  contextWindow?: number;
  /** Turns an address stored for the provider's native API into its OpenAI-compatible one. */
  chatURL?: (baseURL: string) => string;
};

const withSuffix = (suffix: string) => (baseURL: string) => {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
};

/** Every provider type is an OpenAI-compatible endpoint with its own address and request details. */
const endpoints: Record<Exclude<AiProviderType, "vllm-realtime" | "openai-compatible">, Endpoint> = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    compat: { maxTokensField: "max_completion_tokens", structuredOutput: "response_format", thinkingFormat: "none" },
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    compat: {
      thinkingFormat: "reasoning_details",
      reasoningFormat: "openrouter",
      maxTokensField: "max_tokens",
      structuredOutput: "response_format",
    },
  },
  // Mistral requires nine alphanumeric characters as call IDs; stored and other providers' IDs are mapped per request.
  mistral: {
    baseURL: "https://api.mistral.ai/v1",
    compat: {
      toolCallIdPolicy: "strict9",
      requiresToolResultName: true,
      thinkingFormat: "content_chunks",
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      structuredOutput: "response_format",
    },
  },
  // Anthropic's OpenAI compatibility returns no thinking and ignores reasoning_effort.
  anthropic: {
    baseURL: "https://api.anthropic.com/v1",
    compat: { maxTokensField: "max_tokens", structuredOutput: "response_format", thinkingFormat: "none" },
    contextWindow: 200_000,
    // The native adapter appended /v1/messages to a stored root address.
    chatURL: withSuffix("/v1"),
  },
  // Gemini 3 needs each tool call's thought signature back.
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    compat: { maxTokensField: "max_tokens", structuredOutput: "response_format", toolCallSignatures: "google" },
    contextWindow: 1_000_000,
    // The native adapter used .../v1beta/models; the OpenAI API lives under .../v1beta/openai.
    chatURL: (baseURL) => withSuffix("/openai")(baseURL.replace(/\/+$/, "").replace(/\/models$/, "")),
  },
  // Ollama serves the OpenAI API under /v1 of its own address; the model's context length comes from Ollama itself.
  ollama: {
    baseURL: "http://localhost:11434",
    compat: { maxTokensField: "max_tokens", structuredOutput: "response_format" },
    chatURL: withSuffix("/v1"),
  },
  vllm: {
    baseURL: "http://localhost:8000/v1",
    compat: {
      toolCallIdPolicy: "passthrough",
      supportsUsageInStreaming: true,
      thinkingFormat: "text",
      maxTokensField: "max_tokens",
      // Guided decoding for nessi.structured.
      structuredOutput: "vllm_structured_outputs",
    },
  },
};

export const createAiProvider = (profile: AiModelProfile, apiKey?: string, headers?: Record<string, string>): Provider => {
  if (profile.kind === "decision") throw new Error("Decision models cannot be used for chat generation.");
  if (profile.capabilities.includes("transcription") || profile.capabilities.includes("live-transcription"))
    throw new Error("Transcription profiles cannot be used for chat generation.");
  return withProviderErrors(createAdapter(profile, apiKey, headers), profile.providerId);
};

const createAdapter = (profile: AiModelProfile, apiKey?: string, headers?: Record<string, string>): Provider => {
  const common = {
    model: profile.model,
    apiKey,
    contextWindow: profile.contextWindow,
    temperature: profile.temperature,
    timeouts: PROVIDER_TIMEOUTS,
    extraBody: profile.extraBody,
  };
  switch (profile.provider) {
    case "vllm-realtime":
      throw new Error("Realtime providers cannot generate chat.");
    case "openai-compatible":
      if (!profile.baseURL) throw new Error(`AI model profile "${profile.id}" requires baseURL for openai-compatible provider.`);
      return openAICompatible({ ...common, name: profile.id, baseURL: profile.baseURL, headers });
    default: {
      const endpoint = endpoints[profile.provider];
      const baseURL = profile.baseURL ?? endpoint.baseURL;
      return openAICompatible({
        ...common,
        name: profile.provider,
        // Ollama takes no key.
        apiKey: profile.provider === "ollama" ? undefined : apiKey,
        baseURL: endpoint.chatURL ? endpoint.chatURL(baseURL) : baseURL,
        contextWindow: profile.contextWindow ?? endpoint.contextWindow,
        compat: endpoint.compat,
        // Only self-hosted endpoints take request headers; the admin offers them for no other type.
        ...(profile.provider === "vllm" ? { headers } : {}),
      });
    }
  }
};
