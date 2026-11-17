import type { SQL } from "bun";

/** Errors that leave a queued message waiting; the dispatcher retries it later.
 * The send status reports such a message as `queued` with this reason. */
export const AI_QUEUE_RETRYABLE_ERRORS = [
  "quota_exhausted",
  "quota_usage_unknown",
  "code_ai_daily_budget_limit",
  "code_ai_owner_daily_budget_limit",
  "code_busy",
] as const;

/** A queued message that keeps the chat's order: anything pending, and failed person messages.
 * A Code message waiting for an allowance lets the person's own messages and actions pass. */
export const queuedMessageHoldsChat = (db: SQL) =>
  db`(status = 'pending' OR (status = 'failed' AND NOT (submission->'runConfig' ? 'codeOrigin' AND error IN ${db([...AI_QUEUE_RETRYABLE_ERRORS])})))`;

export const isAiQueueRetryableError = (error: string | null): boolean =>
  error !== null && AI_QUEUE_RETRYABLE_ERRORS.some((code) => code === error);
