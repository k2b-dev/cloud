/**
 * Notebook glue around the shared @k2b/ui TextEditor. The shared engine owns the
 * view, table grid, paste and history routing; these extensions only adapt the
 * Notebook's reactive extensions, awareness and caret placement to it.
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
import { getSearchQuery, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { Compartment, type EditorState, type Extension } from "@codemirror/state";
import { type EditorView, getTooltip, repositionTooltips, showTooltip, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type TextEditorControls, tableHost } from "@k2b/ui/text-editor";
import { displayCell, findTables, gridLine, rowCount, type Table } from "@k2b/ui/text-editor/model";
import { createEffect, untrack } from "solid-js";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { resolveTextCursor } from "./relative-cursor";

/**
 * Reactive extensions as compartments of the one shared view. Each accessor
 * reconfigures only its own compartment. Add them while the owning component is
 * set up: their first run precedes the editor's mount, which reads `extension()`.
 * Later runs are effects, never nested in a CodeMirror update.
 */
export const createDynamicExtensions = () => {
  const slots: { compartment: Compartment; value: Extension }[] = [];
  let view: EditorView | undefined;
  return {
    add(extension: Extension | (() => Extension)) {
      const slot = { compartment: new Compartment(), value: [] as Extension };
      slots.push(slot);
      if (typeof extension !== "function") {
        slot.value = extension;
        return;
      }
      createEffect(() => {
        slot.value = extension();
        untrack(() => view?.dispatch({ effects: slot.compartment.reconfigure(slot.value) }));
      });
    },
    extension: (): Extension => slots.map((slot) => slot.compartment.of(slot.value)),
    attach(next: EditorView) {
      view = next;
    },
  };
};

const tables = new WeakMap<EditorState, Table[]>();
const tablesOf = (state: EditorState) => {
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

const gridCell = (view: EditorView, table: Table, row: number, column: number): HTMLElement | null => {
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

type Peer = { name: string; color: string };
const peerOf = (state: unknown): Peer | null => {
  if (!state || typeof state !== "object" || !("user" in state)) return null;
  const user: unknown = state.user;
  if (!user || typeof user !== "object" || !("name" in user) || !("color" in user)) return null;
  return typeof user.name === "string" && typeof user.color === "string" ? { name: user.name, color: user.color } : null;
};

/**
 * Marks the grid cell each current participant's caret is in with their name
 * and color. Carets live in awareness as Yjs relative positions, so a cell
 * follows concurrent edits; participants who leave or hide their caret drop out.
 */
export const tableCellPresence = (ytext: Y.Text, awareness: Awareness): Extension =>
  ViewPlugin.fromClass(
    class {
      marked = new Set<HTMLElement>();
      frame = 0;
      constructor(readonly view: EditorView) {
        awareness.on("change", this.schedule);
        this.schedule();
      }
      schedule = () => {
        if (!this.frame) this.frame = requestAnimationFrame(this.paint);
      };
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.schedule();
      }
      paint = () => {
        this.frame = 0;
        const doc = ytext.doc;
        if (!doc) return;
        const next = new Map<HTMLElement, Peer[]>();
        for (const [client, state] of awareness.getStates()) {
          const peer = peerOf(state);
          const cursor: unknown = state.cursor;
          if (client === doc.clientID || !peer || !cursor || typeof cursor !== "object" || !("head" in cursor)) continue;
          let head: number | null = null;
          try {
            const position = resolveTextCursor(ytext, cursor.head);
            if (position?.type === ytext) head = position.index;
          } catch {
            // Awareness can arrive before the document update it refers to.
          }
          if (head === null || head > this.view.state.doc.length) continue;
          const table = tableAround(this.view.state, head);
          const hit = table && cellAt(table, head);
          const cell = table && hit ? gridCell(this.view, table, hit.row, hit.column)?.parentElement : null;
          if (cell) next.set(cell, [...(next.get(cell) ?? []), peer]);
        }
        for (const cell of this.marked) {
          if (next.has(cell)) continue;
          cell.removeAttribute("data-peer");
          cell.style.removeProperty("--pc");
        }
        for (const [cell, peers] of next) {
          cell.setAttribute("data-peer", peers.map((peer) => peer.name).join(", "));
          cell.style.setProperty("--pc", peers[0]!.color);
        }
        this.marked = new Set(next.keys());
      };
      destroy() {
        awareness.off("change", this.schedule);
        cancelAnimationFrame(this.frame);
        for (const cell of this.marked) {
          cell.removeAttribute("data-peer");
          cell.style.removeProperty("--pc");
        }
      }
    },
  );

/** Block insertions such as attachments land after a table, never inside a row. */
export const outsideTable = (state: EditorState, pos: number): number => tableAround(state, pos)?.to ?? pos;

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

/** Notebook's existing inline shortcuts keep working inside shared table cells. */
export const cellFormattingKeys = (controls: () => TextEditorControls | undefined): Extension =>
  ViewPlugin.define((view) => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || !controls()?.tableActive()) return;
      const key = event.key.toLowerCase();
      const format =
        !event.shiftKey && key === "e"
          ? "code"
          : event.shiftKey && key === "s"
            ? "strike"
            : event.shiftKey && key === "h"
              ? { marker: "==" }
              : undefined;
      if (format && controls()?.formatCell(format)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    view.contentDOM.addEventListener("keydown", keydown, true);
    return { destroy: () => view.contentDOM.removeEventListener("keydown", keydown, true) };
  });

/** CodeMirror search still finds source ranges; expose those matches in the replaced grid cells. */
export const tableCellSearch: Extension = ViewPlugin.fromClass(
  class {
    marked = new Set<HTMLElement>();
    frame = 0;
    constructor(readonly view: EditorView) {
      view.contentDOM.addEventListener("keydown", this.keydown, true);
      this.schedule();
    }
    keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f")
        return;
      if (!(event.target instanceof HTMLElement) || !event.target.closest(".k2b-ste-cell")) return;
      if (openSearchPanel(this.view)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    schedule = () => {
      if (!this.frame) this.frame = requestAnimationFrame(this.paint);
    };
    update() {
      this.schedule();
    }
    paint = () => {
      this.frame = 0;
      for (const cell of this.marked) cell.classList.remove("cm-searchMatch", "cm-searchMatch-selected");
      this.marked.clear();
      const { state } = this.view;
      const query = getSearchQuery(state);
      if (!searchPanelOpen(state) || !query.valid) return;
      for (const table of tablesOf(state)) {
        for (let row = 0; row < rowCount(table); row++) {
          for (const [column, source] of (gridLine(table, row)?.cells ?? []).entries()) {
            const element = gridCell(this.view, table, row, column)?.parentElement;
            if (!element) continue;
            const matches = query.getCursor(state.doc, source.from, source.to);
            let found = false,
              selected = false;
            for (let next = matches.next(); !next.done; next = matches.next()) {
              found = true;
              if (state.selection.main.from === next.value.from && state.selection.main.to === next.value.to) selected = true;
            }
            if (found) {
              element.classList.add("cm-searchMatch");
              element.classList.toggle("cm-searchMatch-selected", selected);
              this.marked.add(element);
            }
          }
        }
      }
    };
    destroy() {
      cancelAnimationFrame(this.frame);
      this.view.contentDOM.removeEventListener("keydown", this.keydown, true);
      for (const cell of this.marked) cell.classList.remove("cm-searchMatch", "cm-searchMatch-selected");
    }
  },
);
