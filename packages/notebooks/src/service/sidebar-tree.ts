import type { SidebarLevel, SidebarList, SidebarNote, SidebarTreeState } from "../lib/sidebar-tree";
import { resolveIdsToShortIds } from "./notes";
import {
  countNotes,
  levelWindow,
  listFiltered,
  readLevel,
  readSmallTree,
  revealNote,
  SMALL_TREE_NOTES,
  type TreeEntry,
  type TreeLevelWindow,
  type TreeListView,
  type TreeSort,
} from "./tree-levels";

/**
 * The sidebar's tree for a page and its live refreshes, in public IDs. Every
 * call is bounded by the levels it names and their siblings.
 */

type Scope = { notebookId: string; sort: TreeSort; locale: string; homepageId: string | null };

const toPublic = (entry: TreeEntry, shortIds: Map<string, string>): SidebarNote => ({
  id: entry.shortId,
  parentId: entry.parentId ? (shortIds.get(entry.parentId) ?? null) : null,
  title: entry.title,
  position: entry.position,
  hasChildren: entry.hasChildren,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  lockedAt: entry.lockedAt,
});

const projectLevels = async (windows: TreeLevelWindow[]): Promise<{ levels: SidebarLevel[]; shortIds: Map<string, string> }> => {
  const parents = windows.flatMap((window) => [window.parentId, ...window.items.map((item) => item.parentId)]);
  const shortIds = await resolveIdsToShortIds({ ids: parents.filter((id): id is string => !!id) });
  return {
    shortIds,
    levels: windows.map((window) => ({
      parentId: window.parentId ? (shortIds.get(window.parentId) ?? null) : null,
      total: window.total,
      offset: window.offset,
      items: window.items.map((item) => toPublic(item, shortIds)),
    })),
  };
};

/** What the page shows on arrival: a small notebook whole, otherwise the top level and the way to the open note. */
export const loadSidebarTree = async (params: Scope & { selectedNoteId: string | null }): Promise<SidebarTreeState> => {
  const total = await countNotes(params.notebookId);
  const loaded =
    total <= SMALL_TREE_NOTES
      ? await readSmallTree(params)
      : params.selectedNoteId
        ? await revealNote({ ...params, noteId: params.selectedNoteId })
        : { levels: [levelWindow(null, await readLevel({ ...params, parentId: null }), {})], expandedIds: [] };
  const { levels, shortIds } = await projectLevels(loaded.levels);
  return { total, levels, expandedIds: loaded.expandedIds.map((id) => shortIds.get(id)).filter((id): id is string => !!id) };
};

/** The windows a sidebar has open, read again after a change. */
export const loadSidebarLevels = async (
  params: Scope & { levels: Array<{ parentId: string | null; offset: number; limit: number }> },
): Promise<SidebarLevel[]> => {
  const windows = await Promise.all(
    params.levels.map(async (level) => levelWindow(level.parentId, await readLevel({ ...params, parentId: level.parentId }), level)),
  );
  return (await projectLevels(windows)).levels;
};

/** The levels that show one note, for a note opened from elsewhere while the sidebar stays mounted. */
export const revealSidebarNote = async (params: Scope & { noteId: string }): Promise<{ levels: SidebarLevel[]; expandedIds: string[] }> => {
  const revealed = await revealNote(params);
  const { levels, shortIds } = await projectLevels(revealed.levels);
  return { levels, expandedIds: revealed.expandedIds.map((id) => shortIds.get(id)).filter((id): id is string => !!id) };
};

export const loadSidebarList = async (params: {
  notebookId: string;
  userId: string;
  view: TreeListView;
  tag?: string;
  offset: number;
  limit: number;
}): Promise<SidebarList> => {
  const list = await listFiltered(params);
  const shortIds = await resolveIdsToShortIds({ ids: list.items.map((item) => item.parentId).filter((id): id is string => !!id) });
  return { total: list.total, offset: params.offset, items: list.items.map((item) => ({ ...toPublic(item, shortIds), tags: item.tags })) };
};

/** The first note of the top level in this order, where a notebook opens without a remembered or home note. */
export const firstSidebarNote = async (params: Scope): Promise<string | null> =>
  (await readLevel({ ...params, parentId: null }))[0]?.shortId ?? null;
