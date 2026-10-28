import type { Provider } from "@k2b/nessi";
import type { NessiIssue } from "@k2b/nessi/ai";
import type { AiTurnError, AiTurnErrorCode } from "./types";

/** A failure whose reason Cloud knows where it throws it, such as a loop that will not answer without tools. */
export class AiTurnFailure extends Error {
  constructor(
    readonly code: AiTurnErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Why a turn failed. `error` is what a person reads, worded by the reader's client; `detail` is the diagnostic cause, which
 * only the log keeps. Provider diagnostics have already been reduced to fixed text. `message`, when set, is Cloud's
 * own wording for the stored error instead of the worded reason.
 */
export type AiTurnFailureInfo = { error: AiTurnError; detail: string; message?: string };

/** The reason part of a failure, known before the turn ends. */
export type AiTurnFailureReason = Omit<AiTurnFailureInfo, "detail">;

// Matched by their codes, so this module stays free of the quota and accounting stores.
const QUOTA_CODES: ReadonlySet<unknown> = new Set(["quota_exhausted", "quota_usage_unknown"]);
const BACKGROUND_BUDGET_CODES: ReadonlySet<unknown> = new Set([
  "ai_background_cost_stop",
  "ai_background_budget_reserved",
  "ai_background_budget_insufficient",
]);

const isSettingsError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "aiError" in error && error.aiError && typeof error.aiError === "object");

/** The reason behind an error that Cloud threw while it prepared or drove a turn. */
export const aiTurnReasonFromThrown = (error: unknown): AiTurnFailureReason => {
  if (error instanceof AiTurnFailure) return { error: { code: error.code } };
  const code = error instanceof Error && "code" in error ? error.code : null;
  // A quota whose usage could not be measured blocks the next turn like a used-up one, until it resets.
  if (QUOTA_CODES.has(code)) return { error: { code: "quota_exhausted" } };
  // Background AI that its budget stops keeps Cloud's own explanation, as a blocked mandate does.
  if (error instanceof Error && BACKGROUND_BUDGET_CODES.has(code)) return { error: { code: "not_allowed" }, message: error.message };
  // Settings that deny the model, or that offer no usable one, fail every new turn the same way until they change.
  if (isSettingsError(error)) return { error: { code: "not_allowed" } };
  return { error: { code: "failed" } };
};

export const aiTurnFailureFromThrown = (error: unknown, fallback: string): AiTurnFailureInfo => ({
  ...aiTurnReasonFromThrown(error),
  detail: error instanceof Error ? error.message : fallback,
});

/** The reason a model call's own issue ends a turn with: the provider failed, or the request no longer fits. */
export const aiTurnErrorFromProviderIssue = (issue: NessiIssue): AiTurnError | null => {
  if (issue.kind === "provider_error") return { code: issue.contextOverflow ? "context_full" : "model_unavailable" };
  if (issue.kind === "timeout" && issue.scope !== "tool") return { code: "model_unavailable" };
  return null;
};

/**
 * Keeps the reason of the model call it wraps, where the call runs: a call starts without one, and its own issue or
 * thrown error sets it. nessi reads the next event ahead while the executor still handles the previous one, so a
 * reason kept where the events arrive could be overwritten by an older event. nessi also passes on only the text of
 * an error that a call throws; this keeps the error itself, so the reason never depends on its text.
 */
export const rememberProviderErrors = (provider: Provider, remember: (reason: AiTurnFailureReason | null) => void): Provider => {
  const note = (error: unknown) => {
    const reason = aiTurnReasonFromThrown(error);
    remember(reason.error.code === "failed" ? { error: { code: "model_unavailable" } } : reason);
  };
  return {
    name: provider.name,
    family: provider.family,
    model: provider.model,
    contextWindow: provider.contextWindow,
    capabilities: provider.capabilities,
    complete: async (request) => {
      remember(null);
      try {
        const result = await provider.complete(request);
        if (result.finishReason === "error") remember({ error: { code: "provider_stopped" } });
        return result;
      } catch (error) {
        if (!request.signal?.aborted) note(error);
        throw error;
      }
    },
    stream: async function* (request) {
      remember(null);
      try {
        for await (const event of provider.stream(request)) {
          const error = event.type === "issue" ? aiTurnErrorFromProviderIssue(event.issue) : null;
          if (error) remember({ error });
          // Provider stops are reported by nessi after the adapter finishes, outside this wrapper.
          if (event.type === "usage" && event.finishReason === "error") remember({ error: { code: "provider_stopped" } });
          yield event;
        }
      } catch (error) {
        if (!request.signal?.aborted) note(error);
        throw error;
      }
    },
  };
};

/** nessi may construct issue messages from model tool arguments or names after the adapter returns. */
export const aiIssueDiagnostic = (issue: NessiIssue): { code: string; message: string } => {
  switch (issue.kind) {
    case "provider_error":
      return { code: "provider_error", message: "AI provider request failed." };
    case "timeout":
      return issue.scope === "tool"
        ? { code: "tool_timeout", message: "AI tool execution timed out." }
        : { code: "provider_timeout", message: "AI provider request timed out." };
    case "malformed_tool_call":
    case "cancelled_tool_call":
      return { code: issue.kind, message: "AI provider returned an incomplete or invalid tool call." };
    case "tool_execution_error":
      return { code: "tool_execution_error", message: "AI tool execution failed." };
    case "tool_historical_result_error":
      return { code: "tool_historical_result_error", message: "AI tool history could not be prepared." };
    default:
      return { code: "runtime_error", message: "AI execution failed." };
  }
};
