import { retry } from "@k2b/sync/retry";
import { type AcquiredDraftLease, DRAFT_LEASE_ERROR_CODES } from "../../contracts";

/** Classifies transport data only; server messages never become collaboration UI. */
export const classifyDraftLeaseAnswer = (
  status?: number,
  body?: unknown,
): "ok" | "held" | "not-owned" | "unavailable" | "unauthorized" | "failed" => {
  if (status === 401) return "unauthorized";
  if (status === undefined || status >= 500 || [408, 429].includes(status)) return "unavailable";
  if (status >= 200 && status < 300) return "ok";
  const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
  if (status === 409) {
    if (code === DRAFT_LEASE_ERROR_CODES.HELD) return "held";
    if (code === DRAFT_LEASE_ERROR_CODES.NOT_OWNED) return "not-owned";
    if (code === DRAFT_LEASE_ERROR_CODES.BUSY) return "unavailable";
  }
  return "failed";
};

export type DraftLeaseResult =
  | { kind: "ok"; lease: AcquiredDraftLease }
  | { kind: "held" | "not-owned" | "unavailable" | "unauthorized" | "failed" };

export const recoverDraftLeaseRequest = <T extends { kind: string }>(options: {
  run: () => Promise<T>;
  signal: AbortSignal;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitter?: number;
}): Promise<T> =>
  retry({
    run: options.run,
    signal: options.signal,
    after: ({ ctx }) => {
      if (ctx.data?.kind !== "unavailable" || ctx.attempt >= (options.maxAttempts ?? 3)) return;
      ctx.reschedule({
        delayMs: ctx.expBackoff({
          baseMs: options.retryBaseMs ?? 500,
          maxMs: options.retryMaxMs ?? 2_000,
          jitter: options.retryJitter ?? 0.2,
        }),
      });
    },
  });
