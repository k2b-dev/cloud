/** Shared live transport budgets. Browser producers use this same object as the server engine. */
export const LIVE_LIMITS = {
  ringEvents: 5_000,
  ringBytes: 32 * 1024 ** 2,
  fillWaitMs: 5_000,
  frameBytes: 16 * 1024,
  /** A reconnect sends every subscription at once, so a full set and a few `unsub` may wait. */
  pendingMessages: 24,
  subscriptions: 16,
  keys: 1_000,
  socketsPerViewer: 16,
  sendBufferBytes: 256 * 1024,
  replayWaitMs: 10_000,
  cacheMs: 2_000,
  cacheEntries: 50_000,
  sweepMs: 10_000,
  keysEveryRounds: 6,
  /** Access checks fail closed within ten seconds. */
  checkMs: 10_000,
  viewersPerCall: 500,
  callsInFlight: 8,
  sweepInFlight: 4,
  batchEvents: 256,
  progressMs: 30_000,
};
