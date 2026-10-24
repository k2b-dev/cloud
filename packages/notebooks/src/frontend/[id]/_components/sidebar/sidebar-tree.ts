import { type Accessor, batch, createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import {
  levelKey,
  SIDEBAR_MAX_LEVELS,
  SIDEBAR_MAX_WINDOW,
  SIDEBAR_PAGE_SIZE,
  type SidebarLevel,
  type SidebarNote,
  type SidebarTreeSort,
  type SidebarTreeState,
} from "../../../../lib/sidebar-tree";

type LevelRequest = { parentId: string | null; offset: number; limit: number };
type LevelsResponse = { levels: SidebarLevel[]; expandedIds: string[] };

const encodeLevels = (levels: LevelRequest[]) => levels.map((level) => `${level.parentId ?? ""}:${level.offset}:${level.limit}`).join(",");

const fetchLevels = async (notebookId: string, sort: SidebarTreeSort, levels: LevelRequest[], reveal?: string): Promise<LevelsResponse> => {
  const response = await apiClient[":id"].tree.levels.$get({
    param: { id: notebookId },
    query: { sort, ...(levels.length > 0 ? { levels: encodeLevels(levels) } : {}), ...(reveal ? { reveal } : {}) },
  });
  if (!response.ok) throw new Error(`Failed to load notes (${response.status})`);
  return (await response.json()) as LevelsResponse;
};

/**
 * The note tree as the sidebar holds it: the levels a person opened, each a
 * window of rows that grows with "Show more". Changes read the open windows
 * again; nothing ever loads the whole notebook.
 */
export function createSidebarTree(options: { notebookId: Accessor<string>; initial: SidebarTreeState; sort: Accessor<SidebarTreeSort> }) {
  const [levels, setLevels] = createSignal<ReadonlyMap<string, SidebarLevel>>(
    new Map(options.initial.levels.map((level) => [levelKey(level.parentId), level])),
  );
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set(options.initial.expandedIds));
  const [total, setTotal] = createSignal(options.initial.total);
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  // A later request for a level wins over an earlier one that answers late.
  const generations = new Map<string, number>();
  let refreshes = 0;
  let reveals = 0;

  const level = (parentId: string | null) => levels().get(levelKey(parentId));
  const isExpanded = (id: string) => expanded().has(id);
  const isPending = (parentId: string | null) => pending().has(levelKey(parentId));

  const markPending = (keys: string[], on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      for (const key of keys) on ? next.add(key) : next.delete(key);
      return next;
    });

  /** Applies answered windows; `merge` joins a window that continues or precedes the loaded rows. */
  const apply = (answered: SidebarLevel[], issued: Map<string, number>, merge: "replace" | "append" | "prepend" = "replace") =>
    setLevels((current) => {
      const next = new Map(current);
      for (const window of answered) {
        const key = levelKey(window.parentId);
        if (issued.has(key) && generations.get(key) !== issued.get(key)) continue;
        const loaded = next.get(key);
        if (merge === "append" && loaded) next.set(key, { ...window, offset: loaded.offset, items: [...loaded.items, ...window.items] });
        else if (merge === "prepend" && loaded) next.set(key, { ...window, items: [...window.items, ...loaded.items] });
        else next.set(key, window);
      }
      return next;
    });

  const issue = (keys: string[]) => new Map(keys.map((key) => [key, (generations.get(key) ?? 0) + 1] as const));
  const commit = (issued: Map<string, number>) => {
    for (const [key, generation] of issued) generations.set(key, generation);
  };

  const load = async (requests: LevelRequest[], merge: "replace" | "append" | "prepend" = "replace") => {
    const keys = requests.map((request) => levelKey(request.parentId));
    const issued = issue(keys);
    commit(issued);
    markPending(keys, true);
    try {
      const answer = await fetchLevels(options.notebookId(), options.sort(), requests);
      apply(answer.levels, issued, merge);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      markPending(keys, false);
    }
  };

  const setOpen = (id: string, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    if (open && !level(id) && !isPending(id)) void load([{ parentId: id, offset: 0, limit: SIDEBAR_PAGE_SIZE }]).catch(() => undefined);
  };

  const showMore = (parentId: string | null) => {
    const loaded = level(parentId);
    if (!loaded || isPending(parentId)) return Promise.resolve();
    return load([{ parentId, offset: loaded.offset + loaded.items.length, limit: SIDEBAR_PAGE_SIZE }], "append");
  };

  const showEarlier = (parentId: string | null) => {
    const loaded = level(parentId);
    if (!loaded || loaded.offset === 0 || isPending(parentId)) return Promise.resolve();
    const offset = Math.max(0, loaded.offset - SIDEBAR_PAGE_SIZE);
    return load([{ parentId, offset, limit: loaded.offset - offset }], "prepend");
  };

  /**
   * Reads every open window again, after a change somewhere in the notebook or another sort order. The top level and
   * open branches keep their place; a window keeps as many rows as it showed.
   */
  const refresh = async (fromStart = false) => {
    const refresh = ++refreshes;
    const open = [...levels().values()].filter((loaded) => loaded.parentId === null || expanded().has(loaded.parentId));
    const requests: LevelRequest[] = open.map((loaded) => ({
      parentId: loaded.parentId,
      offset: fromStart ? 0 : loaded.offset,
      limit: Math.min(SIDEBAR_MAX_WINDOW, Math.max(SIDEBAR_PAGE_SIZE, loaded.items.length)),
    }));
    // An open branch whose level failed to load loads again, so a retry heals it.
    for (const id of expanded()) if (!levels().has(id)) requests.push({ parentId: id, offset: 0, limit: SIDEBAR_PAGE_SIZE });
    const keys = requests.map((request) => levelKey(request.parentId));
    const issued = issue(keys);
    commit(issued);
    // One request reads at most SIDEBAR_MAX_LEVELS windows; every open window is read again.
    const batches: LevelRequest[][] = [];
    for (let start = 0; start < requests.length; start += SIDEBAR_MAX_LEVELS)
      batches.push(requests.slice(start, start + SIDEBAR_MAX_LEVELS));
    const answers = await Promise.all(batches.map((part) => fetchLevels(options.notebookId(), options.sort(), part)));
    if (refresh !== refreshes) return;
    batch(() => {
      // Closed branches are dropped, so they load fresh when they open again; open ones keep what they show.
      setLevels((current) => new Map([...current].filter(([, loaded]) => loaded.parentId === null || expanded().has(loaded.parentId))));
      apply(
        answers.flatMap((answer) => answer.levels),
        issued,
      );
      setError(null);
    });
  };

  /** Opens the way to a note shown from elsewhere, such as a link in the editor, and loads the windows that hold it. */
  const reveal = async (noteId: string) => {
    const request = ++reveals;
    const note = findNote(noteId);
    if (note && (!note.parentId || ancestorsOpen(note))) return;
    const answer = await fetchLevels(options.notebookId(), options.sort(), [], noteId);
    // Only the note opened last opens its way; an earlier answer that arrives late changes nothing.
    if (request !== reveals) return;
    batch(() => {
      setLevels((current) => {
        const next = new Map(current);
        for (const window of answer.levels) {
          const key = levelKey(window.parentId);
          const loaded = next.get(key);
          // A loaded window that already holds the way keeps the rows the person opened.
          const covers = loaded && window.items.every((item) => loaded.items.some((row) => row.id === item.id));
          if (!covers) next.set(key, window);
        }
        return next;
      });
      setExpanded((current) => new Set([...current, ...answer.expandedIds]));
    });
  };

  const findNote = (id: string): SidebarNote | undefined => {
    for (const loaded of levels().values()) {
      const found = loaded.items.find((item) => item.id === id);
      if (found) return found;
    }
    return undefined;
  };

  const ancestorsOpen = (note: SidebarNote): boolean => {
    let parentId = note.parentId;
    while (parentId) {
      // A branch stays open in memory after its row left the loaded window above it; the way must be on screen.
      const parent = findNote(parentId);
      if (!parent || !expanded().has(parentId)) return false;
      parentId = parent.parentId;
    }
    return true;
  };

  return {
    total,
    setTotal,
    level,
    isExpanded,
    expandedIds: () => [...expanded()],
    isPending,
    error,
    setOpen,
    showMore,
    showEarlier,
    refresh,
    reveal,
    findNote,
  };
}

export type SidebarTree = ReturnType<typeof createSidebarTree>;
