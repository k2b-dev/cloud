/**
 * The address of Grids' start (`/app/grids`). It has no list of its own: it opens the base someone worked in last, or
 * the four ways to a first base. `new` names the open dialog that makes a base (`blank` or a template id).
 */
export const BASES_PAGE_PATH = "/app/grids";

/** The same address with one page parameter set or removed (`null`), the rest kept. */
export const withParam = (href: string, name: string, value: string | null): string => {
  const url = new URL(href, "http://grids.local");
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  return `${url.pathname}${url.search}`;
};
