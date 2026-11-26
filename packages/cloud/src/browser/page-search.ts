/**
 * The search field of a v2 page's head, as the shell's phone bar reaches it: the shell marks a signed-in v2 page's
 * content with `data-k2-host-search`, and `@k2b/ui/v2` folds that head search away until it has the focus.
 */
const field = () =>
  document.querySelector<HTMLInputElement>('[data-k2-host-search] [data-slot="head"] [data-k2-part="Input"][data-search] > input');

/** The page shows such a field, so the phone bar's search button opens it (and the global search moves to the app menu). */
export const pageOwnsSearch = (): boolean => (field()?.getClientRects().length ?? 0) > 0;

/**
 * Opens the search of the page's head from the phone bar: the field takes the focus, so it opens over the head and
 * the phone's keyboard comes. False when the page shows no such field (none, or its head gives way to an open detail);
 * the bar then opens the global search.
 */
export const openPageSearch = (): boolean => {
  const input = field();
  if (!input || !pageOwnsSearch()) return false;
  input.focus();
  return document.activeElement === input;
};

/**
 * Escape in the page's head search folds the field away (`@k2b/ui/v2`) and lets its focus go; the focus then returns
 * to the phone bar's search button (`trigger`), however the field got it. Returns the cleanup.
 */
export const returnPageSearchFocus = (trigger: () => HTMLElement | undefined): (() => void) => {
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.target !== field()) return;
    // after the field's own handler, which the document runs too: unless the app keeps Escape, the field is left
    setTimeout(() => {
      const button = trigger();
      if (!button || button.getClientRects().length === 0) return;
      if (document.activeElement === document.body || document.activeElement === null) button.focus();
    });
  };
  document.addEventListener("keydown", escape);
  return () => document.removeEventListener("keydown", escape);
};
