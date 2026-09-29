const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 1_500;

/**
 * How long an accepted subscription must stay up before its drop starts the
 * backoff over. A server can accept a subscription and fail right after, so
 * acceptance alone proves nothing. With this window, a connection that keeps
 * failing reconnects at most about once per longest backoff delay.
 */
export const RECONNECT_HEALTHY_AFTER_MS = RECONNECT_MAX_DELAY_MS;

/** Doubles per failed attempt since the last healthy connection, capped, plus jitter. */
export const reconnectDelayMs = (failedAttempts: number, random: number = Math.random()): number =>
  Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempts), RECONNECT_MAX_DELAY_MS) + Math.floor(random * RECONNECT_JITTER_MS);
