/** Maximum serialized capability result, including its data and receipt envelope. */
export const CAPABILITY_MAX_RESULT_BYTES = 256 * 1024;

/** Review metadata and complete content have separate transport budgets. */
export const CAPABILITY_MAX_REVIEW_BYTES = 32 * 1024;
export const CAPABILITY_MAX_REVIEW_CONTENT_BYTES = 16 * 1024 * 1024;
