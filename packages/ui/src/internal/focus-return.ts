/**
 * Overlays return focus to the control that opened them, and the ring comes
 * back only for a keyboard user: a pointer user gets focus back silently, a
 * keyboard user keeps seeing where they are.
 */

const showsFocusRing = (element: Element | null | undefined): boolean => element?.matches(":focus-visible") ?? false;

/**
 * Keys that do not make someone a keyboard user: modifiers come with pointer
 * gestures, and pointer users close overlays with Escape too.
 */
const passiveKeys = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Escape", "Meta", "Shift"]);
let lastInput: "keyboard" | "pointer" | undefined;

// Tracked from the start, so the first overlay on a page knows the last input
// as well. The trigger's ring cannot tell it: Chromium and Firefox do not light
// the ring of an element that got focus back silently when a key is pressed on it.
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (!passiveKeys.has(event.key)) lastInput = "keyboard";
    },
    true,
  );
  window.addEventListener("pointerdown", () => (lastInput = "pointer"), true);
}

const keyboardLast = (): boolean => lastInput === "keyboard";

/**
 * Read as an overlay opens, while its trigger still holds focus: whether the
 * keyboard opened it. The trigger's ring answers before the first input.
 */
export const ringOnReturn = (trigger: Element | null | undefined): boolean => keyboardLast() || showsFocusRing(trigger);

/**
 * Moves focus back to `trigger`. It shows a ring when the keyboard opened the
 * overlay (`openedByKeyboard`, what `ringOnReturn` reported as it opened) or
 * worked it since, so a pointer open closed with Escape alone returns silently.
 * Engines without the option focus as before.
 *
 * Call it before the overlay hides: a native popover or dialog that closes
 * with focus inside restores it on its own, with a ring of the browser's choosing.
 */
export const returnFocus = (trigger: HTMLElement | null | undefined, openedByKeyboard: boolean): void => {
  if (!trigger) return;
  // Text fields always show where typing goes, so the browser decides.
  if (trigger.matches("input, textarea, [contenteditable]:not([contenteditable='false'])")) {
    trigger.focus();
    return;
  }
  const ring = openedByKeyboard || keyboardLast();
  // The key that closed an overlay can light the ring of a trigger that kept
  // focus, and focusing the focused element changes nothing.
  if (trigger === document.activeElement) {
    if (showsFocusRing(trigger) === ring) return;
    trigger.blur();
  }
  const options: FocusOptions & { focusVisible?: boolean } = { focusVisible: ring };
  trigger.focus(options);
};
