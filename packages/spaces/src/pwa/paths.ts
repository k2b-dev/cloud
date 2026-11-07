import type { OverviewView } from "@/overview-contracts";

const BASE = "/pwa/spaces";
const query = (view?: OverviewView) => (view && view !== "mine" ? `?view=${view}` : "");

/** What a Space list is narrowed to; its address carries it, so reload and Back show the same rows. */
export type SpaceListFilter = { mine: boolean; tagIds: readonly string[]; search: string };
/** The list a page shows: the person's tasks in a view, or one Space with its filter. */
export type PwaList = { kind: "mine"; view: OverviewView } | { kind: "space"; spaceShortId: string; filter: SpaceListFilter };

export const NO_FILTER: SpaceListFilter = { mine: false, tagIds: [], search: "" };

const filterParams = (filter: SpaceListFilter, params = new URLSearchParams()) => {
  if (filter.mine) params.set("mine", "1");
  for (const tag of filter.tagIds) params.append("tag", tag);
  if (filter.search) params.set("q", filter.search);
  return params;
};
const withParams = (path: string, params: URLSearchParams) => {
  const search = params.toString();
  return search ? `${path}?${search}` : path;
};

/** The list in a view; "mine" is the default and leaves the address bare. */
export const listHref = (view?: OverviewView): string => `${BASE}${query(view)}`;

/** One Space as a list of its statuses, narrowed by `filter`. */
export const spaceHref = (spaceShortId: string, filter: SpaceListFilter = NO_FILTER): string =>
  withParams(`${BASE}/${encodeURIComponent(spaceShortId)}`, filterParams(filter));

/** The address of a list. */
export const pwaListHref = (list: PwaList): string =>
  list.kind === "mine" ? listHref(list.view) : spaceHref(list.spaceShortId, list.filter);

/**
 * One task; the list beside it keeps its place in the address. Beside "My tasks" the address is the task's own,
 * shared one; beside its Space it says `list=space` and carries the Space's filter.
 */
export const taskHref = (spaceShortId: string, shortId: string, view?: OverviewView): string =>
  `${BASE}/${encodeURIComponent(spaceShortId)}/${encodeURIComponent(shortId)}${query(view)}`;

/** One task beside `list`. */
export const listTaskHref = (spaceShortId: string, shortId: string, list: PwaList): string =>
  list.kind === "mine"
    ? taskHref(spaceShortId, shortId, list.view)
    : withParams(
        `${BASE}/${encodeURIComponent(spaceShortId)}/${encodeURIComponent(shortId)}`,
        filterParams(list.filter, new URLSearchParams({ list: "space" })),
      );

/** The task a path names, or null for a list. */
export const taskAddress = (pathname: string): { spaceShortId: string; shortId: string } | null => {
  const match = /^\/pwa\/spaces\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  return match ? { spaceShortId: decodeURIComponent(match[1]!), shortId: decodeURIComponent(match[2]!) } : null;
};

/** The Space a list address names, or null for "My tasks" and for a task. */
export const spaceAddress = (pathname: string): string | null => {
  const match = /^\/pwa\/spaces\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
};

/** The filter of a Space list as its address carries it. */
export const parseSpaceListFilter = (params: URLSearchParams): SpaceListFilter => ({
  mine: params.get("mine") === "1",
  tagIds: [...new Set(params.getAll("tag").filter(Boolean))].slice(0, 100),
  search: (params.get("q") ?? "").trim().slice(0, 200),
});

/** The list an address names: a Space, a task beside its Space, or "My tasks" in a view. */
export const listOf = (url: URL, view: (value: string | null) => OverviewView): PwaList => {
  const space = spaceAddress(url.pathname);
  const task = taskAddress(url.pathname);
  if (space) return { kind: "space", spaceShortId: space, filter: parseSpaceListFilter(url.searchParams) };
  if (task && url.searchParams.get("list") === "space")
    return { kind: "space", spaceShortId: task.spaceShortId, filter: parseSpaceListFilter(url.searchParams) };
  return { kind: "mine", view: view(url.searchParams.get("view")) };
};
