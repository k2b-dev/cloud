import type { JSX } from "solid-js";

// ==========================
// Accessibility Utilities
// ==========================

/**
 * Returns spreadable event handlers for both click and keyboard (Enter/Space) events.
 * Useful for making non-button elements accessible.
 *
 * @param fn - Function to call on click or Enter/Space key
 * @returns Object with onClick and onKeyDown handlers to spread on elements
 *
 * @example
 * <div role="button" tabindex="0" {...a11y.clickOrEnter(handleAction)}>
 *   Click or press Enter
 * </div>
 */
export const clickOrEnter = (
  fn: (e: MouseEvent | KeyboardEvent) => void,
): {
  onClick: JSX.EventHandler<HTMLElement, MouseEvent>;
  onKeyDown: JSX.EventHandler<HTMLElement, KeyboardEvent>;
} => ({
  onClick: (e: MouseEvent) => {
    e.stopPropagation();
    fn(e);
  },
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      fn(e);
    }
  },
});

export const a11y = {
  clickOrEnter,
} as const;
