const FALLBACK_TOOL_RESULT_CHARS = 8_000;

/**
 * Keep one tool result within roughly half of a model's context. Nessi
 * estimates about four characters per token, so two characters per context
 * token still leave room for history and a response. Its normal 85% context
 * compaction handles several large results in the same loop.
 */
export const resolveAiToolResultMaxChars = (input: { contextWindow?: number; configuredMaxChars: number }): number => {
  const configuredMaxChars = Math.max(1, Math.floor(input.configuredMaxChars));
  const contextWindow = input.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return Math.min(configuredMaxChars, FALLBACK_TOOL_RESULT_CHARS);
  }
  return Math.min(configuredMaxChars, Math.max(1, Math.floor(contextWindow * 2)));
};
