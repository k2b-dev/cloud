import { onCleanup, onMount } from "solid-js";

// ==========================
// Click Outside Detection
// ==========================

/**
 * Creates a click-outside detector that calls a callback when
 * the user clicks outside the tracked element.
 *
 * Uses `mousedown` instead of `click` so that the outside interaction is
 * detected before the target element's own click handlers fire. This
 * prevents race conditions where an element removes itself from the DOM
 * during its click handler, causing the "outside" check to fail.
 *
 * @param callback - Function to call when a click outside occurs
 * @returns A ref function to attach to the element to track
 *
 * @example
 * const ref = clickOutside.create(() => setOpen(false));
 * return <div ref={ref}>Dropdown content</div>;
 */
const create = (callback: () => void): ((el: HTMLElement) => void) => {
  let element: HTMLElement | null = null;

  const handleClickOutside = (event: MouseEvent) => {
    if (!element) return;
    if (event.target instanceof Node && !element.contains(event.target)) {
      callback();
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    onCleanup(() => {
      document.removeEventListener("mousedown", handleClickOutside);
    });
  });

  return (el: HTMLElement) => {
    element = el;
  };
};

export const clickOutside = {
  create,
} as const;
