import { retry } from "@k2b/sync/retry";
import type { AcquiredDraftLease } from "../../contracts";

export type DraftLeaseHeartbeatResult = { kind: "ok"; lease: AcquiredDraftLease } | { kind: "rejected" } | { kind: "unavailable" };

export const recoverDraftLeaseHeartbeat = (options: {
  heartbeat: () => Promise<DraftLeaseHeartbeatResult>;
  signal: AbortSignal;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitter?: number;
}): Promise<DraftLeaseHeartbeatResult> =>
  retry({
    run: options.heartbeat,
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
