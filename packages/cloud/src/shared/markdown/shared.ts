/**
 * Shared utilities for markdown rendering
 *
 * Used by both CodeMirror editor extensions and marked renderer extensions
 * to ensure consistent behavior and avoid code duplication.
 */

/**
 * Escape HTML special characters to prevent XSS
 *
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 */
export const escapeHtml = (text: string): string => {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};

// =============================================================================
// Shared CSS Classes (match CodeMirror and marked renderer)
// =============================================================================

/** Image widget styles */
export const IMAGE_STYLES = {
  wrapper: "md-image-widget my-2",
  figure: "flex flex-col items-center justify-center max-w-full",
  img: "block max-h-[400px] rounded border border-gray-200 dark:border-gray-700",
  caption: "text-sm text-gray-500 dark:text-gray-400 mt-2 italic",
} as const;
