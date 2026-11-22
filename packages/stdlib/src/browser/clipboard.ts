/**
 * Clipboard utilities for copying text in the browser.
 *
 * Requires the Clipboard API, which is only available in secure contexts (HTTPS or localhost).
 * For SolidJS apps, see `clipboard.create()` from `@k2b/stdlib/solid` which adds
 * a reactive `wasCopied` signal that auto-resets after a timeout.
 */

/**
 * Copies text to the system clipboard using the Clipboard API.
 *
 * Requires a secure context (HTTPS or localhost). The browser may prompt the
 * user for permission on the first call.
 *
 * @throws If the Clipboard API is unavailable or the browser denies permission.
 */
export const copyToClipboard = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text);
};

/** Clipboard namespace exposing all clipboard utilities. */
export const clipboard = {
  copy: copyToClipboard,
} as const;
