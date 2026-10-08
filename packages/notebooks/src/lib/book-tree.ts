import type { BookTreeNode } from "../frontend/[id]/_components/book/BookNavigator.island";
import { compareNoteOrder, type OrderedNote } from "./note-order";

/**
 * The reading order of a Book: the start page first, then every level in the
 * notebook order, the same one the sidebar shows (see `note-order.ts`).
 *
 * A start page that lives below another note moves to the top level with its
 * sub-pages and leaves its parent.
 */
export const orderBookTree = <Source extends OrderedNote & { children: Source[] }>(
  nodes: Source[],
  options: { id: (node: Source) => string; homeId: string | null; locale: string },
): BookTreeNode[] => {
  const compare = compareNoteOrder(options.locale, options.id);
  let home: BookTreeNode | undefined;
  const order = (level: Source[]): BookTreeNode[] =>
    [...level]
      .sort(compare)
      .map((node) => ({ id: options.id(node), title: node.title, children: order(node.children) }))
      .filter((node) => {
        if (node.id !== options.homeId) return true;
        home = node;
        return false;
      });
  const rest = order(nodes);
  return home ? [home, ...rest] : rest;
};
