/** Browser- and server-safe limits for conversation attachments. */
export const AI_FILE_MANIFEST_MAX_ITEMS = 20;
export const AI_TURN_ATTACHMENT_MAX_ITEMS = 16;
export const AI_IMAGE_INPUT_MAX_BYTES = 10 * 1024 * 1024;
export const AI_TURN_IMAGE_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
/** One chat file; the upload route refuses larger files. */
export const AI_FILES_MAX_FILE_BYTES_DEFAULT = 50 * 1024 * 1024;
