/** Errors that leave a person's queued message waiting; the dispatcher retries it later.
 * The send status reports such a message as `queued` with this reason. Automation
 * entries never wait: their refusal is final and frees the place. */
export const AI_QUEUE_RETRYABLE_ERRORS = ["quota_exhausted", "quota_usage_unknown"] as const;

export const isAiQueueRetryableError = (error: string | null): boolean =>
  error !== null && AI_QUEUE_RETRYABLE_ERRORS.some((code) => code === error);
