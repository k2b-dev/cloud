/**
 * The key that opens the menu behind "+" (Feinschliff v3, F8): Ctrl/⌘ + Shift + 1. Chrome, Edge, Safari, and Firefox
 * leave it free; Ctrl/⌘ + Shift + E and + . are taken by Firefox and Edge.
 */
export const ADD_MENU_SHORTCUT = "mod+shift+1";

/**
 * Listens for the key on this page. Only the key itself is checked here; which + it opens beside loads with the first
 * press, so the page's first download stays small. The key has no browser default to prevent. Returns the function
 * that stops listening.
 */
export const bindAddMenuShortcut = (open: (from: HTMLElement, beside: string | null) => void): (() => void) => {
  const onKey = (event: KeyboardEvent) => {
    if (event.code !== "Digit1" || !event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    void import("./add-menu-shortcut").then((shortcut) => shortcut.openFromKey(event, open));
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
};
