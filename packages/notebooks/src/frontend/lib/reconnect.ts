const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 1_500;

/** Doubles per failed attempt since the last successful subscription, capped, plus jitter. */
export const reconnectDelayMs = (failedAttempts: number, random: number = Math.random()): number =>
  Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempts), RECONNECT_MAX_DELAY_MS) + Math.floor(random * RECONNECT_JITTER_MS);
