/**
 * The bases list's one declaration: the search over name, description and id, in the service's fixed order. The SSR
 * page reads and the browser writes the address only through it; Grids searches on the server
 * (`gridsService.base.listVisible`). `page` pages the bases, `apps` opens the full list of apps, `new` the dialog that
 * creates a base (`blank` or a template id).
 */
import { defineListQuery, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { overviewMessages } from "./messages";

export const BASES_PAGE_PATH = "/app/grids";
/** Bases per page, as before v2. */
export const BASES_PER_PAGE = 100;
/** Longest search the address keeps; the service compares it with LIKE. */
export const BASES_SEARCH_MAX = 200;
/** Apps per page of the full app list: whole rows of tiles. */
export const APPS_PER_PAGE = 48;

export const basesQuery = (locale: string) => {
  const { t } = overviewMessages.resolve([locale]);
  return defineListQuery({
    key: "grids.bases",
    fields: {},
    search: { label: t.searchBases },
    sort: { fixed: { field: "name", direction: "asc", label: t.name } },
    pageParams: ["page", "apps", "new", "recent"],
  });
};

export type BasesQuery = ReturnType<typeof basesQuery>;
export type BasesState = ListQueryStateOf<BasesQuery>;

/** A whole number of 1 or more from the address, else `fallback`. */
const pageOf = (raw: string | null, fallback: number | null) => {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
};

/** Reads the address with the declaration; a search longer than the list takes is dropped. Never throws. */
export const parseBasesAddress = (query: BasesQuery, params: URLSearchParams) => {
  let { state } = query.parse(params);
  if (state.search && state.search.length > BASES_SEARCH_MAX) state = { ...state, search: undefined };
  return {
    state,
    page: pageOf(params.get("page"), 1) ?? 1,
    /** The page of the full app list, or null while the overview shows. */
    apps: pageOf(params.get("apps"), null),
    /** The template the create dialog starts with (`blank` for none), or null while it is closed. */
    create: params.get("new")?.trim() || null,
  };
};

/** The address of the overview for a search and a page of bases. */
export const basesHref = (query: BasesQuery, state: BasesState, page = 1): string => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `${BASES_PAGE_PATH}?${text}` : BASES_PAGE_PATH;
};

/** The same address with one page parameter set or removed (`null`), the rest kept. */
export const withParam = (href: string, name: string, value: string | null): string => {
  const url = new URL(href, "http://grids.local");
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  return `${url.pathname}${url.search}`;
};
