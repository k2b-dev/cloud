/**
 * Tab and Shift+Tab in the note editor.
 *
 * - In a table, Tab selects the next cell and Shift+Tab the previous one.
 * - On a list item, Tab nests the selected items one level and Shift+Tab
 *   lifts them one level. A level is the content column of the item above,
 *   so ordered and bullet lists nest the way Markdown renders them.
 * - Everywhere else, including code blocks, Tab inserts two spaces at the
 *   cursor or indents the selected lines, and Shift+Tab removes up to two
 *   spaces of indentation.
 *
 * The note keeps plain spaces. Keyboard users leave the editor with
 * CodeMirror's built-in escape: Esc, then Tab. People who prefer Tab for
 * focus movement leave this extension out through their Notebooks preference.
 */
import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Extension, type Line } from "@codemirror/state";
import { type Command, type EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { splitTableLineCells } from "./_lib/table-cell";

const INDENT = "  ";
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const CODE = new Set(["FencedCode", "CodeBlock"]);

type Direction = 1 | -1;
type ListItemLine = { indent: number; content: number };

const leadingWhitespace = (text: string) => text.length - text.trimStart().length;

const inCode = (state: EditorState, pos: number): boolean => {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (CODE.has(node.name)) return true;
  }
  return false;
};

/**
 * A line that starts with a list marker outside code. The line text decides, not the parse:
 * an empty item right after Tab reads as paragraph text until someone types, and Shift+Tab
 * must still lift it.
 */
const listItemLine = (state: EditorState, line: Line): ListItemLine | null => {
  const match = LIST_ITEM.exec(line.text);
  if (!match) return null;
  const indent = match[1]!.length;
  if (inCode(state, line.from + indent)) return null;
  const marker = match[2]!.length;
  const spaces = match[3]!.length;
  const rest = line.text.length > match[0].length;
  return { indent, content: indent + marker + (rest && spaces >= 1 && spaces <= 4 ? spaces : 1) };
};

/** Columns to nest an item at `indent`: up to the content of the item above it at the same level. */
const nestWidth = (state: EditorState, lineNumber: number, indent: number): number => {
  for (let number = lineNumber - 1; number >= 1; number--) {
    const line = state.doc.line(number);
    if (!line.text.trim()) continue;
    const lead = leadingWhitespace(line.text);
    if (lead > indent) continue;
    const sibling = lead === indent ? listItemLine(state, line) : null;
    return sibling ? sibling.content - indent : INDENT.length;
  }
  return INDENT.length;
};

/** Columns to lift an item at `indent`: back to the marker of its parent item. */
const liftWidth = (state: EditorState, lineNumber: number, indent: number): number => {
  for (let number = lineNumber - 1; number >= 1; number--) {
    const line = state.doc.line(number);
    if (!line.text.trim() || leadingWhitespace(line.text) >= indent) continue;
    const parent = listItemLine(state, line);
    return parent ? indent - parent.indent : Math.min(indent, INDENT.length);
  }
  return Math.min(indent, INDENT.length);
};

/** Lines touched by the selection, following CodeMirror's own line commands. */
const selectedLines = (state: EditorState): Line[] => {
  const lines: Line[] = [];
  let last = -1;
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      if (line.number > last && (range.empty || range.to > line.from)) {
        lines.push(line);
        last = line.number;
      }
      pos = line.to + 1;
    }
  }
  return lines;
};

const shiftListItems = (view: EditorView, direction: Direction): boolean => {
  const { state } = view;
  const headLine = state.doc.lineAt(state.selection.main.head);
  const item = listItemLine(state, headLine);
  if (!item) return false;
  const width = direction > 0 ? nestWidth(state, headLine.number, item.indent) : liftWidth(state, headLine.number, item.indent);
  const changes = state.changes(
    selectedLines(state)
      .filter((line) => line.text.trim())
      .map((line) =>
        direction > 0
          ? { from: line.from, insert: " ".repeat(width) }
          : { from: line.from, to: line.from + Math.min(width, /^ */.exec(line.text)![0].length) },
      ),
  );
  if (!changes.empty) {
    view.dispatch({
      changes,
      selection: state.selection.map(changes, 1),
      scrollIntoView: true,
      userEvent: direction > 0 ? "input.indent" : "delete.dedent",
    });
  }
  return true;
};

const tableAround = (state: EditorState, line: Line): SyntaxNode | null => {
  if (!line.text.trim()) return null;
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + leadingWhitespace(line.text), 1);
    node;
    node = node.parent
  ) {
    if (node.name === "Table") return node;
  }
  return null;
};

/** Every cell in document order; the delimiter row below the header holds none. Empty cells count. */
const tableCells = (state: EditorState, table: SyntaxNode) => {
  const first = state.doc.lineAt(table.from).number;
  const last = state.doc.lineAt(table.to).number;
  const cells: { from: number; to: number }[] = [];
  for (let number = first; number <= last; number++) {
    if (number === first + 1) continue;
    const line = state.doc.line(number);
    for (const cell of splitTableLineCells(line.text)) cells.push({ from: line.from + cell.fromInLine, to: line.from + cell.toInLine });
  }
  return cells;
};

const moveTableCell = (view: EditorView, direction: Direction): boolean => {
  const { state } = view;
  const head = state.selection.main.head;
  const table = tableAround(state, state.doc.lineAt(head));
  if (!table) return false;
  const cells = tableCells(state, table);
  const current = cells.findIndex((cell) => cell.from <= head && head <= cell.to);
  const target =
    current >= 0
      ? cells[current + direction]
      : direction > 0
        ? cells.find((cell) => cell.from > head)
        : cells.findLast((cell) => cell.to < head);
  // The first and last cell keep the cursor; Esc, then Tab still leaves the editor.
  if (!target) return true;
  const text = state.sliceDoc(target.from, target.to);
  const from = target.from + leadingWhitespace(text);
  const to = target.to - (text.length - text.trimEnd().length);
  const selection = from < to ? EditorSelection.range(from, to) : EditorSelection.cursor(Math.min(target.from + 1, target.to));
  view.dispatch({ selection, scrollIntoView: true, userEvent: "select" });
  return true;
};

const insertIndent: Command = (view) => {
  if (view.state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  view.dispatch(view.state.replaceSelection(INDENT), { scrollIntoView: true, userEvent: "input" });
  return true;
};

/** Tab: next table cell, nested list item, or two spaces of indentation. */
const indentOnTab: Command = (view) => !view.state.readOnly && (moveTableCell(view, 1) || shiftListItems(view, 1) || insertIndent(view));

/** Shift+Tab: previous table cell, lifted list item, or up to two spaces less indentation. */
const outdentOnShiftTab: Command = (view) =>
  !view.state.readOnly && (moveTableCell(view, -1) || shiftListItems(view, -1) || indentLess(view));

export const tabIndentExtension = (): Extension => keymap.of([{ key: "Tab", run: indentOnTab, shift: outdentOnShiftTab }]);
