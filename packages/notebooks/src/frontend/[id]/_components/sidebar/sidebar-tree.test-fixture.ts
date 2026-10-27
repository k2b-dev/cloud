import type { SidebarLevel, SidebarNote, SidebarTreeState } from "../../../../lib/sidebar-tree";

export type FixtureTreeNode = Partial<SidebarNote> & { id: string; title: string; children?: FixtureTreeNode[] };

const at = "2026-01-01T00:00:00.000Z";

/** A whole small tree as the server hands it over: every level complete and every branch open. */
export const sidebarTreeState = (nodes: FixtureTreeNode[], options: { expanded?: boolean } = {}): SidebarTreeState => {
  const levels: SidebarLevel[] = [];
  const expandedIds: string[] = [];
  let total = 0;
  const visit = (level: FixtureTreeNode[], parentId: string | null) => {
    total += level.length;
    levels.push({
      parentId,
      total: level.length,
      offset: 0,
      items: level.map((node) => sidebarNote({ ...node, parentId, hasChildren: (node.children?.length ?? 0) > 0 })),
    });
    for (const node of level) {
      if (!node.children?.length) continue;
      if (options.expanded !== false) expandedIds.push(node.id);
      visit(node.children, node.id);
    }
  };
  visit(nodes, null);
  return { total, levels, expandedIds };
};

export const sidebarNote = (node: FixtureTreeNode): SidebarNote => ({
  id: node.id,
  parentId: node.parentId ?? null,
  title: node.title,
  position: node.position ?? 0,
  hasChildren: node.hasChildren ?? (node.children?.length ?? 0) > 0,
  createdAt: node.createdAt ?? at,
  updatedAt: node.updatedAt ?? at,
  lockedAt: node.lockedAt ?? null,
});

/**
 * Book's navigation on arrival for a whole fixture tree: every level loaded, and, as a page load unfolds them, the
 * pages above the open page and the open page itself.
 */
export const bookNavigationState = (nodes: FixtureTreeNode[], selectedId: string | null = null): SidebarTreeState => {
  const state = sidebarTreeState(nodes, { expanded: false });
  const way = (level: FixtureTreeNode[], path: string[]): string[] | null => {
    for (const node of level) {
      if (node.id === selectedId) return [...path, node.id];
      const found = way(node.children ?? [], [...path, node.id]);
      if (found) return found;
    }
    return null;
  };
  return { ...state, expandedIds: selectedId ? (way(nodes, []) ?? []) : [] };
};

/** The server's answer to `GET /:id/tree/levels` for a whole fixture tree, for tests that fake `fetch`. */
export const answerTreeLevels = (nodes: FixtureTreeNode[], url: URL) => {
  const state = sidebarTreeState(nodes);
  const byParent = new Map(state.levels.map((level) => [level.parentId ?? "", level]));
  const windows = (url.searchParams.get("levels") ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [parent = "", offset = "0", limit = "100"] = entry.split(":");
      const level = byParent.get(parent) ?? { parentId: parent || null, total: 0, offset: 0, items: [] };
      return { ...level, offset: Number(offset), items: level.items.slice(Number(offset), Number(offset) + Number(limit)) };
    });
  const reveal = url.searchParams.get("reveal");
  const way = reveal ? (bookNavigationState(nodes, reveal).expandedIds.filter((id) => id !== reveal) ?? []) : [];
  const revealed = reveal ? [null, ...way].map((parent) => byParent.get(parent ?? "")!).filter(Boolean) : [];
  return { levels: [...windows, ...revealed], expandedIds: way };
};
