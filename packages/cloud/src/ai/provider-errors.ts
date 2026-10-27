import type { NessiIssue, Provider, StreamEvent } from "@k2b/nessi/ai";
import { classifyProviderFailure, recordAiProviderStatus } from "./provider-connections";
import { type ProviderFetchMarks, runWithProviderFetchMarks } from "./provider-fetch";

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
export const withProviderErrors = (provider: Provider, providerId?: string): Provider => ({
  name: provider.name,
  family: provider.family,
  model: provider.model,
  contextWindow: provider.contextWindow,
  capabilities: provider.capabilities,
  complete: async (request) => {
    const marks: ProviderFetchMarks = {};
    try {
      const result = await runWithProviderFetchMarks(marks, () => provider.complete(request));
      if (providerId && !request.signal?.aborted)
        void recordAiProviderStatus(
          providerId,
          ["error", "aborted", "interrupted"].includes(result.finishReason ?? "")
            ? classifyProviderFailure(marks.httpStatus ? { status: marks.httpStatus } : {})
            : { status: "ok", message: "The provider connection works." },
        );
      return result;
    } catch (error) {
      if (providerId && !request.signal?.aborted)
        void recordAiProviderStatus(
          providerId,
          classifyProviderFailure(marks.httpStatus ? { status: marks.httpStatus } : marks.networkFailure ? new TypeError() : error),
        );
      throw new AiProviderError(request.signal?.aborted);
    }
  },
  stream: async function* (request) {
    const marks: ProviderFetchMarks = {};
    let iterator: AsyncIterator<StreamEvent> | undefined;
    try {
      const activeIterator = provider.stream(request)[Symbol.asyncIterator]();
      iterator = activeIterator;
      let failed = false;
      for (;;) {
        const next = await runWithProviderFetchMarks(marks, () => activeIterator.next());
        if (next.done) break;
        const event = next.value;
        if (event.type === "issue" && (event.issue.kind === "provider_error" || event.issue.kind === "timeout")) {
          failed = true;
          if (providerId)
            void recordAiProviderStatus(
              providerId,
              event.issue.kind === "timeout"
                ? { status: "unreachable", message: "The provider timed out." }
                : classifyProviderFailure(
                    marks.httpStatus ? { status: marks.httpStatus } : marks.networkFailure ? new TypeError() : event.issue,
                  ),
            );
        }
        yield event.type === "issue" ? { type: "issue", issue: providerIssue(event.issue, request.tools) } : event;
      }
      if (providerId && !failed && !request.signal?.aborted)
        void recordAiProviderStatus(providerId, { status: "ok", message: "The provider connection works." });
    } catch (error) {
      if (providerId && !request.signal?.aborted)
        void recordAiProviderStatus(
          providerId,
          classifyProviderFailure(marks.httpStatus ? { status: marks.httpStatus } : marks.networkFailure ? new TypeError() : error),
        );
      // Includes synchronous creation, iteration, and iterator cleanup failures.
      throw new AiProviderError(request.signal?.aborted);
    } finally {
      try {
        await iterator?.return?.();
      } catch {
        throw new AiProviderError(request.signal?.aborted);
      }
    }
  },
});
