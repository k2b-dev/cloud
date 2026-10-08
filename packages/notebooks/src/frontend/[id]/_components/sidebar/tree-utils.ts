import { compareNoteOrder, sortNoteLevels } from "../../../../lib/note-order";
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
