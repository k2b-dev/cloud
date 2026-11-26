/**
 * For a host whose bar on the phone holds a search and says so with `data-k2-host-search` (see v2.css): its search
 * button, marked `data-k2-host-search-button`, stands for the search in the head of the page's workspace there. This
 * focuses that field, which then opens over the top of the workspace, and says whether the field has the focus now.
 * Without such a search, with the head hidden (an open detail is the page), or in a wide window where the field shows
 * itself, it returns false and the host does its own search. When Escape folds the field, the focus goes back to what
 * had it, the host's button; when the page takes Escape itself and the field stays open, it does not. A tap does not
 * focus a button on iOS, so there the focus of the folded field simply leaves it.
 */
export const focusPageSearch = (root?: ParentNode): boolean => {
  if (typeof matchMedia === "undefined" || matchMedia("(min-width: 768px)").matches) return false;
  const field = (root ?? document).querySelector<HTMLInputElement>('[data-k2-workspace] [data-slot="head"] .k2-input[data-search] input');
  if (!field) return false;
  const opener = document.activeElement;
  field.focus();
  if (document.activeElement !== field) return false;
  if (opener instanceof HTMLElement && opener !== document.body) {
    // The field folds while Escape is dispatched (its island blurs it there). An app that takes Escape keeps it open,
    // and the focus leaving later is no fold.
    let folding = false;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      folding = true;
      setTimeout(() => {
        folding = false;
      });
    };
    const back = () => {
      field.removeEventListener("keydown", escape, true);
      field.removeEventListener("focusout", back);
      if (folding && opener.isConnected) requestAnimationFrame(() => opener.focus());
    };
    field.addEventListener("keydown", escape, true);
    field.addEventListener("focusout", back);
  }
  return true;
};
