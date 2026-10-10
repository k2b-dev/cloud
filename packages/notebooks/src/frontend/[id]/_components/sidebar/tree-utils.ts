import { compareNoteOrder, sortNoteLevels } from "../../../../lib/note-order";
import type { SidebarFilter } from "../../../../lib/sidebar-filter";
import { extractTags } from "../../../lib/tag-extract";
import type { NoteTreeNode } from "./types";

/** `title` is the notebook order: by hand where a level was arranged, by title elsewhere. */
export type NoteTreeSort = "title" | "created" | "updated";

const byDate = (mode: "created" | "updated") => (left: NoteTreeNode, right: NoteTreeNode) => {
  const leftDate = mode === "created" ? left.createdAt : left.updatedAt;
  const rightDate = mode === "created" ? right.createdAt : right.updatedAt;
  return rightDate.localeCompare(leftDate) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
};

export function sortNoteTree(nodes: NoteTreeNode[], mode: NoteTreeSort, locale: string): NoteTreeNode[] {
  return sortNoteLevels(nodes, mode === "title" ? compareNoteOrder(locale, (node: NoteTreeNode) => node.id) : byDate(mode));
}

/** Moves the homepage to the front of its own level, like the start page of a Book; every other note keeps its place. */
export function homepageFirst(nodes: NoteTreeNode[], homepageId: string | null): NoteTreeNode[] {
  if (!homepageId) return nodes;
  const level = nodes.map((node) => (node.children.length > 0 ? { ...node, children: homepageFirst(node.children, homepageId) } : node));
  const home = level.find((node) => node.id === homepageId);
  return home ? [home, ...level.filter((node) => node !== home)] : level;
}

export function flattenTree(nodes: NoteTreeNode[], excludeId?: string): NoteTreeNode[] {
  const result: NoteTreeNode[] = [];
  const walk = (list: NoteTreeNode[]) => {
    for (const node of list) {
      if (node.id === excludeId) continue;
      result.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return result;
}

export function getNodeDepthLabel(node: NoteTreeNode, allNodes: NoteTreeNode[]): string {
  let depth = 0;
  let current = node;
  while (current.parentId) {
    const parent = allNodes.find((n) => n.id === current.parentId);
    if (!parent) break;
    depth++;
    current = parent;
  }
  return "\u00A0\u00A0".repeat(depth) + node.title;
}

/** How many notes Recent lists: as many as **Recently edited** on the Notebooks start page. */
export const RECENT_NOTE_LIMIT = 12;

/**
 * The notes a sidebar filter lists: the favorites, the most recently changed notes, or the notes with a tag. Without a
 * filter the sidebar shows the tree instead.
 *
 * `shown` is the order of the list on screen. A note keeps its place there, so a live change never moves a row: a
 * changed note updates in place, a note that no longer matches leaves, and a note that starts to match joins at the
 * end, newest first. Recent keeps its notes until it opens again. Without `shown` the list is newest first.
 */
export function filterNotes(
  nodes: NoteTreeNode[],
  filter: SidebarFilter,
  favoriteIds: ReadonlySet<string>,
  shown: readonly string[] = [],
): NoteTreeNode[] {
  if (!filter.view) return [];
  const notes = flattenTree(nodes)
    .filter((note) =>
      filter.view === "favorites"
        ? favoriteIds.has(note.id)
        : filter.view === "tag"
          ? extractTags(note.contentMd).includes(filter.tag)
          : true,
    )
    .sort(byDate("updated"));
  // The sort is stable, so the notes that join keep newest first after the shown ones.
  const place = new Map(shown.map((id, index) => [id, index]));
  const at = (note: NoteTreeNode) => place.get(note.id) ?? shown.length;
  const listed = notes.sort((left, right) => at(left) - at(right));
  return filter.view === "recents" ? listed.slice(0, RECENT_NOTE_LIMIT) : listed;
}
