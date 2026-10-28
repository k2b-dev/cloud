import type { NessiIssue, Provider } from "@k2b/nessi/ai";

/** No provider-owned message, name, stack, cause, or extension fields cross this boundary. */
export class AiProviderError extends Error {
  readonly code: "provider_error" | "provider_aborted";

  constructor(aborted = false) {
    super(aborted ? "AI provider request was canceled." : "AI provider request failed.");
    this.name = aborted ? "AbortError" : "AiProviderError";
    this.code = aborted ? "provider_aborted" : "provider_error";
  }
}

/** Keep only the adapter's typed control signals. Text and diagnostic payloads are untrusted. */
const providerIssue = (issue: NessiIssue, tools: Parameters<Provider["stream"]>[0]["tools"]): NessiIssue => {
  switch (issue.kind) {
    case "provider_error":
      return {
        kind: "provider_error",
        message: "AI provider request failed.",
        retryable: issue.retryable === true,
        contextOverflow: issue.contextOverflow === true,
        overflowRatio:
          typeof issue.overflowRatio === "number" && Number.isFinite(issue.overflowRatio) && issue.overflowRatio > 0
            ? issue.overflowRatio
            : undefined,
      };
    case "timeout":
      return {
        kind: "timeout",
        scope: issue.scope === "provider_first_byte" ? "provider_first_byte" : "provider_idle",
        message: "AI provider request timed out.",
        retryable: issue.retryable === true,
      };
    case "malformed_tool_call":
    case "cancelled_tool_call":
      return {
        kind: issue.kind,
        reason: toolStreamReason(issue.reason),
        // Use the application-declared name, never an arbitrary provider diagnostic.
        name: tools?.find((tool) => tool.name === issue.name)?.name,
        message: "AI provider returned an incomplete or invalid tool call.",
      };
    default:
      // Tool execution and runtime issues belong to nessi, not a model adapter.
      return { kind: "provider_error", message: "AI provider request failed.", retryable: false };
  }
};

const toolStreamReason = (reason: string) => {
  switch (reason) {
    case "text_during_tool_call":
    case "thinking_during_tool_call":
    case "tool_delta_without_start":
    case "missing_tool_name":
    case "invalid_tool_arguments":
    case "stream_ended_before_tool_call":
    case "provider_error_before_tool_call":
      return reason;
    default:
      return "invalid_tool_arguments";
  }
};

/** Apply before accounting, retry, nessi loops, traces, capabilities, and loggers observe an adapter. */
export const withProviderErrors = (provider: Provider): Provider => ({
  name: provider.name,
  family: provider.family,
  model: provider.model,
  contextWindow: provider.contextWindow,
  capabilities: provider.capabilities,
  complete: async (request) => {
    try {
      return await provider.complete(request);
    } catch {
      throw new AiProviderError(request.signal?.aborted);
    }
  },
  stream: async function* (request) {
    try {
      for await (const event of provider.stream(request)) {
        yield event.type === "issue" ? { type: "issue", issue: providerIssue(event.issue, request.tools) } : event;
      }
    } catch {
      // Includes synchronous creation, iteration, and iterator cleanup failures.
      throw new AiProviderError(request.signal?.aborted);
    }
  },
});
