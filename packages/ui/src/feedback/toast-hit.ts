/**
 * Whether viewport coordinates fall on a live toast, its round close button over the card's corner included. A module
 * of its own, so a dialog's outside-click check does not carry the whole toast stack into every island with a dialog.
 */
export const isPointInsideToast = (x: number, y: number): boolean => {
  if (typeof document === "undefined") return false;
  const inside = (rect: DOMRect, reach = 0) =>
    x >= rect.left - reach && x <= rect.right + reach && y >= rect.top - reach && y <= rect.bottom + reach;
  for (const card of Array.from(document.querySelectorAll<HTMLElement>("[data-k2b-toast-container] [data-k2b-toast]"))) {
    if (inside(card.getBoundingClientRect())) return true;
    // The close button's hit area reaches 10 px past it.
    const close = card.querySelector<HTMLElement>(":scope > .k2b-toast__close");
    if (close && inside(close.getBoundingClientRect(), 10)) return true;
  }
  return false;
};
