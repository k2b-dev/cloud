/**
 * Tab and Shift+Tab in the note editor.
 *
 * - With a suggestion list open, Tab accepts the highlighted suggestion.
 * - In a table, Tab selects the next cell and Shift+Tab the previous one.
 * - On a list item, Tab nests the selected items one level and Shift+Tab
 *   lifts them one level; the items and text nested under them move along.
 *   A level is the content column of the item above, so ordered and bullet
 *   lists nest the way Markdown renders them. The first item stays put;
 *   items joining a list adopt its marker, and new ordered sublists start at 1.
 * - Everywhere else, including code blocks, Tab inserts two spaces at the
 *   cursor or indents the selected lines, and Shift+Tab removes up to two
 *   spaces of indentation.
 *
 * The note keeps plain spaces. Keyboard users leave the editor with
 * CodeMirror's escape: Esc, then Tab. People who prefer Tab for focus
 * movement leave this extension out through their Notebooks preference.
 */
import { acceptCompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Extension, type Line } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { leadingWhitespace } from "./_lib/list-item-line";
import { splitTableLineCells } from "./_lib/table-cell";
import { indentListItems, outdentListItems } from "./list-commands";

const INDENT = "  ";
type Direction = 1 | -1;

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

/** Tab: accepted suggestion, next table cell, nested list item, or two spaces of indentation. */
const indentOnTab: Command = (view) =>
  !view.state.readOnly && (acceptCompletion(view) || moveTableCell(view, 1) || indentListItems(view) || insertIndent(view));

/** Shift+Tab: previous table cell, lifted list item, or up to two spaces less indentation. */
const outdentOnShiftTab: Command = (view) =>
  !view.state.readOnly && (moveTableCell(view, -1) || outdentListItems(view) || indentLess(view));

/**
 * CodeMirror arms its Esc-then-Tab escape only when no key binding handles Esc, but Esc also collapses
 * a selection and closes suggestions. Arming it on every Esc keeps "Esc, then Tab" leaving the editor.
 */
const armTabEscape = EditorView.domEventObservers({
  keydown: (event, view) => {
    if (event.key === "Escape") view.setTabFocusMode(2000);
  },
});

export const tabIndentExtension = (): Extension => [keymap.of([{ key: "Tab", run: indentOnTab, shift: outdentOnShiftTab }]), armTabEscape];
