/**
 * The key that opens the menu behind "+" (Feinschliff v3, F8): Ctrl/⌘ + Shift + 1. Chrome, Edge, Safari, and Firefox
 * leave it free; Ctrl/⌘ + Shift + E and + . are taken by Firefox and Edge.
 */
export const ADD_MENU_SHORTCUT = "mod+shift+1";

/**
 * Whether a key press asks for the menu: the key on the digit row, whatever the layout prints on it, and not while
 * typing in a field other than the chat's own composer.
 */
export const isAddMenuShortcut = (event: KeyboardEvent): boolean => {
  if (event.code !== "Digit1" || !event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return false;
  const target = event.target;
  if (!(target instanceof Element)) return true;
  const typing = target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
  return !typing || typing.closest(".assistant-chat-composer") !== null;
};

/**
 * Listens for the key on this page and opens the menu beside the + that shows: the row of tabs first, then the box,
 * then the chat's head row. Returns the function that stops listening.
 */
export const bindAddMenuShortcut = (open: (from: HTMLElement) => void): (() => void) => {
  const onKey = (event: KeyboardEvent) => {
    if (!isAddMenuShortcut(event)) return;
    const shown = [".k2b-panes__add--tab", ".assistant-context-box__add", ".assistant-context-head__add"]
      .flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
      .find((element) => element.getClientRects().length > 0);
    if (!shown) return;
    event.preventDefault();
    open(shown);
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
};
