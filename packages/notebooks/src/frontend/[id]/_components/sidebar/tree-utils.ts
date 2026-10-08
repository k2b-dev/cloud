import type { NoteTreeNode } from "./types";

export type NoteTreeSort = "title" | "created" | "updated";

const compareNotes = (mode: NoteTreeSort, left: NoteTreeNode, right: NoteTreeNode): number => {
  if (mode !== "title") {
    const leftDate = mode === "created" ? left.createdAt : left.updatedAt;
    const rightDate = mode === "created" ? right.createdAt : right.updatedAt;
    if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
  }

  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
};

export function sortNoteTree(nodes: NoteTreeNode[], mode: NoteTreeSort): NoteTreeNode[] {
  return [...nodes]
    .sort((left, right) => compareNotes(mode, left, right))
    .map((node) => ({ ...node, children: sortNoteTree(node.children, mode) }));
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
