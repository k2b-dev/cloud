import type { Line } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { ExcludedSpan } from "./list-structure";

export const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const CODE = new Set(["FencedCode", "CodeBlock"]);

export type ListItemLine = { indent: number; content: number; marker: string };

export const leadingWhitespace = (text: string) => text.length - text.trimStart().length;

const inCode = (tree: Tree, pos: number): boolean => {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (CODE.has(node.name)) return true;
  }
  return false;
};

/**
 * A line that starts with a list marker outside code, data and directives. The line text decides, not the parse:
 * an empty item right after Tab reads as paragraph text until someone types, and Shift+Tab
 * must still lift it.
 */
export const listItemLine = (tree: Tree, line: Line, excluded: () => readonly ExcludedSpan[]): ListItemLine | null => {
  const match = LIST_ITEM.exec(line.text);
  if (!match) return null;
  const indent = match[1]!.length;
  if (inCode(tree, line.from + indent) || excluded().some((span) => line.from + indent >= span.from && line.from + indent < span.to))
    return null;
  const marker = match[2]!.length;
  const spaces = match[3]!.length;
  const rest = line.text.length > match[0].length;
  return { indent, marker: match[2]!, content: indent + marker + (rest && spaces >= 1 && spaces <= 4 ? spaces : 1) };
};
