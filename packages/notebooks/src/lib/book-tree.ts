import type { BookTreeNode } from "../frontend/[id]/_components/book/BookNavigator.island";

/**
 * The reading order of a Book: the start page first, then every level by title.
 *
 * Titles compare in the reader's locale with digit runs as numbers. Notes with
 * equal titles keep the order they arrive in. A start page that lives below
 * another note moves to the top level with its sub-pages and leaves its parent.
 */
export const orderBookTree = <Source extends { title: string; children: Source[] }>(
  nodes: Source[],
  options: { id: (node: Source) => string; homeId: string | null; locale: string },
): BookTreeNode[] => {
  const collator = new Intl.Collator(options.locale, { numeric: true });
  let home: BookTreeNode | undefined;
  const order = (level: Source[]): BookTreeNode[] =>
    level
      .map((node) => ({ id: options.id(node), title: node.title, children: order(node.children) }))
      .filter((node) => {
        if (node.id !== options.homeId) return true;
        home = node;
        return false;
      })
      .sort((left, right) => collator.compare(left.title.trim(), right.title.trim()));
  const rest = order(nodes);
  return home ? [home, ...rest] : rest;
};
