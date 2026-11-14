import type { AiModelProfile } from "./types";

/**
 * Reasoning and the visible answer share completion tokens. Do not reserve an arbitrary fraction of the window:
 * use the reported output limit, bounded by the estimated space left after this request's prompt and tools.
 * A context window is not an output ceiling: without a reported limit, keep the provider's default.
 * Adapter capabilities describe a transport, not whether a model reasons. The reported ceiling applies to both.
 * Only a catalog/discovered context window is authoritative; the adapter's synthetic fallback is not a model limit.
 */
export function aiOutputBudget(
  profile: AiModelProfile,
  inputTokens: number,
  request: { maxOutputTokens?: number } = {},
): number | undefined {
  const explicit = request.maxOutputTokens ?? profile.maxOutputTokens;
  if (explicit !== undefined) return explicit;
  if (profile.outputTokenLimit === undefined) return undefined;
  const window = profile.contextWindow;
  const remaining = window === undefined ? undefined : Math.max(1, Math.floor(window - inputTokens));
  return remaining === undefined ? profile.outputTokenLimit : Math.min(profile.outputTokenLimit, remaining);
}
