/**
 * For a host whose bar on the phone holds a search and says so with `data-k2-host-search` (see v2.css): its search
 * button stands for the search in the head of the page's workspace there. This focuses that field, which then opens
 * over the top of the workspace, and says whether it did; without such a search, or in a wide window where the field
 * shows itself, the host does its own search.
 */
export const focusPageSearch = (root: ParentNode = document): boolean => {
  if (typeof matchMedia === "undefined" || matchMedia("(min-width: 768px)").matches) return false;
  const field = root.querySelector<HTMLInputElement>('[data-k2-workspace] [data-slot="head"] .k2-input[data-search] input');
  if (!field) return false;
  field.focus();
  return true;
};
