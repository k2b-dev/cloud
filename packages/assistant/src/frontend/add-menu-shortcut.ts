/**
 * Opens the menu for a press of its key (`add-menu-key.ts`): not while typing in a field other than the chat's own
 * composer, and beside the + that shows: the row of tabs first, then the box, then the chat's head row.
 */
export const openFromKey = (event: KeyboardEvent, open: (from: HTMLElement, beside: string | null) => void): void => {
  const target = event.target;
  const typing =
    target instanceof Element ? target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']") : null;
  if (typing && !typing.closest(".assistant-chat-composer")) return;
  const shown = [".k2b-panes__add--tab", ".assistant-context-box__add", ".assistant-context-head__add"]
    .flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
    .find((element) => element.getClientRects().length > 0);
  // A + of a row of tabs names its group, so a new tab joins it there.
  if (shown) open(shown, shown.dataset.target ?? null);
};
