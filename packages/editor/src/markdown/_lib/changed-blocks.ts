import { syntaxTree } from "@codemirror/language";
import type { Transaction } from "@codemirror/state";
import { Tree, type TreeBuffer } from "@lezer/common";

export type MarkdownSpan = { from: number; to: number };
const changedBlocks = new WeakMap<Transaction, readonly MarkdownSpan[]>();
const blocks = (tree: Tree, offset = 0, result = new Map<Tree | TreeBuffer, number>()): Map<Tree | TreeBuffer, number> => {
  tree.children.forEach((child, i) => {
    const from = offset + tree.positions[i]!;
    if (child instanceof Tree && child.type.isAnonymous) blocks(child, from, result);
    else result.set(child, from);
  });
  return result;
};

/** Markdown reparses whole top-level blocks and reuses the other child trees.
 * Compare those identities, including parser-only progress, before visiting nodes.
 */
export const changedMarkdownBlocks = (tr: Transaction): readonly MarkdownSpan[] => {
  const cached = changedBlocks.get(tr);
  if (cached) return cached;
  const before = syntaxTree(tr.startState);
  const after = syntaxTree(tr.state);
  if (before === after) return [];
  const old = blocks(before);
  const spans: MarkdownSpan[] = [];
  for (const [child, from] of blocks(after)) {
    const previous = old.get(child);
    if (previous !== undefined && tr.changes.mapPos(previous, 1) === from) old.delete(child);
    else spans.push({ from, to: from + child.length });
  }
  for (const [child, from] of old) spans.push({ from: tr.changes.mapPos(from, -1), to: tr.changes.mapPos(from + child.length, 1) });
  const merged = mergeMarkdownSpans(spans);
  changedBlocks.set(tr, merged);
  return merged;
};

export const mergeMarkdownSpans = (spans: MarkdownSpan[]): MarkdownSpan[] => {
  const merged: MarkdownSpan[] = [];
  for (const span of spans.sort((a, b) => a.from - b.from)) {
    const previous = merged.at(-1);
    if (previous && span.from <= previous.to) previous.to = Math.max(previous.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
};

/** Sorted, merged spans allow bounded lookups even for a bulk transaction. */
export const intersectsMarkdownSpans = (spans: readonly MarkdownSpan[], from: number, to: number): boolean => {
  let low = 0,
    high = spans.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (spans[middle]!.to <= from) low = middle + 1;
    else high = middle;
  }
  return low < spans.length && spans[low]!.from < to;
};

export const markdownBlockAt = (tree: Tree, position: number): MarkdownSpan => {
  let node = tree.resolve(position, 1);
  if (!node.parent) node = tree.resolve(position, -1);
  if (!node.parent) return { from: position, to: position };
  while (node.parent?.parent) node = node.parent;
  return { from: node.from, to: node.to };
};
