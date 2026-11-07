/**
 * The shared table grid replaces a table's source with its own editable cells. These extensions keep the editor's
 * caret and its one completion popup working there; `slashMenu` installs both.
 */
import {
  acceptCompletion,
  closeCompletion,
  completionStatus,
  hasNextSnippetField,
  hasPrevSnippetField,
  moveCompletionSelection,
  nextSnippetField,
  prevSnippetField,
  startCompletion,
} from "@codemirror/autocomplete";
import type { EditorState, Extension } from "@codemirror/state";
import { type EditorView, getTooltip, repositionTooltips, showTooltip, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { tableHost } from "@k2b/ui/text-editor";
import { displayCell, findTables, gridLine, rowCount, type Table } from "@k2b/ui/text-editor/model";

const tables = new WeakMap<EditorState, Table[]>();
/** The tables of this document state, parsed once per state. */
export const tablesOf = (state: EditorState) => {
  let found = tables.get(state);
  if (!found) {
    found = findTables(state.doc.toString());
    tables.set(state, found);
  }
  return found;
};

/** The table whose source contains `pos`, including its edges. */
export const tableAround = (state: EditorState, pos: number): Table | null =>
  tablesOf(state).find((table) => pos >= table.from && pos <= table.to) ?? null;

/** Row and column of the cell whose source contains `pos`, as the grid addresses it. */
export const cellAt = (table: Table, pos: number): { row: number; column: number; from: number; to: number } | null => {
  for (let row = 0; row < rowCount(table); row++) {
    const line = gridLine(table, row);
    if (!line || pos < line.from || pos > line.to) continue;
    const before = line.pipes.filter((pipe) => pipe < pos).length;
    const column = Math.max(0, Math.min(line.cells.length - 1, line.leadingPipe ? before - 1 : before));
    const cell = line.cells[column];
    return cell ? { row, column, from: cell.from, to: cell.to } : null;
  }
  return null;
};

/** The rendered grid cell of a table's row and column. */
export const gridCell = (view: EditorView, table: Table, row: number, column: number): HTMLElement | null => {
  for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>(".k2b-ste-table")) {
    if (view.posAtDOM(wrap) !== table.from) continue;
    return wrap.querySelector<HTMLElement>(`.k2b-ste-cell[data-r="${row}"][data-c="${column}"]`);
  }
  return null;
};

const selectText = (element: HTMLElement, anchor: number, head: number) => {
  const node = element.firstChild;
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  const length = node?.textContent?.length ?? 0;
  const range = element.ownerDocument.createRange();
  if (node?.nodeType === Node.TEXT_NODE) {
    range.setStart(node, Math.min(Math.min(anchor, head), length));
    range.setEnd(node, Math.min(Math.max(anchor, head), length));
  } else range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
};

/**
 * A command that places the prose caret inside a table, such as inserting a
 * table, slash commands or undo, continues in that cell of the grid instead of
 * at a hidden source position. Remote mapping never moves focus.
 */
export const caretIntoTableCell = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      const explicit = update.transactions.some((tr) => tr.selection !== undefined);
      if (!(explicit || update.focusChanged) || !update.view.hasFocus) return;
      const { anchor, head } = update.state.selection.main;
      const table = tableAround(update.state, head);
      if (!table || head <= table.from || head >= table.to) return;
      const view = update.view;
      queueMicrotask(() => {
        if (!view.hasFocus || view.state.selection.main.head !== head) return;
        const hit = cellAt(table, head);
        const element = hit && gridCell(view, table, hit.row, hit.column);
        if (!hit || !element) return;
        const offset = (pos: number) => displayCell(view.state.sliceDoc(hit.from, Math.min(Math.max(pos, hit.from), hit.to))).length;
        element.focus();
        selectText(element, offset(anchor), offset(head));
      });
    }
  },
);

/**
 * Grid cells write to the same CodeMirror state as prose. Reuse its existing
 * completion sources and snippet fields, including formula/column/name sources;
 * only DOM keyboard routing and the tooltip anchor differ for a replaced table.
 */
export const tableCellCompletions: Extension = ViewPlugin.define((view) => {
  let alive = true;
  const currentCell = () => {
    const focused = view.dom.ownerDocument.activeElement;
    return focused instanceof HTMLElement && focused.matches(".k2b-ste-cell") && view.contentDOM.contains(focused) ? focused : null;
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || view.state.readOnly || !currentCell()) return;
    if (event.key === "Tab" && view.state.facet(tableHost)?.tabMovesFocus?.()) return;
    let handled = false;
    const open = completionStatus(view.state) === "active";
    if ((event.ctrlKey || event.metaKey) && event.code === "Space") handled = startCompletion(view);
    else if (event.key === "Escape" && open) handled = closeCompletion(view);
    else if (open && (event.key === "ArrowDown" || event.key === "ArrowUp"))
      handled = moveCompletionSelection(event.key === "ArrowDown")(view);
    else if (open && (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey))) handled = acceptCompletion(view);
    else if (event.key === "Tab") {
      if (event.shiftKey && hasPrevSnippetField(view.state)) handled = prevSnippetField(view);
      else if (!event.shiftKey && hasNextSnippetField(view.state)) handled = nextSnippetField(view);
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const position = () =>
    queueMicrotask(() => {
      if (!alive) return;
      const cell = currentCell();
      if (!cell) return;
      for (const tooltip of view.state.facet(showTooltip)) {
        const mounted = tooltip && getTooltip(view, tooltip);
        if (!mounted?.dom.classList.contains("cm-tooltip-autocomplete")) continue;
        mounted.getCoords = () => {
          const selection = cell.ownerDocument.getSelection();
          const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
          return caret?.height ? caret : cell.getBoundingClientRect();
        };
      }
      // CodeMirror owns the option list and its IDs; expose the same active option
      // on the actual input so screen readers follow keyboard completion there.
      for (const name of ["aria-autocomplete", "aria-controls", "aria-activedescendant", "aria-expanded"]) {
        const value = view.contentDOM.getAttribute(name);
        if (value) cell.setAttribute(name, value);
        else cell.removeAttribute(name);
      }
      repositionTooltips(view);
    });
  view.contentDOM.addEventListener("keydown", keydown, true);
  return {
    update: position,
    destroy() {
      alive = false;
      view.contentDOM.removeEventListener("keydown", keydown, true);
    },
  };
});
