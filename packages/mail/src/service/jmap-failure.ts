import { JmapError, JmapMethodError } from "./connectors/jmap-client";
import { JmapReconciliationRequiredError } from "./connectors/jmap-delta";
import { JmapHttpError, JmapRateLimitError, JmapRequestError } from "./connectors/jmap-http";
import { JmapTransportError } from "./connectors/jmap-transport";

// The wait after a 429 without a usable Retry-After, the same as the IMAP folder sync's.
export const JMAP_RATE_LIMIT_FALLBACK_MS = 5_000;

export type JmapFailure =
  | { kind: "rate_limited"; retryAfterMs: number }
  | {
      kind:
        | "auth_required"
        | "access_denied"
        | "timeout"
        | "unavailable"
        | "aborted"
        | "reconciliation_required"
        | "session_changed"
        | "invalid";
    };

/**
 * How a JMAP account run should treat a connector failure. Pure: it records no health, opens no
 * breaker and sets no cooldown. Null for an error that did not come from the JMAP connector, such
 * as a database failure, which keeps its own handling.
 */
export function classifyJmapFailure(error: unknown, now: number): JmapFailure | null {
  if (error instanceof JmapRateLimitError)
    return { kind: "rate_limited", retryAfterMs: error.retryAfterMs(now) ?? JMAP_RATE_LIMIT_FALLBACK_MS };
  if (error instanceof JmapHttpError) {
    if (error.status === 401) return { kind: "auth_required" };
    if (error.status === 403) return { kind: "access_denied" };
    return { kind: error.status >= 500 ? "unavailable" : "invalid" };
  }
  if (error instanceof JmapTransportError) {
    if (error.code === "JMAP_TIMEOUT") return { kind: "timeout" };
    if (error.code === "JMAP_ABORTED") return { kind: "aborted" };
    return { kind: error.code === "JMAP_TRANSPORT" ? "unavailable" : "invalid" };
  }
  if (error instanceof JmapMethodError) return { kind: error.methodType === "serverUnavailable" ? "unavailable" : "invalid" };
  if (error instanceof JmapReconciliationRequiredError) return { kind: "reconciliation_required" };
  if (error instanceof JmapError) return { kind: error.code === "JMAP_SESSION_CHANGED" ? "session_changed" : "invalid" };
  if (error instanceof JmapRequestError) return { kind: "invalid" };
  return null;
}
