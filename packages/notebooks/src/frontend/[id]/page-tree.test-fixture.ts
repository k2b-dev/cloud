import { spyOn } from "bun:test";
import type { SidebarLevel } from "../../lib/sidebar-tree";
import { notebooksService } from "../../service";
import * as treeLevels from "../../service/tree-levels";

type FixtureNode = {
  id: string;
  shortId: string;
  title: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  hasChildren?: boolean;
  children: FixtureNode[];
};

/**
 * Stands in for the notebook's tree in page tests that run without a database: the sidebar's levels, the first note,
 * the Book's reading order and the lookup of public IDs all answer from these nodes, sorted by the real rules.
 */
export const mockNoteTree = (source: FixtureNode[] | (() => FixtureNode[])) => {
  const read = () => {
    const nodes = typeof source === "function" ? source() : source;
    const all: Array<FixtureNode & { parentId: string | null }> = [];
    const visit = (level: FixtureNode[], parentId: string | null) => {
      for (const node of level) {
        all.push({ ...node, parentId });
        visit(node.children ?? [], node.id);
      }
    };
    visit(nodes, null);
    return { nodes, all, shortIdOf: new Map(all.map((node) => [node.id, node.shortId])) };
  };
  const entry = (node: ReturnType<typeof read>["all"][number]): treeLevels.TreeEntry => ({
    id: node.id,
    shortId: node.shortId,
    parentId: node.parentId,
    title: node.title,
    position: node.position,
    hasChildren: (node.children ?? []).length > 0,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    lockedAt: node.lockedAt,
  });
  const level = (parentId: string | null, scope: { sort: treeLevels.TreeSort; locale: string; homepageId: string | null }) =>
    treeLevels.sortLevel(
      read()
        .all.filter((node) => node.parentId === parentId)
        .map(entry),
      scope.sort,
      scope.locale,
      scope.homepageId,
    );
  return [
    spyOn(notebooksService.note.sidebar, "tree").mockImplementation(async (scope) => {
      const { all, shortIdOf } = read();
      const parents = [null, ...all.filter((node) => (node.children ?? []).length > 0).map((node) => node.id)];
      const levels: SidebarLevel[] = parents.map((parentId) => {
        const items = level(parentId, scope);
        return {
          parentId: parentId ? (shortIdOf.get(parentId) ?? null) : null,
          total: items.length,
          offset: 0,
          items: items.map((item) => ({
            id: item.shortId,
            parentId: item.parentId ? (shortIdOf.get(item.parentId) ?? null) : null,
            title: item.title,
            position: item.position,
            hasChildren: item.hasChildren,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            lockedAt: item.lockedAt,
          })),
        };
      });
      return { total: all.length, levels, expandedIds: parents.filter((id): id is string => !!id).map((id) => shortIdOf.get(id)!) };
    }),
    spyOn(notebooksService.note.sidebar, "firstNote").mockImplementation(async (scope) => level(null, scope)[0]?.shortId ?? null),
    spyOn(notebooksService.note.sidebar, "list").mockResolvedValue({ total: 0, offset: 0, items: [] }),
    // Book's reading order: the start page leads the top level wherever it lives.
    spyOn(notebooksService.note.sidebar, "book").mockImplementation(async (scope) => {
      const { all, shortIdOf } = read();
      const order = { sort: "title" as const, locale: scope.locale, homepageId: scope.homepageId };
      const home = all.find((node) => node.id === scope.homepageId);
      const bookLevel = (parentId: string | null) => {
        const entries = level(parentId, order).filter((entry) => entry.id !== scope.homepageId);
        return parentId === null && home ? [{ ...entry(home), parentId: null }, ...entries] : entries;
      };
      const parents = [null, ...all.filter((node) => (node.children ?? []).length > 0).map((node) => node.id)];
      const levels: SidebarLevel[] = parents.map((parentId) => {
        const items = bookLevel(parentId);
        return {
          parentId: parentId ? (shortIdOf.get(parentId) ?? null) : null,
          total: items.length,
          offset: 0,
          items: items.map((item) => ({
            id: item.shortId,
            parentId: item.parentId ? (shortIdOf.get(item.parentId) ?? null) : null,
            title: item.title,
            position: item.position,
            hasChildren: item.hasChildren,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            lockedAt: item.lockedAt,
          })),
        };
      });
      const selected = all.find((node) => node.id === scope.selectedNoteId);
      const way: string[] = [];
      for (let node = selected; node && node.id !== scope.homepageId; node = all.find((other) => other.id === node!.parentId))
        if (node.parentId && node.parentId !== null) way.unshift(node.parentId);
      const expanded = [...way, ...(selected && (selected.children ?? []).length > 0 ? [selected.id] : [])];
      return { total: all.length, levels, expandedIds: expanded.map((id) => shortIdOf.get(id)!).filter(Boolean) };
    }),
    spyOn(treeLevels, "resolveNotebookNoteIds").mockImplementation(async (_notebookId, shortIds) => {
      const ids = new Map(read().all.map((node) => [node.shortId, node.id]));
      return new Map(shortIds.map((shortId) => [shortId, ids.get(shortId) ?? `id-${shortId}`]));
    }),
  ] as const;
};
