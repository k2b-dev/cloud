import { setTimeout as delay } from "node:timers/promises";
import type { NessiIssue, Provider, ProviderIssue, StreamEvent, TimeoutIssue } from "@k2b/nessi/ai";
import { type ProviderFetchMarks, runWithProviderFetchMarks } from "./provider-fetch";

/** Waits before the first and the second retry when the provider names none. nessi itself never retries. */
export const AI_PROVIDER_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];

/**
 * The longest Retry-After that is honored, the bound the OpenAI and Anthropic
 * SDKs apply. A provider that asks for a longer wait is unavailable for this
 * turn, so the call fails now with the provider's message.
 */
const AI_PROVIDER_MAX_RETRY_AFTER_MS = 60_000;

export type AiProviderRetry = {
  /** 1 for the first retry. */
  retry: number;
  delayMs: number;
  issue: ProviderIssue | TimeoutIssue;
};

const transientIssue = (issue: NessiIssue): issue is ProviderIssue | TimeoutIssue =>
  (issue.kind === "provider_error" && issue.retryable && !issue.contextOverflow) ||
  (issue.kind === "timeout" && issue.retryable && issue.scope !== "tool");

const isBlockEvent = (event: StreamEvent) => event.type === "block_start" || event.type === "block_delta" || event.type === "block_end";

/**
 * Repeats a model call that failed transiently (429, 5xx, a lost connection, a
 * provider timeout) before it produced any output. Each attempt passes through
 * `provider` again, so quota admission and accounting see every request.
 *
 * Once a block event was emitted the attempt is final: streamed text cannot be
 * taken back, so a failure mid-stream still ends the call. Context overflow is
 * left to compaction. Waits follow the provider's Retry-After, otherwise
 * `delaysMs`, end before `deadline`, and stop on the request's abort signal.
 */
export function retryTransientProviderErrors(
  provider: Provider,
  options: {
    /** Epoch milliseconds by which a wait must end; null when the turn has no run time limit. */
    deadline: number | null;
    delaysMs?: readonly number[];
    /** Announces a wait before it starts. */
    onRetry?: (retry: AiProviderRetry) => Promise<void>;
  },
): Provider {
  const delays = options.delaysMs ?? AI_PROVIDER_RETRY_DELAYS_MS;
  const waitFor = (retry: number, marks: ProviderFetchMarks, signal: AbortSignal | undefined): number | null => {
    if (retry >= delays.length || signal?.aborted) return null;
    const delayMs = marks.retryAfterMs ?? delays[retry]!;
    if (delayMs > AI_PROVIDER_MAX_RETRY_AFTER_MS) return null;
    if (options.deadline !== null && Date.now() + delayMs >= options.deadline) return null;
    return delayMs;
  };
  return {
    name: provider.name,
    family: provider.family,
    model: provider.model,
    contextWindow: provider.contextWindow,
    capabilities: provider.capabilities,
    complete: (request) => provider.complete(request),
    stream: async function* (request) {
      for (let retry = 0; ; retry += 1) {
        const marks: ProviderFetchMarks = {};
        const events = provider.stream(request)[Symbol.asyncIterator]();
        const next = () => runWithProviderFetchMarks(marks, () => events.next());
        // Events before the first block (usage, issues) are held so that a retried attempt leaves no trace.
        const held: StreamEvent[] = [];
        let committed = false;
        let pending: AiProviderRetry | null = null;
        try {
          for (let step = await next(); !step.done; step = await next()) {
            const event = step.value;
            if (!committed && event.type === "issue" && transientIssue(event.issue)) {
              const delayMs = waitFor(retry, marks, request.signal);
              if (delayMs !== null) {
                pending = { retry: retry + 1, delayMs, issue: event.issue };
                break;
              }
            }
            if (!committed && !isBlockEvent(event)) {
              held.push(event);
              continue;
            }
            if (!committed) {
              committed = true;
              yield* held.splice(0);
            }
            yield event;
          }
        } finally {
          // Settles the failed attempt's accounting before the wait starts.
          await events.return?.();
        }
        if (!pending) {
          yield* held;
          return;
        }
        await options.onRetry?.(pending);
        await delay(pending.delayMs, undefined, { signal: request.signal });
      }
    },
  };
}
