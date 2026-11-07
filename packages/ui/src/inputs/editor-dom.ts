/**
 * Replaces one textarea range while preserving the browser's native undo path
 * where possible. The fallback emits the input event that the editing command
 * would have emitted, so callers never need a second dispatch.
 */
export const replaceTextareaRange = (textarea: HTMLTextAreaElement, start: number, end: number, replacement: string): boolean => {
  textarea.focus();
  textarea.setSelectionRange(start, end);

  try {
    if (typeof document !== "undefined" && document.execCommand?.("insertText", false, replacement)) return true;
  } catch {
    // Fall through to the standards-based replacement below.
  }

  if (typeof textarea.setRangeText === "function") {
    textarea.setRangeText(replacement, start, end, "end");
  } else {
    textarea.value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
    const caret = start + replacement.length;
    textarea.setSelectionRange(caret, caret);
  }
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};
