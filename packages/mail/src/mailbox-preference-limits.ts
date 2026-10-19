/**
 * Pinned and, separately, hidden mailboxes one principal keeps. The overview lists at most 200
 * mailboxes, and Focus leaves out at most as many as the browser sends in one request. Kept free of
 * schemas, so the mailbox page's sidebar can check it without loading Zod.
 */
export const MAX_MAILBOX_PREFERENCES = 200;
