/**
 * Overlays return focus to the control that opened them, and the ring comes
 * back only for a keyboard user: a pointer user gets focus back silently, a
 * keyboard user keeps seeing where they are.
 */

const showsFocusRing = (element: Element | null | undefined): boolean => element?.matches(":focus-visible") ?? false;

const modifierKeys = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Meta", "Shift"]);
let lastInput: "keyboard" | "pointer" | undefined;
let tracking = false;

/**
 * Chromium and Firefox do not light the ring of an element that got focus
 * back silently when a key is pressed on it, so a keyboard open of an overlay
 * whose last open was by pointer is told apart by the last input instead.
 */
const trackInput = () => {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!modifierKeys.has(event.key)) lastInput = "keyboard";
    },
    true,
  );
  window.addEventListener("pointerdown", () => (lastInput = "pointer"), true);
};

/**
 * Read as an overlay opens, while its trigger still holds focus: whether
 * focus returns with a ring. The ring the trigger shows answers until the
 * first overlay has opened and the last input is known.
 */
export const ringOnReturn = (trigger: Element | null | undefined): boolean => {
  trackInput();
  return lastInput === "keyboard" || showsFocusRing(trigger);
};

/**
 * Moves focus back to `trigger`; `ring` is what `ringOnReturn` reported as
 * the overlay opened. Engines without the option focus as before.
 *
 * Call it before the overlay hides: a native popover or dialog that closes
 * with focus inside restores it on its own, with a ring of the browser's choosing.
 */
export const returnFocus = (trigger: HTMLElement | null | undefined, ring: boolean): void => {
  if (!trigger) return;
  // Text fields always show where typing goes, so the browser decides.
  if (trigger.matches("input, textarea, [contenteditable]:not([contenteditable='false'])")) {
    trigger.focus();
    return;
  }
  // The key that closed an overlay can light the ring of a trigger that kept
  // focus, and focusing the focused element changes nothing.
  if (trigger === document.activeElement) {
    if (showsFocusRing(trigger) === ring) return;
    trigger.blur();
  }
  const options: FocusOptions & { focusVisible?: boolean } = { focusVisible: ring };
  trigger.focus(options);
};
