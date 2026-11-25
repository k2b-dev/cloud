/**
 * The search field of a v2 page's head, as the shell's phone bar reaches it: the shell marks a signed-in v2 page's
 * content with `data-k2-host-search`, and `@k2b/ui/v2` folds that head search away until it has the focus.
 */
const field = () =>
  document.querySelector<HTMLInputElement>('[data-k2-host-search] [data-slot="head"] [data-k2-part="Input"][data-search] > input');

/**
 * Opens the search of the page's head from the phone bar: the field takes the focus, so it opens over the head and
 * the phone's keyboard comes. Escape folds it away again (`@k2b/ui/v2`), and the focus returns to `trigger`. False
 * when the page shows no such field (none, or its head gives way to an open detail); the bar then opens the global
 * search.
 */
export const openPageSearch = (trigger: HTMLElement): boolean => {
  const input = field();
  if (!input || input.getClientRects().length === 0) return false;
  input.focus();
  if (document.activeElement !== input) return false;
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // after the field's own handler (delegated to the document, so a task later): it folds the field and lets the
    // focus go, unless the app keeps Escape
    setTimeout(() => {
      if (document.activeElement === input) return;
      if (document.activeElement === document.body || document.activeElement === null) trigger.focus();
    });
  };
  input.addEventListener("keydown", escape);
  input.addEventListener("blur", () => setTimeout(() => input.removeEventListener("keydown", escape)), { once: true });
  return true;
};
