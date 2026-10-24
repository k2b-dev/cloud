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
