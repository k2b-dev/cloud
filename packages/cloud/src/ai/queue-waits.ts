import type { SQL } from "bun";

/** Recovery cadence shared by the runtime sweep and infrastructure-failure retry delay. */
export const AI_QUEUE_SWEEP_INTERVAL_MS = 15_000;
/** Existing queued-turn admission deadline, also bounding retries before a message can create its turn. */
export const AI_QUEUED_START_TIMEOUT_MS = 30 * 60_000;

/** Errors that leave a person's queued message waiting; the dispatcher retries it later.
 * The send status reports such a message as `queued` with this reason. Automation
 * quota refusals are final and free the place; unknown infrastructure errors remain pending. */
export const AI_QUEUE_RETRYABLE_ERRORS = ["quota_exhausted", "quota_usage_unknown"] as const;

/** A queued message that keeps the chat's order: anything pending, and failed person messages.
 * A refused automation entry is final and holds nothing back. */
export const queuedMessageHoldsChat = (db: SQL) => db`(status='pending' OR (status='failed' AND automation_source IS NULL))`;

export const isAiQueueRetryableError = (error: string | null): boolean =>
  error !== null && AI_QUEUE_RETRYABLE_ERRORS.some((code) => code === error);
