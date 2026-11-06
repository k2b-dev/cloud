/**
 * Notebook glue around the shared @k2b/ui TextEditor. The shared engine owns the
 * view, table grid, paste and history routing; these extensions only adapt the
 * Notebook's reactive extensions, awareness and caret placement to it.
 */
import { getSearchQuery, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { ViewPlugin } from "@codemirror/view";
import { cellAt, gridCell, tableAround, tablesOf } from "@k2b/editor";
import { resolveTextCursor } from "@k2b/editor/collab";
import type { TextEditorControls } from "@k2b/ui/text-editor";
import { gridLine, rowCount } from "@k2b/ui/text-editor/model";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

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
