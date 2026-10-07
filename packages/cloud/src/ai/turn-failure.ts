import type { Provider } from "@k2b/nessi";
import type { NessiIssue } from "@k2b/nessi/ai";
import type { AiSettingsError, AiTurnError, AiTurnErrorCode } from "./types";

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
 * Why a turn failed. `error` is what a person reads, worded by the reader's client; `detail` is the raw cause, which
 * only the log keeps. `message`, when set, is Cloud's own wording for the stored error instead of the worded reason.
 */
export type AiTurnFailureInfo = { error: AiTurnError; detail: string; message?: string };

const settingsErrorCode = (error: unknown): AiSettingsError["code"] | null =>
  error && typeof error === "object" && "aiError" in error && error.aiError && typeof error.aiError === "object" && "code" in error.aiError
    ? (error.aiError as AiSettingsError).code
    : null;

/** The reason behind an error that Cloud threw while it prepared or drove a turn. */
export const aiTurnErrorFromThrown = (error: unknown): AiTurnError => {
  if (error instanceof AiTurnFailure) return { code: error.code };
  // An AiQuotaError; matched by its code, so this module stays free of the quota store.
  if (error instanceof Error && "code" in error && error.code === "quota_exhausted") return { code: "quota_exhausted" };
  const settings = settingsErrorCode(error);
  if (settings === "model_access_denied" || settings === "model_policy_mismatch") return { code: "not_allowed" };
  if (settings) return { code: "model_unavailable" };
  return { code: "failed" };
};

export const aiTurnFailureFromThrown = (error: unknown, fallback: string): AiTurnFailureInfo => ({
  error: aiTurnErrorFromThrown(error),
  detail: error instanceof Error ? error.message : fallback,
});

/** The reason a model call's own issue ends a turn with: the provider failed, or the request no longer fits. */
export const aiTurnErrorFromProviderIssue = (issue: NessiIssue): AiTurnError | null => {
  if (issue.kind === "provider_error") return { code: issue.contextOverflow ? "context_full" : "model_unavailable" };
  if (issue.kind === "timeout" && issue.scope !== "tool") return { code: "model_unavailable" };
  return null;
};

/**
 * nessi passes on only the text of an error that a model call throws. This keeps the error itself, so the turn can
 * name its reason without reading text: a quota that ran out, or a model service that failed.
 */
export const rememberProviderErrors = (provider: Provider, remember: (error: AiTurnError) => void): Provider => {
  const note = (error: unknown) => {
    const reason = aiTurnErrorFromThrown(error);
    remember(reason.code === "failed" ? { code: "model_unavailable" } : reason);
  };
  return {
    name: provider.name,
    family: provider.family,
    model: provider.model,
    contextWindow: provider.contextWindow,
    capabilities: provider.capabilities,
    complete: async (request) => {
      try {
        return await provider.complete(request);
      } catch (error) {
        if (!request.signal?.aborted) note(error);
        throw error;
      }
    },
    stream: async function* (request) {
      try {
        yield* provider.stream(request);
      } catch (error) {
        if (!request.signal?.aborted) note(error);
        throw error;
      }
    },
  };
};
