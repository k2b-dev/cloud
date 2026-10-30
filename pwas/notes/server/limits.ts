import { isIP } from "node:net";
import { NotesError } from "./errors";

export const limits = {
  text: 2_097_152,
  stateBytes: 16_777_216,
  fileBytes: 5_242_880,
  files: 20,
  peersPerPad: 50,
  peersPerIp: 20,
  createPerHour: 20,
  uploadPerHour: 10,
  bufferBytes: 1_048_576,
  compactUpdates: 500,
  compactIdleMs: 30_000,
  evictIdleMs: 60_000,
  heartbeatMs: 30_000,
  // Admission budgets are configured by the operator before launch, following the load test.
  messagesPerSecond: 20,
  awarenessPerSecond: 10,
  queuePerPad: 50 * 20,
  processingMs: 200,
} as const;

/** Only the transport's actual peer can opt into forwarded addresses. */
export const requestIp = (peer: string | undefined, forwarded: string | null, trustedProxy?: string): string => {
  if (!peer || isIP(peer) === 0) return "unknown";
  if (peer !== trustedProxy || !forwarded) return peer;
  const last = forwarded.split(",").at(-1)?.trim();
  return last && isIP(last) ? last : peer;
};

/** Bounded sliding windows; callers use separate action names for independent budgets. */
export class RateLimits {
  private readonly windows = new Map<string, { timestamps: { at: number; cost: number }[]; until: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}
  take(action: string, ip: string, maximum: number, windowMs: number, cost = 1): void {
    const now = this.now();
    const key = `${action}:${ip}`;
    let entry = this.windows.get(key);
    if (!entry) {
      if (this.windows.size >= this.maxKeys) this.prune();
      if (this.windows.size >= this.maxKeys) throw new NotesError("rate_limiter_full", 503);
      entry = { timestamps: [], until: now + windowMs };
      this.windows.set(key, entry);
    }
    entry.timestamps = entry.timestamps.filter((entry) => entry.at > now - windowMs);
    if (entry.timestamps.reduce((sum, entry) => sum + entry.cost, 0) + cost > maximum) throw new NotesError("rate_limited", 429);
    entry.timestamps.push({ at: now, cost });
    entry.until = now + windowMs;
  }
  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.windows) if (entry.until <= now) this.windows.delete(key);
  }
}
