import type { NessiIssue, Provider, StreamEvent, TransportReport } from "@k2b/nessi/ai";
import { classifyProviderFailure, recordAiProviderStatus } from "./provider-connections";
import { observeTransport, transportFailed } from "./provider-transport";

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
        // Typed numbers only: the status and the wait the provider asked for drive retries and status records.
        status: Number.isInteger(issue.status) ? issue.status : undefined,
        retryAfterMs:
          typeof issue.retryAfterMs === "number" && Number.isFinite(issue.retryAfterMs) && issue.retryAfterMs >= 0
            ? issue.retryAfterMs
            : undefined,
        // nessi could not build the request and sent nothing.
        ...(issue.notSent === true ? { notSent: true as const } : {}),
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
  stream: async function* (request) {
    let transport: TransportReport | undefined;
    // The failure a status record names: the HTTP status, a lost connection, or the error itself.
    const failure = (fallback: unknown) =>
      transport?.status ? { status: transport.status } : transportFailed(transport) ? new TypeError() : fallback;
    let iterator: AsyncIterator<StreamEvent> | undefined;
    try {
      const activeIterator = provider.stream(observeTransport(request, (report) => (transport = report)))[Symbol.asyncIterator]();
      iterator = activeIterator;
      let failed = false;
      for (;;) {
        const next = await activeIterator.next();
        if (next.done) break;
        const event = next.value;
        if (event.type === "issue" && (event.issue.kind === "provider_error" || event.issue.kind === "timeout")) {
          failed = true;
          if (providerId)
            await recordAiProviderStatus(
              providerId,
              event.issue.kind === "timeout"
                ? { status: "unreachable", message: "The provider timed out." }
                : classifyProviderFailure(failure(event.issue)),
            );
        }
        // A provider that stops the answer itself (a gateway error, a filter) did not serve it, as for a failed complete() before.
        if (event.type === "usage" && event.finishReason === "error" && !failed) {
          failed = true;
          if (providerId && !request.signal?.aborted) await recordAiProviderStatus(providerId, classifyProviderFailure(failure({})));
        }
        yield event.type === "issue" ? { type: "issue", issue: providerIssue(event.issue, request.tools) } : event;
      }
      if (providerId && !failed && !request.signal?.aborted)
        await recordAiProviderStatus(providerId, { status: "ok", message: "The provider connection works." });
    } catch (error) {
      if (providerId && !request.signal?.aborted) await recordAiProviderStatus(providerId, classifyProviderFailure(failure(error)));
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
