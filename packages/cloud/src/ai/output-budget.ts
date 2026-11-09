import type { Provider } from "@k2b/nessi/ai";
import type { AiModelProfile } from "./types";

/**
 * Reasoning and the visible answer share completion tokens. Do not reserve an arbitrary fraction of the window:
 * use the reported output limit, bounded by the estimated space left after this request's prompt and tools.
 * A context window is not an output ceiling: without a reported limit, keep the provider's default.
 * Generic compatible endpoints advertise thinking by default; conservatively include them because models can
 * reason without a reasoningEffort setting. Non-thinking endpoints retain their provider default.
 */
export function aiOutputBudget(
  profile: AiModelProfile,
  provider: Pick<Provider, "contextWindow" | "capabilities">,
  inputTokens: number,
  request: { maxOutputTokens?: number; reasoningEffort?: string } = {},
): number | undefined {
  const explicit = request.maxOutputTokens ?? profile.maxOutputTokens;
  if (explicit !== undefined) return explicit;
  if (profile.outputTokenLimit === undefined) return undefined;
  if (!aiModelUsesReasoning(profile, provider, request.reasoningEffort)) return undefined;
  const window = profile.contextWindow ?? provider.contextWindow;
  const remaining = window === undefined ? undefined : Math.max(1, Math.floor(window - inputTokens));
  return remaining === undefined ? profile.outputTokenLimit : Math.min(profile.outputTokenLimit, remaining);
}

export function aiModelUsesReasoning(profile: AiModelProfile, provider: Pick<Provider, "capabilities">, requestedEffort?: string): boolean {
  const effort = requestedEffort ?? profile.reasoningEffort;
  if (effort === "none") return false;
  const body = profile.extraBody;
  const thinking = body?.thinking;
  const reasoning = body?.reasoning;
  const enabled = (value: unknown) =>
    value === true || (typeof value === "object" && value !== null && !("enabled" in value && value.enabled === false));
  if (!effort && !provider.capabilities.thinking && !enabled(thinking) && !enabled(reasoning) && body?.enable_thinking !== true)
    return false;
  return true;
}
