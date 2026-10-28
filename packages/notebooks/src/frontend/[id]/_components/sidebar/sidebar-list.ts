import { type Accessor, createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { SidebarFilter } from "../../../../lib/sidebar-filter";
import { SIDEBAR_MAX_WINDOW, SIDEBAR_PAGE_SIZE, type SidebarList, type SidebarListNote } from "../../../../lib/sidebar-tree";

const sameFilter = (left: SidebarFilter, right: SidebarFilter) => left.view === right.view && left.tag === right.tag;

const fetchPage = async (notebookId: string, filter: SidebarFilter, offset: number, limit: number): Promise<SidebarList> => {
  if (!filter.view) return { total: 0, offset: 0, items: [] };
  const response = await apiClient[":id"].tree.list.$get({
    param: { id: notebookId },
    query: {
      view: filter.view,
      ...(filter.view === "tag" ? { tag: filter.tag } : {}),
      offset: String(offset),
      limit: String(limit),
    },
  });
  if (!response.ok) throw new Error(`Failed to load notes (${response.status})`);
  return (await response.json()) as SidebarList;
};

/**
 * Keeps the order on screen while the list changes: a note keeps its place, a note that no longer matches leaves,
 * and a note that starts to match joins at the end, newest first. Choosing the filter again sorts the list anew.
 */
export const keepShownOrder = (items: readonly SidebarListNote[], shown: readonly string[]): SidebarListNote[] => {
  const place = new Map(shown.map((id, index) => [id, index]));
  const at = (note: SidebarListNote) => place.get(note.id) ?? shown.length;
  return [...items].sort((left, right) => at(left) - at(right));
};

/**
 * The notes of the sidebar's filter, newest first, a page at a time. The server filters, so a list costs its
 * matches, not the notebook.
 */
export function createSidebarList(options: { notebookId: Accessor<string>; initial: { filter: SidebarFilter; list: SidebarList | null } }) {
  const [filter, setFilter] = createSignal<SidebarFilter>(options.initial.filter);
  const [list, setList] = createSignal<SidebarList | null>(options.initial.list);
  const [shown, setShown] = createSignal<readonly string[]>(options.initial.list?.items.map((item) => item.id) ?? []);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let request = 0;

  /** Loads a page of the list; a failure stays visible with Retry and rejects, so a live event is not covered by it. */
  const run = async (next: SidebarFilter, offset: number, limit: number, mode: "fresh" | "refresh" | "more") => {
    const current = ++request;
    setLoading(true);
    try {
      const page = await fetchPage(options.notebookId(), next, offset, limit);
      if (current !== request || !sameFilter(next, filter())) return;
      const loaded = list();
      // Recent keeps the notes it showed until it opens again; a refresh only updates their rows.
      const keep = mode === "refresh" && next.view === "recents" && loaded;
      const items = keep
        ? shown()
            .map((id) => page.items.find((item) => item.id === id) ?? loaded.items.find((item) => item.id === id))
            .filter((item): item is SidebarListNote => !!item)
        : mode === "more" && loaded
          ? [...loaded.items, ...page.items]
          : page.items;
      if (mode === "fresh") setShown(items.map((item) => item.id));
      else if (mode === "more") setShown((ids) => [...ids, ...page.items.map((item) => item.id)]);
      setList({ total: keep ? items.length : page.total, offset: 0, items });
      setError(null);
    } catch (cause) {
      if (current === request) setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      if (current === request) setLoading(false);
    }
  };

  return {
    filter,
    /** Shows another filter, or the tree for an empty one; the list loads from its newest note. */
    choose: (next: SidebarFilter) => {
      setFilter(next);
      setList(null);
      setShown([]);
      if (next.view) void run(next, 0, SIDEBAR_PAGE_SIZE, "fresh").catch(() => undefined);
    },
    /** Follows a filter the address changed to, without reloading the same one. */
    follow: (next: SidebarFilter) => {
      if (sameFilter(next, filter())) return;
      setFilter(next);
      setList(null);
      setShown([]);
      if (next.view) void run(next, 0, SIDEBAR_PAGE_SIZE, "fresh").catch(() => undefined);
    },
    items: () => keepShownOrder(list()?.items ?? [], shown()),
    total: () => list()?.total ?? 0,
    loaded: () => list() !== null,
    hasMore: () => {
      const loaded = list();
      return !!loaded && loaded.items.length < loaded.total;
    },
    showMore: async () => {
      const loaded = list();
      if (loaded && !loading()) await run(filter(), loaded.items.length, SIDEBAR_PAGE_SIZE, "more").catch(() => undefined);
    },
    /** Reads the shown rows again after a change; the rows keep their places. */
    refresh: async () => {
      const current = filter();
      if (!current.view) return;
      await run(current, 0, Math.min(SIDEBAR_MAX_WINDOW, Math.max(SIDEBAR_PAGE_SIZE, list()?.items.length ?? 0)), "refresh");
    },
    /** A deleted note leaves the list at once; Recent would otherwise keep its row until it opens again. */
    forget: (id: string) => {
      setShown((ids) => ids.filter((shownId) => shownId !== id));
      setList((loaded) =>
        loaded?.items.some((item) => item.id === id)
          ? { ...loaded, total: Math.max(0, loaded.total - 1), items: loaded.items.filter((item) => item.id !== id) }
          : loaded,
      );
    },
    loading,
    error,
  };
}

export type SidebarListStore = ReturnType<typeof createSidebarList>;
