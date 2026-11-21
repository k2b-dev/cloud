import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT, AI_FILES_MAX_FILE_BYTES_DEFAULT } from "../ai/limits";

/** Existing chat Code budgets; generated files use the same ceilings. */
export const CODE_FILE_LIMITS = Object.freeze({
  files: 64,
  fileBytes: AI_FILES_MAX_FILE_BYTES_DEFAULT,
  totalBytes: AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT,
  // Single-use file continuations live ten minutes; a lasting attempt lasts at most five.
  ttlSeconds: 10 * 60,
});
