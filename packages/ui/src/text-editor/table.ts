/**
 * Editable table grid for the formatted view.
 *
 * A Markdown table is replaced by a grid whose cells are small plain-text
 * editing surfaces. Typing in a cell turns into the minimal text change inside
 * that cell's Markdown range (see markdown-table.ts), so the stored format stays
 * Markdown and concurrent edits merge at character level.
 *
 * Rules that keep it stable:
 *  - the grid DOM is patched in place (`updateDOM`), never rebuilt while a cell
 *    has focus unless the shape changed;
 *  - the focused cell is never rewritten while an IME composition runs;
 *    remote text for that cell waits until `compositionend`;
 *  - every structural action is one transaction, so one undo step.
 */
import { history, historyKeymap, isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  type ChangeDesc,
  ChangeSet,
  Compartment,
  EditorState,
  type Extension,
  Facet,
  Prec,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, WidgetType } from "@codemirror/view";
import { convertClipboardHtml, inspectClipboard, parseClipboardHtml } from "./clipboard";
import { clipboardLoading } from "./clipboard-loading";
import { type InlineFormat, inlineFormat } from "./format";
import { markdownLanguage } from "./language";
import * as T from "./markdown-table";
import { textEditorMessages } from "./messages";

export type TableTarget = { tableFrom: number; rowFrom: number; columnFrom: number; row: number; column: number };
/** Resolve a server-returned identity against the current document immediately before focus. */
export type TableFocusTarget = () => TableTarget | null;
export type TableHost = {
  undo: () => void;
  redo: () => void;
  boundary: () => void;
  cellLabel: (row: number, column: number, name?: string) => string;
  sourceLabels?: () => {
    edit: string;
    valid: string;
    invalid: string;
    changed: string;
    structural: string;
    applying?: string;
    applyFailed?: string;
    done: string;
    discard: string;
    continue: string;
    line?: (line: number) => string;
    separator?: (header: number, separator: number) => string;
    extra?: (line: number) => string;
    complete?: string;
  };
  actionLabel?: (action: "rowMenu" | "columnMenu" | "addRow" | "addColumn" | "emptyCell") => string;
  /** Respect a host's personal Tab-for-focus preference inside cells too. */
  tabMovesFocus?: () => boolean;
  /** Capture durable anchors synchronously, then send the action to the owning server. */
  structure?: {
    available: () => boolean;
    perform: (action: MenuAction, target: TableTarget) => Promise<TableFocusTarget | void>;
    /** Resolves only after the confirmed update is applied; rejects without discarding the draft. */
    replaceSource?: (
      target: TableTarget,
      expected: string,
      source: string,
      caret: { row: number; column: number },
    ) => Promise<TableFocusTarget | void>;
  };
  onError: (code: "structureUnavailable" | "structureFailed" | "pasteTooLarge" | "textTooLarge" | "cellRemoved") => void;
  onRecovery: (text: string) => void;
  /** Cell focus is separate from CodeMirror contentDOM focus; collaboration maps these offsets to its own cursor. */
  onCellSelection?: (selection: { anchor: number; head: number } | null) => void;
  onDroppedImages?: (count: number, files: File[]) => void;
  maxLength: number;
  maxPasteCells: number;
  /** App-owned presentation, e.g. formula results. Called only outside the active cell. */
  renderCell?: (element: HTMLElement, raw: string, table: T.Table, row: number, column: number) => void;
};
export type MenuAction =
  | "completeColumns"
  | "rowAbove"
  | "rowBelow"
  | "colLeft"
  | "colRight"
  | "deleteRow"
  | "deleteCol"
  | "moveRowUp"
  | "moveRowDown"
  | "moveColLeft"
  | "moveColRight"
  | "toggleHeader"
  | "deleteTable"
  | "alignLeft"
  | "alignCenter"
  | "alignRight";

export const tableHost = Facet.define<TableHost, TableHost | null>({ combine: (v) => v[0] ?? null });

type Active = { index: number; r: number; c: number; composing: boolean };
const active = new WeakMap<EditorView, Active>();
const pendingContextMenus = new WeakMap<EditorView, AbortController>();

/**
 * What the focused cell's DOM was last synced to: the cell text and its start
 * in the document, plus every document change since. A commit diffs the DOM
 * against `base` and maps the result through `desc`, so text that other
 * people typed meanwhile (during an IME composition, for example) survives.
 */
type Sync = {
  el: HTMLElement;
  baseFrom: number;
  base: string;
  desc: ChangeDesc;
  committing: boolean;
  refocusSelection: [number, number] | null;
  selection?: [number, number];
  edges: number[];
};
const syncs = new WeakMap<EditorView, Sync>();
// An unmaterialized ragged cell has no source identity yet. Never infer its
// baseline from a later numeric position after another transaction changes it.
const missingCells = new WeakMap<EditorView, { el: HTMLElement; changed: boolean }>();
const rebuilding = new WeakSet<EditorView>();
/** A structural action that moves focus itself; a rebuild then does not restore the old caret. */
const targeted = new WeakSet<EditorView>();
const refreshTables = StateEffect.define<null>();

// Browsers write a trailing or doubled space as U+00A0; a typed no-break space between words stays.

const parsedTables = new WeakMap<EditorState, T.Table[]>();
export const tablesIn = (state: EditorState): T.Table[] => {
  const cached = parsedTables.get(state);
  if (cached) return cached;
  const tables = T.findTables(state.doc.toString());
  parsedTables.set(state, tables);
  return tables;
};

const currentTable = (view: EditorView, dom: HTMLElement): T.Table | null => {
  if (!dom.isConnected || !view.dom.contains(dom)) return null;
  const pos = view.posAtDOM(dom);
  return tablesIn(view.state).find((t) => pos >= t.from && pos <= t.to) ?? null;
};
const tableIndex = (view: EditorView, dom: HTMLElement): number => {
  if (!dom.isConnected || !view.dom.contains(dom)) return -1;
  const pos = view.posAtDOM(dom);
  return tablesIn(view.state).findIndex((t) => pos >= t.from && pos <= t.to);
};
/** The grid element of the n-th table, looked up again: CodeMirror may have replaced it. */
const findWrap = (view: EditorView, index: number): HTMLElement | null =>
  [...view.contentDOM.querySelectorAll<HTMLElement>(".k2b-ste-table")].find((el) => tableIndex(view, el) === index) ?? null;

type Hit = { table: T.Table; r: number; c: number; cell: T.Cell };
const cellAtPos = (state: EditorState, pos: number): Hit | null => {
  for (const table of tablesIn(state)) {
    if (pos < table.from || pos > table.to) continue;
    for (let r = 0; r < T.rowCount(table); r++) {
      const line = T.gridLine(table, r)!;
      if (pos < line.from || pos > line.to) continue;
      const before = line.pipes.filter((p) => p < pos).length;
      const c = Math.max(0, Math.min(line.cells.length - 1, line.leadingPipe ? before - 1 : before));
      const cell = line.cells[c];
      return cell ? { table, r, c, cell } : null;
    }
  }
  return null;
};

const cellSurvives = (sync: Sync): boolean => {
  const survived = new Set<number>();
  sync.desc.iterGaps((from, _newFrom, length) => {
    for (const edge of sync.edges) if (edge >= from && edge < from + length) survived.add(edge);
  });
  return survived.size === sync.edges.length;
};

const resync = (view: EditorView, el: HTMLElement, cell: T.Cell) => {
  const hit = cellAtPos(view.state, cell.from);
  const line = hit && T.gridLine(hit.table, hit.r);
  const edges: number[] = [];
  if (line && hit) {
    const left = line.leadingPipe ? line.pipes[hit.c] : hit.c === 0 ? line.from - 1 : line.pipes[hit.c - 1];
    const right = (line.leadingPipe ? line.pipes[hit.c + 1] : line.pipes[hit.c]) ?? line.to;
    if (left !== undefined && left >= 0) edges.push(left);
    if (right < view.state.doc.length) edges.push(right);
  }
  syncs.set(view, {
    el,
    baseFrom: cell.from,
    base: cell.text,
    desc: ChangeSet.empty(view.state.doc.length).desc,
    committing: false,
    refocusSelection: null,
    edges,
  });
};

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[ch]};`);
/** Render the same Markdown tokens as prose, keeping code and escaped markers literal. */
const renderInline = (raw: string) => {
  const text = raw;
  const tree = markdownLanguage.parser.parse(text);
  const render = (node: typeof tree.topNode): string => {
    const tags: Record<string, [string, string, string[]]> = {
      StrongEmphasis: ["<strong>", "</strong>", ["EmphasisMark"]],
      Emphasis: ["<em>", "</em>", ["EmphasisMark"]],
      Strikethrough: ["<s>", "</s>", ["StrikethroughMark"]],
      InlineCode: ['<code class="k2b-ste-code">', "</code>", ["CodeMark"]],
      Link: ['<span class="k2b-ste-link">', "</span>", ["LinkMark", "URL", "LinkTitle"]],
    };
    if (node.name === "Escape") return escapeHtml(text.slice(node.from + 1, node.to));
    const spec = tags[node.name];
    let result = spec?.[0] ?? "";
    let from = node.from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      result += escapeHtml(node.name === "InlineCode" ? T.displayCell(text.slice(from, child.from)) : text.slice(from, child.from));
      if (!spec?.[2].includes(child.name)) result += render(child);
      from = child.to;
    }
    const tail = text.slice(from, node.to);
    return result + escapeHtml(node.name === "InlineCode" ? T.displayCell(tail) : tail) + (spec?.[1] ?? "");
  };
  return render(tree.topNode);
};

const renderCell = (view: EditorView, element: HTMLElement, raw: string, table: T.Table, row: number, column: number) => {
  const render = view.state.facet(tableHost)?.renderCell;
  if (render) render(element, raw, table, row, column);
  else element.innerHTML = renderInline(raw);
};

const cellAt = (dom: HTMLElement, r: number, c: number) => dom.querySelector<HTMLElement>(`.k2b-ste-cell[data-r="${r}"][data-c="${c}"]`);

const caretOffset = (el: HTMLElement): number => {
  const sel = el.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return el.textContent?.length ?? 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.anchorNode!, sel.anchorOffset);
  return range.toString().length;
};
const selectionOffsets = (el: HTMLElement): [number, number] => {
  const selection = el.ownerDocument.getSelection();
  const offset = (node: Node | null, at: number) => {
    if (!node || !el.contains(node)) return caretOffset(el);
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    range.setEnd(node, at);
    return range.toString().length;
  };
  return [
    offset(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0),
    offset(selection?.focusNode ?? null, selection?.focusOffset ?? 0),
  ];
};

const placeSelection = (el: HTMLElement, anchor: number, head = anchor) => {
  el.focus({ preventScroll: true });
  const selection = el.ownerDocument.getSelection();
  const text = el.firstChild;
  if (!selection) return;
  if (text?.nodeType === Node.TEXT_NODE) {
    const length = text.textContent?.length ?? 0;
    selection.setBaseAndExtent(text, Math.max(0, Math.min(anchor, length)), text, Math.max(0, Math.min(head, length)));
  } else selection.setBaseAndExtent(el, 0, el, 0);
};
const placeCaret = (el: HTMLElement, offset: number) => placeSelection(el, offset);

const hasHeader = (t: T.Table) => t.lines[0]!.cells.some((cell) => cell.text.length > 0);
const firstRow = (t: T.Table) => (hasHeader(t) ? 0 : 1);
const shapeOf = (t: T.Table) => `${T.rowCount(t)}x${width(t)}:${firstRow(t)}`;
const renderedDocuments = new WeakMap<HTMLElement, Text>();
const measureScroll = (view: EditorView, wrap: HTMLElement) =>
  view.requestMeasure({
    key: wrap,
    read: () => ({ left: wrap.scrollLeft, width: wrap.clientWidth, total: wrap.scrollWidth }),
    write: ({ left, width, total }) => {
      if (!wrap.isConnected) return;
      wrap.toggleAttribute("data-scrolled", left > 0);
      wrap.toggleAttribute("data-more", left + width < total - 1);
    },
  });

class GridWidget extends WidgetType {
  constructor(
    readonly table: T.Table,
    readonly readOnly: boolean,
  ) {
    super();
  }
  // Always update the existing DOM on document/refresh transactions. A shape
  // deferred during composition must be patched even when the next table value
  // is equal; app-owned formulas may also depend on cells outside this table.
  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "k2b-ste-table";
    wrap.contentEditable = "false";
    wrap.dataset.shape = shapeOf(this.table);
    wrap.append(buildGrid(view, this.table, wrap));
    wrap.addEventListener("pointerleave", () => {
      wrap.querySelectorAll<HTMLElement>(".k2b-ste-columnMenu").forEach((grip) => delete grip.dataset.hovered);
    });
    wrap.addEventListener("scroll", () => {
      wrap.toggleAttribute("data-scrolled", wrap.scrollLeft > 0);
      wrap.toggleAttribute("data-more", wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1);
    });
    renderedDocuments.set(wrap, view.state.doc);
    setEditable(wrap, !this.readOnly, view);
    measureScroll(view, wrap);
    return wrap;
  }
  override updateDOM(dom: HTMLElement, view: EditorView) {
    const act = active.get(view);
    measureScroll(view, dom);
    if (dom.dataset.shape !== shapeOf(this.table)) {
      const focused = dom.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
      // Never rebuild under a running IME composition; the commit at compositionend refreshes.
      if (focused && act?.composing) {
        dom.dataset.pendingShape = "1";
        return true;
      }
      const sync = syncs.get(view);
      if (focused && sync?.el === focused && !targeted.has(view)) sync.refocusSelection = selectionOffsets(focused);
      dom.dataset.shape = shapeOf(this.table);
      delete dom.dataset.pendingShape;
      rebuilding.add(view);
      const source = sources.get(dom)?.element;
      if (source) {
        // Keep the draft editor connected while the confirmed grid changes.
        // Detaching it loses native focus before its receipt can return the
        // caret to the cell selected in the draft.
        for (const child of [...dom.childNodes]) if (child !== source) child.remove();
        dom.insertBefore(buildGrid(view, this.table, dom), source);
      } else dom.replaceChildren(buildGrid(view, this.table, dom));
      renderedDocuments.set(dom, view.state.doc);
      rebuilding.delete(view);
      setEditable(dom, !this.readOnly, view);
      dom.dispatchEvent(
        new CustomEvent("k2b-ste-table-structure", {
          bubbles: true,
          detail: { rows: T.rowCount(this.table), columns: this.table.columns },
        }),
      );
      return true;
    }
    // Host formulas depend on document changes, not selection-only effects.
    // Replacing an inactive cell's descendants during pointerdown removes the
    // click target before the browser focuses it and can select the whole note.
    const refreshPresentation = renderedDocuments.get(dom) !== view.state.doc;
    patchGrid(view, this.table, dom, refreshPresentation);
    renderedDocuments.set(dom, view.state.doc);
    setEditable(dom, !this.readOnly, view);
    return true;
  }
  override destroy(dom: HTMLElement) {
    const source = sources.get(dom);
    if (source) {
      const draft = source.editor.state.doc.toString();
      if (draft !== source.base) queueMicrotask(() => source.recover(draft));
      source.cleanup();
      source.editor.destroy();
      sources.delete(dom);
    }
  }
  override ignoreEvent() {
    return true;
  }
  override get estimatedHeight() {
    return (T.rowCount(this.table) - firstRow(this.table)) * 41 + 16;
  }
}

type SourceSession = {
  element: HTMLElement;
  editor: EditorView;
  base: string;
  recover: (text: string) => void;
  readOnly: Compartment;
  cleanup: () => void;
  pending: boolean;
};
const sources = new WeakMap<HTMLElement, SourceSession>();

/** A local source draft for one table. Invalid drafts never replace shared text.
 * Collaborative structure changes require the host's confirmed anchored action. */
export const editTableSource = (view: EditorView, wrap: HTMLElement) => {
  const table = currentTable(view, wrap);
  if (!table || view.state.readOnly || sources.has(wrap)) return;
  const host = view.state.facet(tableHost);
  const en = textEditorMessages.resolve(["en"]).t;
  const labels = host?.sourceLabels?.() ?? {
    edit: en.editMarkdown,
    valid: en.markdownValid,
    invalid: en.markdownInvalid,
    changed: en.markdownChanged,
    structural: en.markdownStructural,
    done: en.showTable,
    discard: en.discardMarkdown,
    continue: en.continueMarkdown,
    line: en.markdownLine,
    separator: (header, separator) => en.markdownSeparator({ header, separator }),
    extra: en.markdownExtra,
    complete: en.completeColumns,
  };
  const base = view.state.sliceDoc(table.from, table.to);
  const original = active.get(view);
  const originalCell = original && T.gridLine(table, original.r)?.cells[original.c];
  const overlay = document.createElement("div");
  overlay.className = "k2b-ste-table-source";
  const bar = document.createElement("div");
  bar.className = "k2b-ste-source-bar";
  const status = document.createElement("span");
  status.textContent = labels.valid;
  status.setAttribute("role", "status");
  const body = document.createElement("div");
  body.className = "k2b-ste-source-body";
  const error = document.createElement("div");
  error.className = "k2b-ste-source-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const button = (label: string, run: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.onclick = run;
    return element;
  };
  const close = (r: number, c: number, changed: number[] = [], restoreFocus = true) => {
    sources.get(wrap)?.cleanup();
    sources.delete(wrap);
    source.destroy();
    overlay.remove();
    delete wrap.dataset.source;
    wrap.style.removeProperty("height");
    const current = currentTable(view, wrap);
    if (current && restoreFocus)
      move(view, wrap, Math.max(firstRow(current), Math.min(r, T.rowCount(current) - 1)), Math.min(c, current.columns - 1));
    wrap
      .querySelectorAll<HTMLElement>("tr")
      .forEach((row) => row.toggleAttribute("data-source-changed", changed.includes(Number(row.dataset.r))));
  };
  const fail = (message: string, line?: number, complete?: () => void, focus = true) => {
    error.hidden = false;
    error.dataset.tone = complete ? "warning" : "error";
    status.textContent = labels.edit;
    const selectLine = () => {
      const target = source.state.doc.line(Math.min(line ?? 1, source.state.doc.lines));
      source.dispatch({ selection: { anchor: target.from, head: target.to }, scrollIntoView: true });
      source.focus();
    };
    error.replaceChildren(
      document.createTextNode(`${complete || line === undefined ? "" : (labels.line?.(line) ?? en.markdownLine(line))}${message}`),
      ...(complete ? [button(labels.complete ?? en.completeColumns, complete)] : []),
      button(labels.continue, selectLine),
      button(labels.discard, () => close(original?.r ?? 0, original?.c ?? 0)),
    );
    if (focus) source.focus();
  };
  const parsed = () => {
    const draft = source.state.doc.toString();
    const tables = T.findTables(draft);
    const next = tables[0];
    return next &&
      tables.length === 1 &&
      next.from === 0 &&
      next.to === draft.length &&
      !T.inspectTableStructure(draft).extraCells &&
      !T.inspectTableStructure(draft).missingSeparator
      ? next
      : null;
  };
  const apply = (): void => {
    if (view.state.readOnly || sources.get(wrap)?.pending) return;
    const current = currentTable(view, wrap);
    const draft = source.state.doc.toString();
    const candidate = T.findTables(draft)[0];
    const extra = candidate?.lines.find((line) => line.cells.length > candidate.columns);
    if (candidate && candidate.from === 0 && candidate.to === draft.length && extra) {
      const line = source.state.doc.lineAt(extra.from).number;
      return fail(labels.extra?.(line) ?? en.markdownExtra(line), line, () => {
        source.dispatch({ changes: T.completeColumns(candidate) });
        apply();
      });
    }
    const next = parsed();
    if (!next) {
      // Count source cells for diagnostics only; the public GFM parser remains
      // the authority for whether this draft can replace a table.
      const split = (text: string) => {
        const cells = [""];
        for (let index = 0; index < text.length; index++) {
          const char = text[index]!;
          if (char === "\\" && index + 1 < text.length) cells[cells.length - 1] += char + text[++index];
          else if (char === "|") cells.push("");
          else cells[cells.length - 1] += char;
        }
        if (cells.length > 1 && !cells[0]!.trim()) cells.shift();
        if (cells.length > 1 && !cells.at(-1)!.trim()) cells.pop();
        return cells.map((cell) => cell.trim());
      };
      if (source.state.doc.lines > 1) {
        const header = split(source.state.doc.line(1).text),
          separator = split(source.state.doc.line(2).text);
        if (separator.every((cell) => /^:?-+:?$/.test(cell)) && header.length !== separator.length)
          return fail(
            labels.separator?.(header.length, separator.length) ??
              en.markdownSeparator({ header: header.length, separator: separator.length }),
            2,
          );
        if (!separator.every((cell) => /^:?-+:?$/.test(cell))) return fail(labels.invalid, 2);
      }
      return fail(labels.invalid, candidate ? source.state.doc.lineAt(Math.min(candidate.to + 1, draft.length)).number : 1);
    }
    if (!current || view.state.sliceDoc(current.from, current.to) !== base) return fail(labels.changed);
    let changes: T.Change[] = [];
    let structural = false;
    if (host?.structure) {
      structural =
        shapeOf(current) !== shapeOf(next) ||
        view.state.sliceDoc(current.lines[1]!.from, current.lines[1]!.to) !== source.state.sliceDoc(next.lines[1]!.from, next.lines[1]!.to);
      if (!structural) {
        for (let r = 0; r < T.rowCount(next); r++) {
          const old = T.gridLine(current, r)!;
          const row = T.gridLine(next, r)!;
          for (let c = 0; c < next.columns; c++) {
            const before = old.cells[c],
              after = row.cells[c];
            if (!before || !after) {
              structural = true;
              break;
            }
            if (before.text !== after.text) changes.push(...T.cellChanges(before.text, T.displayCell(after.text), before.from));
          }
        }
        // Formatting pipes and padding is structural even when dimensions match.
        structural ||=
          T.applyChanges(
            base,
            changes.map((change) => ({
              ...change,
              from: change.from - current.from,
              to: change.to - current.from,
            })),
          ) !== draft;
      }
    } else changes = [{ from: current.from, to: current.to, insert: draft }];
    const hit = cellAtPos(EditorState.create({ doc: source.state.doc }), source.state.selection.main.head);
    const changed = Array.from({ length: T.rowCount(next) }, (_, row) => row).filter((row) => {
      const before = T.gridLine(current, row),
        after = T.gridLine(next, row);
      return !before || !after || view.state.sliceDoc(before.from, before.to) !== source.state.sliceDoc(after.from, after.to);
    });
    if (structural) {
      const structure = host?.structure;
      if (!structure?.replaceSource) return fail(labels.structural);
      if (!structure.available()) {
        host?.onError("structureUnavailable");
        return;
      }
      const session = sources.get(wrap)!;
      session.pending = true;
      // Keep native focus on the action while waiting. Disabling a focused
      // button blurs it to body, losing the draft's focus ownership on receipt.
      // The pending guard above prevents keyboard and pointer resubmission.
      done.setAttribute("aria-disabled", "true");
      overlay.setAttribute("aria-busy", "true");
      status.textContent = labels.applying ?? en.applyingTable;
      source.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(true)) });
      // The host captures the table witnesses synchronously, before any await.
      const target = {
        tableFrom: current.from,
        rowFrom: current.lines[0]!.from,
        columnFrom: current.lines[0]!.cells[0]!.from,
        row: 0,
        column: 0,
      };
      const settled = () => {
        if (sources.get(wrap) !== session) return false;
        session.pending = false;
        done.removeAttribute("aria-disabled");
        overlay.removeAttribute("aria-busy");
        source.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(view.state.readOnly)) });
        return true;
      };
      try {
        void structure.replaceSource(target, base, draft, { row: hit?.r ?? 0, column: hit?.c ?? 0 }).then(
          (resolve) => {
            if (settled()) {
              const restoreFocus = overlay.contains(view.dom.ownerDocument.activeElement);
              close(0, 0, changed, false);
              if (restoreFocus && resolve) focusTableTarget(view, resolve());
            }
          },
          () => {
            if (settled())
              fail(
                labels.applyFailed ?? en.markdownApplyFailed,
                undefined,
                undefined,
                overlay.contains(view.dom.ownerDocument.activeElement),
              );
          },
        );
      } catch {
        if (settled()) fail(labels.applyFailed ?? en.markdownApplyFailed);
      }
      return;
    }
    if (changes.length && !dispatchChanges(view, changes, true)) return;
    close(hit?.r ?? original?.r ?? 0, hit?.c ?? original?.c ?? 0, changed);
  };
  const readOnly = new Compartment();
  const source = new EditorView({
    parent: body,
    state: EditorState.create({
      doc: base,
      selection: { anchor: Math.max(0, (originalCell?.from ?? table.from) - table.from) },
      extensions: [
        readOnly.of(EditorState.readOnly.of(false)),
        history(),
        keymap.of([
          {
            key: "Escape",
            run: () => {
              apply();
              return true;
            },
          },
          ...historyKeymap,
        ]),
        EditorView.contentAttributes.of({ "aria-label": labels.edit }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            status.textContent = parsed() ? labels.valid : labels.invalid;
            error.hidden = true;
          }
        }),
      ],
    }),
  });
  const done = button(labels.done, apply);
  done.className = "k2b-button";
  done.dataset.size = "sm";
  bar.append(status, done);
  overlay.append(bar, body, error);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (source.state.doc.toString() === base) return;
    event.preventDefault();
    event.returnValue = "";
  };
  view.dom.ownerDocument.defaultView?.addEventListener("beforeunload", beforeUnload);
  sources.set(wrap, {
    element: overlay,
    pending: false,
    editor: source,
    base,
    readOnly,
    recover: (text) => host?.onRecovery(text),
    cleanup: () => view.dom.ownerDocument.defaultView?.removeEventListener("beforeunload", beforeUnload),
  });
  wrap.style.height = `${wrap.getBoundingClientRect().height}px`;
  wrap.dataset.source = "1";
  wrap.querySelectorAll("tr").forEach((row) => row.removeAttribute("data-source-changed"));
  wrap.append(overlay);
  source.focus();
};

const setEditable = (wrap: HTMLElement, on: boolean, view: EditorView) => {
  wrap.dataset.readonly = on ? "0" : "1";
  const source = sources.get(wrap);
  if (source && source.editor.state.readOnly !== (!on || source.pending))
    source.editor.dispatch({ effects: source.readOnly.reconfigure(EditorState.readOnly.of(!on || source.pending)) });
  wrap.querySelectorAll<HTMLButtonElement>(".k2b-ste-grip, .k2b-ste-table-add button").forEach((button) => {
    const structure = view.state.facet(tableHost)?.structure;
    button.disabled = !on || (button.classList.contains("k2b-ste-addColumn") && !!structure && !structure.available());
    button.hidden = !on;
  });
  wrap.querySelector("table")?.setAttribute("aria-readonly", String(!on));
  wrap.querySelectorAll<HTMLElement>(".k2b-ste-cell").forEach((cell) => {
    cell.setAttribute("aria-readonly", String(!on));
    if (!on) {
      cell.contentEditable = "false";
      // Losing edit access must restore presentation and detach the mutable
      // cell baseline before later remote updates reconcile the document.
      if (cell.dataset.editing === "1") {
        cell.dataset.editing = "0";
        const table = currentTable(view, wrap);
        if (table) renderCell(view, cell, cell.dataset.raw ?? "", table, Number(cell.dataset.r), Number(cell.dataset.c));
      }
      if (syncs.get(view)?.el === cell) syncs.delete(view);
      if (missingCells.get(view)?.el === cell) missingCells.delete(view);
    } else {
      const wasReadOnly = cell.contentEditable === "false";
      cell.contentEditable = "plaintext-only";
      if (cell.contentEditable !== "plaintext-only") cell.contentEditable = "true";
      // Regaining access while this cell still has focus must enter editing
      // through the same handler as a click, before typing can replace a result.
      if (wasReadOnly && cell === cell.ownerDocument.activeElement) {
        cell.blur();
        cell.focus({ preventScroll: true });
      }
    }
  });
};

/** Grid width: the widest row, so text beyond the header's columns stays visible (never hidden). */
const width = (t: T.Table) => t.lines.reduce((width, line) => Math.max(width, line.cells.length), t.columns);
const cells = (t: T.Table) => {
  const columns = width(t);
  return Array.from({ length: T.rowCount(t) }, (_, r) => Array.from({ length: columns }, (_, c) => T.gridLine(t, r)?.cells[c]?.text ?? ""));
};

const focusCell = (el: HTMLElement, offset: number) => {
  el.dataset.editing = "1";
  el.textContent = T.displayCell(el.dataset.raw ?? "");
  placeCaret(el, offset);
};

const buildGrid = (view: EditorView, t: T.Table, wrap: HTMLElement) => {
  const table = document.createElement("table");
  const grid = cells(t);
  wrap.dataset.header = String(hasHeader(t));
  grid.forEach((row, r) => {
    if (r < firstRow(t)) return;
    const tr = document.createElement("tr");
    tr.dataset.r = String(r);
    row.forEach((raw, c) => {
      const td = document.createElement(r === 0 ? "th" : "td");
      td.style.textAlign = t.align[c] ?? "left";
      // A cell beyond the header's columns: email renderers drop it, so it is marked for review.
      if (c >= t.columns && (T.gridLine(t, r)?.cells.length ?? 0) > c) td.dataset.extra = "1";
      const cell = document.createElement("div");
      cell.className = "k2b-ste-cell";
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.dataset.raw = raw;
      cell.contentEditable = "plaintext-only";
      if (cell.contentEditable !== "plaintext-only") cell.contentEditable = "true";
      cell.spellcheck = true;
      cell.tabIndex = -1;
      cell.setAttribute("role", "textbox");
      cell.setAttribute(
        "aria-label",
        view.state.facet(tableHost)?.cellLabel(r, c, T.displayCell(grid[0]?.[c] ?? "")) ?? `${r + 1}, ${c + 1}`,
      );
      if (r === 1 && c === 0 && !raw)
        cell.dataset.placeholder = view.state.facet(tableHost)?.actionLabel?.("emptyCell") ?? "Type or paste cells";
      renderCell(view, cell, raw, t, r, c);
      wire(view, cell, wrap);
      td.setAttribute("role", r === 0 ? "columnheader" : "gridcell");
      td.append(cell);
      const grip = (kind: "rowMenu" | "columnMenu") => {
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.className = `k2b-ste-grip k2b-ste-${kind}`;
        button.setAttribute(
          "aria-label",
          view.state.facet(tableHost)?.actionLabel?.(kind) ?? (kind === "rowMenu" ? "Row menu" : "Column menu"),
        );
        button.setAttribute("aria-haspopup", "menu");
        button.innerHTML = '<i class="ti ti-grip-vertical" aria-hidden="true"></i>';
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          cell.focus({ preventScroll: true });
          wrap.dispatchEvent(new CustomEvent("k2b-ste-cell-menu", { bubbles: true, detail: { cell, anchor: button } }));
        };
        td.append(button);
      };
      if (c === 0) grip("rowMenu");
      if (r === firstRow(t)) grip("columnMenu");
      tr.append(td);
    });
    tr.setAttribute("role", "row");
    table.append(tr);
  });
  table.setAttribute("role", "grid");
  // Exactly one grid entry point; internal movement uses the cell keys.
  const first = table.querySelector<HTMLElement>(".k2b-ste-cell");
  if (first) first.tabIndex = 0;
  const footer = document.createElement("div");
  footer.className = "k2b-ste-table-add";
  for (const action of ["addRow", "addColumn"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `k2b-ste-${action}`;
    const label = view.state.facet(tableHost)?.actionLabel?.(action) ?? (action === "addRow" ? "Row" : "Column");
    button.textContent = action === "addRow" ? `+ ${label}` : "+";
    if (action === "addColumn") button.setAttribute("aria-label", label);
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => {
      const current = currentTable(view, wrap);
      if (current)
        runTableAction(view, current.from, T.rowCount(current) - 1, current.columns - 1, action === "addRow" ? "rowBelow" : "colRight");
    };
    footer.append(button);
  }
  const fragment = document.createDocumentFragment();
  fragment.append(table, footer);
  return fragment;
};

const patchGrid = (view: EditorView, t: T.Table, dom: HTMLElement, refreshPresentation: boolean) => {
  const grid = cells(t);
  dom.querySelectorAll<HTMLElement>(".k2b-ste-cell").forEach((el) => {
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    const raw = grid[r]?.[c] ?? "";
    const parent = el.parentElement as HTMLElement;
    parent.style.textAlign = t.align[c] ?? "left";
    el.setAttribute("aria-label", view.state.facet(tableHost)?.cellLabel(r, c, T.displayCell(grid[0]?.[c] ?? "")) ?? `${r + 1}, ${c + 1}`);
    if (c >= t.columns && (T.gridLine(t, r)?.cells.length ?? 0) > c) parent.dataset.extra = "1";
    else delete parent.dataset.extra;
    if (el.dataset.raw === raw && !(refreshPresentation && view.state.facet(tableHost)?.renderCell)) return;
    el.dataset.raw = raw;
    if (el.dataset.editing === "1") {
      // The focused cell is refreshed after the update, with mapped caret (see `followChanges`).
      el.dataset.stale = "1";
      return;
    }
    renderCell(view, el, raw, t, r, c);
  });
};

const dispatchChanges = (view: EditorView, changes: T.Change[], structural = false, selection?: { anchor: number; head: number }) => {
  if (!changes.length || view.state.readOnly) return false;
  const length = view.state.doc.length + changes.reduce((n, c) => n + c.insert.length - (c.to - c.from), 0);
  if (length > (view.state.facet(tableHost)?.maxLength ?? Infinity)) {
    view.state.facet(tableHost)?.onError("textTooLarge");
    return false;
  }
  const host = view.state.facet(tableHost);
  if (structural) host?.boundary();
  if (structural) targeted.add(view);
  try {
    view.dispatch({
      changes: [...changes].sort((a, b) => a.from - b.from).map((change) => ({ ...change, insert: Text.of(change.insert.split("\n")) })),
      selection,
      annotations: structural ? isolateHistory.of("full") : undefined,
      userEvent: structural ? "input.table.structure" : "input.type.table",
    });
  } finally {
    targeted.delete(view);
  }
  if (structural) host?.boundary();
  return true;
};

const recoverMissingCell = (view: EditorView, el: HTMLElement) => {
  const input = el.textContent ?? "";
  if (input) view.state.facet(tableHost)?.onRecovery(input);
  view.state.facet(tableHost)?.onError("cellRemoved");
  el.dataset.editing = "0";
  const wrap = el.closest<HTMLElement>(".k2b-ste-table");
  const table = wrap && currentTable(view, wrap);
  if (table) renderCell(view, el, el.dataset.raw ?? "", table, Number(el.dataset.r), Number(el.dataset.c));
  el.blur();
};

const commitCell = (view: EditorView, el: HTMLElement, wrap: HTMLElement) => {
  const missing = missingCells.get(view);
  if (missing?.el === el && missing.changed) {
    recoverMissingCell(view, el);
    return;
  }
  let sync = syncs.get(view);
  if (!sync || sync.el !== el) {
    const t = currentTable(view, wrap);
    const cell = t && T.gridLine(t, Number(el.dataset.r))?.cells[Number(el.dataset.c)];
    if (!cell) {
      if (!t || view.state.readOnly) {
        const host = view.state.facet(tableHost);
        host?.onRecovery(el.textContent ?? "");
        if (!t) host?.onError("cellRemoved");
        return;
      }
      const row = Number(el.dataset.r),
        column = Number(el.dataset.c);
      const changes = T.setCellText(t, row, column, T.escapeCell(el.textContent ?? ""));
      missingCells.delete(view);
      if (!dispatchChanges(view, changes)) {
        view.state.facet(tableHost)?.onRecovery(el.textContent ?? "");
        el.textContent = "";
        return;
      }
      const updated = tablesIn(view.state).find((table) => table.from === t.from);
      const created = updated && T.gridLine(updated, row)?.cells[column];
      if (created) {
        resync(view, el, created);
        el.dataset.raw = created.text;
      }
      return;
    }
    resync(view, el, cell);
    sync = syncs.get(view)!;
  }
  const next = (el.textContent ?? "").replace(/\u00a0(?=\s|$)|(?<=\s|^)\u00a0/g, " ");
  const mappedFrom = sync.desc.mapPos(sync.baseFrom, 1);
  const hit = cellAtPos(view.state, mappedFrom);
  if (!cellSurvives(sync) || !hit) {
    const host = view.state.facet(tableHost);
    host?.onRecovery(next);
    host?.onError("cellRemoved");
    syncs.delete(view);
    view.dispatch({ effects: refreshTables.of(null) });
    return;
  }
  const changes = T.mappedCellChanges(sync.base, next, sync.baseFrom, sync.desc);
  if (!changes.length) {
    // A cancelled composition still needs to reveal remote changes and shape updates.
    view.dispatch({ effects: refreshTables.of(null) });
    return;
  }
  const set = ChangeSet.of(changes, view.state.doc.length);
  const from = set.mapPos(sync.desc.mapPos(sync.baseFrom, -1), -1);
  const to = set.mapPos(sync.desc.mapPos(sync.baseFrom + sync.base.length, 1), 1);
  const [anchorOffset, headOffset] = selectionOffsets(el);
  const localChanges = T.cellChanges(sync.base, next, sync.baseFrom);
  const localSet = ChangeSet.of(localChanges, sync.desc.length);
  const localRaw = T.applyChanges(
    sync.base,
    localChanges.map((change) => ({ ...change, from: change.from - sync.baseFrom, to: change.to - sync.baseFrom })),
  );
  const localMap = T.cellDisplayMap(localRaw);
  const remoteAfterLocal = sync.desc.mapDesc(localSet.desc);
  const position = (offset: number) =>
    remoteAfterLocal.mapPos(localSet.mapPos(sync.baseFrom, -1) + (localMap.offsets[offset] ?? localRaw.length), 1);
  const selection = { anchor: position(anchorOffset), head: position(headOffset) };
  sync.committing = true;
  const accepted = dispatchChanges(view, changes, false, selection);
  sync.committing = false;
  if (!accepted) {
    view.state.facet(tableHost)?.onRecovery(next);
    el.textContent = T.displayCell(sync.base);
    view.dispatch({ effects: refreshTables.of(null) });
    return;
  }
  // Keep the focused input's full extent, including a just-typed trailing space.
  // The Markdown parser trims padding and cannot distinguish it from that space.
  const raw = view.state.sliceDoc(from, to);
  const current = cellAtPos(view.state, from);
  const index = current ? tablesIn(view.state).findIndex((table) => table.from === current.table.from) : -1;
  const currentWrap = findWrap(view, index);
  const target = current && currentWrap && cellAt(currentWrap, current.r, current.c);
  if (!target) {
    syncs.delete(view);
    return;
  }
  // Composition deferred reconciliation. Even a connected element may now
  // occupy another column after a same-size structural edit.
  if (target !== el) {
    if (el.isConnected) {
      el.dataset.editing = "0";
      const oldTable = currentTable(view, wrap);
      if (oldTable) renderCell(view, el, el.dataset.raw ?? "", oldTable, Number(el.dataset.r), Number(el.dataset.c));
    }
    focusCell(target, 0);
  }
  target.dataset.raw = raw;
  target.dataset.stale = "0";
  resync(view, target, { from, to, text: raw });
  const shown = T.displayCell(raw);
  if (((target.textContent ?? "") !== shown || target !== el) && !active.get(view)?.composing) {
    target.textContent = shown;
    placeSelection(
      target,
      T.displayCell(view.state.sliceDoc(from, selection.anchor)).length,
      T.displayCell(view.state.sliceDoc(from, selection.head)).length,
    );
  }
  if (wrap.dataset.pendingShape === "1") view.dispatch({ effects: refreshTables.of(null) });
  queueCellSelection(view, target);
};

/** After every update: track changes for the focused cell, refresh it, or refocus it after a rebuild. */
const followChanges = EditorView.updateListener.of((update) => {
  const view = update.view;
  const sync = syncs.get(view);
  const missing = missingCells.get(view);
  if (missing && !missing.changed && update.docChanged) {
    missing.changed = true;
    if (!active.get(view)?.composing) recoverMissingCell(view, missing.el);
  }
  if (!sync) return;
  if (update.docChanged) sync.desc = sync.desc.composeDesc(update.changes.desc);
  if (sync.committing || active.get(view)?.composing) return;
  const caretAt = (caret: number) => sync.desc.mapPos(sync.baseFrom + (T.cellDisplayMap(sync.base).offsets[caret] ?? sync.base.length), 1);
  const explicit = update.transactions.some((tr) => tr.selection !== undefined);
  if (!sync.refocusSelection && sync.el.dataset.stale !== "1" && !update.docChanged && !explicit) return;
  const selected = sync.refocusSelection ?? (document.activeElement === sync.el ? selectionOffsets(sync.el) : (sync.selection ?? [0, 0]));
  const anchor = explicit ? update.state.selection.main.anchor : caretAt(selected[0]),
    head = explicit ? update.state.selection.main.head : caretAt(selected[1]);
  const hadFocus = sync.refocusSelection !== null || document.activeElement === sync.el;
  sync.refocusSelection = null;
  const hit = cellAtPos(view.state, sync.desc.mapPos(sync.baseFrom, 1));
  if (!hit) return;
  const index = tablesIn(view.state).findIndex((t) => t.from === hit.table.from);
  const wrap = findWrap(view, index);
  const el = wrap && cellAt(wrap, hit.r, hit.c);
  if (!el) return;
  const survives = cellSurvives(sync);
  const from = survives ? sync.desc.mapPos(sync.baseFrom, -1) : hit.cell.from,
    to = survives ? sync.desc.mapPos(sync.baseFrom + sync.base.length, 1) : hit.cell.to;
  const raw = view.state.sliceDoc(from, to);
  const mapped = T.cellDisplayMap(raw);
  const offset = (pos: number) => {
    const at = mapped.offsets.findIndex((n) => n >= pos - from);
    return at < 0 ? mapped.text.length : at;
  };
  if (el !== sync.el && sync.el.isConnected) {
    sync.el.dataset.editing = "0";
    const oldWrap = sync.el.closest<HTMLElement>(".k2b-ste-table");
    const oldTable = oldWrap && currentTable(view, oldWrap);
    if (oldTable) renderCell(view, sync.el, sync.el.dataset.raw ?? "", oldTable, Number(sync.el.dataset.r), Number(sync.el.dataset.c));
  }
  el.dataset.stale = "0";
  if (hadFocus) {
    focusCell(el, 0);
    el.dataset.raw = raw;
    el.textContent = mapped.text;
    placeSelection(el, offset(anchor), offset(head));
  }
  resync(view, el, { from, to, text: raw });
  const current = syncs.get(view);
  if (current) current.selection = [offset(anchor), offset(head)];
});

const move = (view: EditorView, wrap: HTMLElement, r: number, c: number, edge: "start" | "end" = "end") => {
  const index = active.get(view)?.index ?? -1;
  const target = wrap.isConnected ? wrap : findWrap(view, index);
  const el = target && cellAt(target, r, c);
  if (el) {
    focusCell(el, edge === "start" ? 0 : T.displayCell(el.dataset.raw ?? "").length);
    if (target) {
      target.querySelectorAll<HTMLElement>(".k2b-ste-cell").forEach((cell) => (cell.tabIndex = cell === el ? 0 : -1));
      const bounds = target.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const frozen = c > 0 ? (target.querySelector("tr > :first-child")?.getBoundingClientRect().width ?? 0) : 0;
      if (box.left < bounds.left + frozen) target.scrollLeft -= bounds.left + frozen - box.left;
      else if (box.right > bounds.right - 16) target.scrollLeft += box.right - bounds.right + 16;
    }
  }
};

/** Source identities, never visual row indexes, decide menu and shortcut boundaries. */
const actionAllowed = (t: T.Table, r: number, c: number, action: MenuAction): boolean => {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= T.rowCount(t) || c < 0 || c >= width(t)) return false;
  switch (action) {
    case "rowAbove":
    case "deleteRow":
      return r > 0;
    case "moveRowUp":
      return r > 1;
    case "moveRowDown":
      return r > 0 && r < T.rowCount(t) - 1;
    case "deleteCol":
      return t.columns > 1 || c >= t.columns;
    case "moveColLeft":
    case "moveColRight":
      return (
        c < t.columns && (action === "moveColLeft" ? c > 0 : c < t.columns - 1) && t.lines.every((line) => line.cells.length === t.columns)
      );
    case "toggleHeader":
      return hasHeader(t) || !!(t.lines[2]?.cells.some((cell) => cell.text) && t.lines[2].cells.length <= t.columns);
    default:
      return true;
  }
};

export const tableActionEnabled = (view: EditorView, wrap: HTMLElement, action: MenuAction): boolean => {
  const t = currentTable(view, wrap),
    act = active.get(view);
  if (!t || !act || view.state.readOnly || !actionAllowed(t, act.r, act.c, action)) return false;
  const structure = view.state.facet(tableHost)?.structure;
  return !structure || structure.available() || (action === "rowBelow" && act.r === T.rowCount(t) - 1);
};

/** Copy the visible table through the browser clipboard, with spreadsheet and rich-text payloads. */
export const copyTable = async (view: EditorView, wrap: HTMLElement, format: "table" | "markdown"): Promise<void> => {
  const t = currentTable(view, wrap);
  if (!t) throw new Error("Table is no longer available");
  if (format === "markdown") {
    await navigator.clipboard.writeText(view.state.sliceDoc(t.from, t.to));
    return;
  }
  // Reuse the host's presentation for values (including computed cells), even
  // when the live cell currently exposes its editable source. Controls never
  // become spreadsheet contents. Markdown copy above remains byte-exact.
  const grid = cells(t)
    .slice(firstRow(t))
    .map((row, r) =>
      row.map((raw, c) => {
        const element = view.dom.ownerDocument.createElement("div");
        renderCell(view, element, raw, t, r + firstRow(t), c);
        element
          .querySelectorAll('button, [role="button"], [aria-hidden="true"], [hidden], script, style, template')
          .forEach((node) => node.remove());
        return element.textContent ?? "";
      }),
    );
  const text = grid
    .map((row) => row.map((value) => (/[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)).join("\t"))
    .join("\n");
  const html = `<table>${grid
    .map(
      (row, r) =>
        `<tr>${row
          .map((value) => {
            const tag = hasHeader(t) && r === 0 ? "th" : "td";
            return `<${tag}>${escapeHtml(value)}</${tag}>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</table>`;
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write)
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  else await navigator.clipboard.writeText(text);
};

export const runMenuAction = (view: EditorView, wrap: HTMLElement, action: MenuAction) => {
  const t = currentTable(view, wrap);
  const act = active.get(view);
  if (t && act) runTableAction(view, t.from, act.r, act.c, action);
};

/** No ordinal fallback: only a freshly resolved table/row/column can receive focus. */
const focusTableTarget = (view: EditorView, target: TableTarget | null) => {
  if (!target || !view.dom.isConnected || view.state.readOnly) return;
  const tables = tablesIn(view.state);
  const index = tables.findIndex((table) => table.from === target.tableFrom);
  const table = tables[index];
  if (
    !table ||
    target.row < firstRow(table) ||
    T.gridLine(table, target.row)?.from !== target.rowFrom ||
    table.lines[0]?.cells[target.column]?.from !== target.columnFrom
  )
    return;
  const wrap = findWrap(view, index);
  if (!wrap) return;
  active.set(view, { index, r: target.row, c: target.column, composing: false });
  move(view, wrap, target.row, target.column);
  const selected = cellAt(wrap, target.row, target.column);
  if (selected && view.dom.ownerDocument.activeElement !== selected)
    wrap.dispatchEvent(new CustomEvent("k2b-ste-cell-focus", { bubbles: true, detail: { cell: selected } }));
};

/** Structural actions also work in source mode, without a mounted table widget. */
export const runTableAction = (view: EditorView, tableFrom: number, r: number, c: number, action: MenuAction) => {
  const tables = tablesIn(view.state);
  const index = tables.findIndex((table) => table.from === tableFrom);
  const t = tables[index];
  if (!t || view.state.readOnly || !actionAllowed(t, r, c, action)) return;
  const host = view.state.facet(tableHost);
  // F3 A: only an append at the end is safe without the server.
  if (host?.structure && !(action === "rowBelow" && r === T.rowCount(t) - 1)) {
    if (!host.structure.available()) {
      host.onError("structureUnavailable");
      return;
    }
    const row = T.gridLine(t, r);
    const column = t.lines[0]?.cells[Math.min(c, t.columns - 1)];
    if (!row || !column) {
      host.onError("structureFailed");
      return;
    }
    // A new user gesture while waiting owns the caret. Remote redraws do not.
    const interactionRoot = view.dom;
    let follow = true,
      settled = false;
    const relinquish = () => {
      follow = false;
    };
    const finish = () => {
      settled = true;
      interactionRoot.removeEventListener("pointerdown", relinquish, true);
      interactionRoot.removeEventListener("keydown", relinquish, true);
    };
    queueMicrotask(() => {
      if (settled) return;
      interactionRoot.addEventListener("pointerdown", relinquish, true);
      interactionRoot.addEventListener("keydown", relinquish, true);
    });
    // Invocation is synchronous so a host can capture CRDT anchors before any await.
    try {
      void host.structure
        .perform(action, { tableFrom: t.from, rowFrom: row.from, columnFrom: column.from, row: r, column: c })
        .then((resolve) => {
          const focused = view.dom.ownerDocument.activeElement;
          const ownsFocus =
            !focused ||
            focused === view.dom.ownerDocument.body ||
            view.dom.contains(focused) ||
            focused.closest(".k2b-gesture-menu__sheet-menu");
          if (follow && ownsFocus && resolve) focusTableTarget(view, resolve());
        })
        .catch(() => host.onError("structureFailed"))
        .finally(finish);
    } catch {
      finish();
      host.onError("structureFailed");
    }
    return;
  }
  const ops: Record<MenuAction, () => T.Change[]> = {
    completeColumns: () => T.completeColumns(t),
    rowAbove: () => T.insertRow(t, Math.max(0, r - 1)),
    rowBelow: () => T.insertRow(t, r),
    colLeft: () => T.insertColumn(t, c),
    colRight: () => T.insertColumn(t, c + 1),
    deleteRow: () => T.deleteRow(t, r),
    deleteCol: () => T.deleteColumn(t, c),
    moveRowUp: () => T.moveRow(view.state.doc.toString(), t, r, r - 1),
    moveRowDown: () => T.moveRow(view.state.doc.toString(), t, r, r + 1),
    moveColLeft: () => T.moveColumn(t, c, c - 1),
    moveColRight: () => T.moveColumn(t, c, c + 1),
    toggleHeader: () => T.toggleHeader(view.state.doc.toString(), t),
    deleteTable: () => T.deleteTable(t),
    alignLeft: () => T.setAlign(t, c, "left"),
    alignCenter: () => T.setAlign(t, c, "center"),
    alignRight: () => T.setAlign(t, c, "right"),
  };
  const next = {
    moveRowUp: [r - 1, c],
    moveRowDown: [r + 1, c],
    moveColLeft: [r, c - 1],
    moveColRight: [r, c + 1],
    toggleHeader: [hasHeader(t) ? r + 1 : Math.max(0, r - 1), c],
    rowAbove: [r === 0 ? 1 : r, c],
    rowBelow: [r + 1, c],
    colLeft: [r, c],
    colRight: [r, c + 1],
    deleteRow: [Math.max(1, r - 1), c],
    deleteCol: [r, Math.max(0, c - 1)],
  } as Record<string, [number, number]>;
  if (!dispatchChanges(view, ops[action](), true)) return;
  if (action === "deleteTable") {
    active.delete(view);
    syncs.delete(view);
    view.focus();
    view.dispatch({ selection: { anchor: Math.min(t.from, view.state.doc.length) } });
    return;
  }
  const target = next[action] ?? [r, c];
  const wrap = findWrap(view, index);
  if (wrap) {
    active.set(view, { index, r: target[0]!, c: target[1]!, composing: false });
    move(view, wrap, target[0]!, target[1]!);
    // A modal sheet makes the grid inert. Still update its selected context
    // from this synchronous local transaction; focus returns when it closes.
    const selected = cellAt(wrap, target[0]!, target[1]!);
    if (selected && view.dom.ownerDocument.activeElement !== selected)
      wrap.dispatchEvent(new CustomEvent("k2b-ste-cell-focus", { bubbles: true, detail: { cell: selected } }));
  }
};

/** Cells one paste may write; larger blocks are refused visibly instead of running thousands of transactions. */
const MAX_PASTE_CELLS = 2000;

const pasteGrid = (view: EditorView, wrap: HTMLElement, startR: number, startC: number, grid: string[][]) => {
  const cellCount = grid.reduce((n, row) => n + row.length, 0);
  if (view.state.readOnly) return;
  if (cellCount > (view.state.facet(tableHost)?.maxPasteCells ?? MAX_PASTE_CELLS)) {
    view.state.facet(tableHost)?.onError("pasteTooLarge");
    wrap.dispatchEvent(new CustomEvent("k2b-ste-paste-too-large", { bubbles: true, detail: { cells: cellCount, max: MAX_PASTE_CELLS } }));
    return;
  }
  const host = view.state.facet(tableHost);
  const initial = currentTable(view, wrap);
  if (!initial) return;
  if (host?.structure && grid.some((row) => startC + row.length > initial.columns)) {
    host.onError("structureUnavailable");
    return;
  }
  // One transaction gives paste a single undo step and avoids a partial paste.
  let text = view.state.sliceDoc(initial.from, initial.to);
  let composed = ChangeSet.empty(text.length);
  const apply = (changes: T.Change[]) => {
    const set = ChangeSet.of(
      changes.map((change) => ({ ...change, insert: Text.of(change.insert.split("\n")) })),
      text.length,
    );
    text = set.apply(Text.of(text.split("\n"))).toString();
    composed = composed.compose(set);
  };
  for (let i = 0; i < grid.length; i++) {
    let t = T.findTables(text)[0];
    if (!t) return;
    if (startR + i >= T.rowCount(t)) apply(T.insertRow(t, T.rowCount(t) - 1));
    for (let j = 0; j < grid[i]!.length; j++) {
      t = T.findTables(text)[0];
      if (!t) return;
      if (startC + j >= t.columns) apply(T.insertColumn(t, t.columns));
      t = T.findTables(text)[0];
      if (!t) return;
      apply(T.setCellText(t, startR + i, startC + j, T.escapeCell(grid[i]![j] ?? "")));
    }
  }
  const changes: T.Change[] = [];
  composed.iterChanges((from, to, _newFrom, _newTo, insert) =>
    changes.push({ from: initial.from + from, to: initial.from + to, insert: insert.toString() }),
  );
  dispatchChanges(view, changes, true);
};

const wire = (view: EditorView, el: HTMLElement, wrap: HTMLElement) => {
  const pos = () => ({ r: Number(el.dataset.r), c: Number(el.dataset.c) });
  el.addEventListener("focus", () => {
    const grid = wrap.querySelector("table");
    if (grid && !grid.hasAttribute("data-sized")) {
      const widths = Array.from(grid.rows[0]?.cells ?? []).map((cell) => cell.getBoundingClientRect().width);
      if (widths.every((width) => width > 0)) {
        const columns = document.createElement("colgroup");
        for (const width of widths) {
          const column = document.createElement("col");
          column.style.width = `${width}px`;
          columns.append(column);
        }
        grid.prepend(columns);
        grid.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
        grid.style.tableLayout = "fixed";
        grid.dataset.sized = "1";
      }
    }
    active.set(view, { index: tableIndex(view, wrap), ...pos(), composing: false });
    wrap.querySelectorAll<HTMLElement>(".k2b-ste-cell").forEach((cell) => (cell.tabIndex = cell === el ? 0 : -1));
    wrap.dataset.activeR = el.dataset.r;
    wrap.dataset.activeC = el.dataset.c;
    if (view.state.readOnly) {
      // A read-only cell selects rendered text; it never enters source editing.
      // Keyboard entry may have prepared editable text before focusing it.
      if (el.dataset.editing === "1") {
        el.dataset.editing = "0";
        const table = currentTable(view, wrap);
        if (table) renderCell(view, el, el.dataset.raw ?? "", table, Number(el.dataset.r), Number(el.dataset.c));
      }
      syncs.delete(view);
      missingCells.delete(view);
      wrap.dispatchEvent(new CustomEvent("k2b-ste-cell-focus", { bubbles: true, detail: { cell: el } }));
      return;
    }
    const t = currentTable(view, wrap);
    const cell = t && T.gridLine(t, Number(el.dataset.r))?.cells[Number(el.dataset.c)];
    missingCells.delete(view);
    if (cell) resync(view, el, cell);
    else {
      syncs.delete(view);
      missingCells.set(view, { el, changed: false });
    }
    if (el.dataset.editing !== "1") {
      el.dataset.editing = "1";
      const shown = T.displayCell(el.dataset.raw ?? "");
      // Only cells with formatting change their text; plain cells keep the caret where the tap put it.
      if (el.textContent !== shown || el.childElementCount > 0) {
        el.textContent = shown;
        placeCaret(el, shown.length);
      }
    }
    wrap.dispatchEvent(new CustomEvent("k2b-ste-cell-focus", { bubbles: true, detail: { cell: el } }));
    queueCellSelection(view, el);
  });
  el.addEventListener("blur", () => {
    if (rebuilding.has(view)) return;
    const sync = syncs.get(view);
    if (sync?.el === el) sync.selection = selectionOffsets(el);
    el.dataset.editing = "0";
    queueMicrotask(() => {
      // Chromium blurs a focused cell while CodeMirror removes its widget.
      // Wait for that update before consulting CodeMirror's DOM mapping. A
      // removed widget has no mapping in the newly configured source view.
      if (!wrap.isConnected) return;
      const focused = el.ownerDocument.activeElement;
      const table = currentTable(view, wrap);
      // Read-only focus never changed presentation. Replacing it on blur would
      // detach the text nodes held by the person's native selection.
      if (table && !view.state.readOnly && el.dataset.editing !== "1")
        renderCell(view, el, el.dataset.raw ?? "", table, Number(el.dataset.r), Number(el.dataset.c));
      if (!wrap.contains(focused)) {
        delete wrap.dataset.activeR;
        wrap.dispatchEvent(new CustomEvent("k2b-ste-cell-blur", { bubbles: true }));
        if (!(focused instanceof HTMLElement && focused.classList.contains("k2b-ste-cell") && view.dom.contains(focused)))
          view.state.facet(tableHost)?.onCellSelection?.(null);
      }
    });
  });
  el.addEventListener("compositionstart", () => {
    if (view.state.readOnly) return;
    const act = active.get(view);
    if (act) act.composing = true;
  });
  el.addEventListener("compositionend", () => {
    if (view.state.readOnly) return;
    const act = active.get(view);
    if (act) act.composing = false;
    commitCell(view, el, wrap);
  });
  el.addEventListener("beforeinput", (event) => {
    if (view.state.readOnly) {
      event.preventDefault();
      return;
    }
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      const host = view.state.facet(tableHost);
      if (event.inputType === "historyUndo") host?.undo();
      else host?.redo();
    }
  });
  el.addEventListener("input", (event) => {
    // During composition the text is provisional; the browser owns the DOM.
    if (view.state.readOnly || (event as InputEvent).isComposing || active.get(view)?.composing) return;
    commitCell(view, el, wrap);
  });
  el.addEventListener("paste", (event) => {
    event.preventDefault();
    if (view.state.readOnly) return;
    const data = event.clipboardData;
    if (!data) return;
    const host = view.state.facet(tableHost);
    const clipboard = inspectClipboard(data, { maxLength: host?.maxLength ?? Infinity, maxPasteCells: host?.maxPasteCells ?? 2000 });
    if ("error" in clipboard) {
      host?.onError(clipboard.error);
      return;
    }
    const { html, text, images, files } = clipboard;
    if (images) host?.onDroppedImages?.(images, files);
    const grid = (html ? htmlTableGrid(html) : null) ?? T.parseTsv(text);
    const { r, c } = pos();
    if (grid?.length) pasteGrid(view, wrap, r, c, grid);
    else {
      const inline = (html && convertClipboardHtml(html, false)?.markdown) || text;
      document.execCommand("insertText", false, inline.replace(/\s*\r?\n\s*/g, " "));
    }
  });
  el.addEventListener("pointerenter", () => {
    wrap.querySelectorAll<HTMLElement>(".k2b-ste-columnMenu").forEach((grip, column) => {
      grip.toggleAttribute("data-hovered", column === Number(el.dataset.c));
    });
  });
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    pendingContextMenus.get(view)?.abort();
    el.focus({ preventScroll: true });
    const open = () => {
      if (el.isConnected)
        wrap.dispatchEvent(
          new CustomEvent("k2b-ste-cell-menu", { bubbles: true, detail: { cell: el, x: event.clientX, y: event.clientY } }),
        );
    };
    // WebKit fires contextmenu on right-button down. Opening a native popover
    // then lets that same press dismiss it on release. Chrome fires after up.
    if (event.button === 2 && (event.buttons & 2) !== 0) {
      const pending = new AbortController();
      pendingContextMenus.set(view, pending);
      const cancel = () => {
        pending.abort();
        if (pendingContextMenus.get(view) === pending) pendingContextMenus.delete(view);
      };
      el.ownerDocument.addEventListener(
        "mouseup",
        (release) => {
          if (release.button !== 2) return;
          cancel();
          open();
        },
        { signal: pending.signal },
      );
      el.ownerDocument.addEventListener("pointercancel", cancel, { signal: pending.signal, once: true });
      el.ownerDocument.defaultView?.addEventListener("blur", cancel, { signal: pending.signal, once: true });
    } else open();
  });
  el.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return; // A host completion/snippet handled this key.
    const host = view.state.facet(tableHost);
    const t = currentTable(view, wrap);
    if (!t) return;
    const { r, c } = pos();
    const mod = event.metaKey || event.ctrlKey;
    if (event.isComposing) return;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      wrap.dispatchEvent(new CustomEvent("k2b-ste-cell-menu", { bubbles: true, detail: { cell: el } }));
      return;
    }
    // Preserve native selection/copy/navigation for non-editable rendered text.
    if (view.state.readOnly) return;
    if (mod && !event.shiftKey && event.key.toLowerCase() === "a") {
      // Nested contenteditables do not scope native Select All consistently.
      // Keep replacement and formatting inside this cell in every host.
      event.preventDefault();
      event.stopPropagation();
      placeSelection(el, 0, el.textContent?.length ?? 0);
      queueCellSelection(view, el);
      return;
    }
    if (mod && ["b", "i", "k"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      const command = event.key.toLowerCase() === "b" ? "bold" : event.key.toLowerCase() === "i" ? "italic" : "link";
      formatActiveCell(view, command);
      return;
    }
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) host?.redo();
      else host?.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      host?.redo();
      return;
    }
    if (event.altKey && !mod && !event.shiftKey) {
      const actions: Record<string, MenuAction> = {
        ArrowUp: "moveRowUp",
        ArrowDown: "moveRowDown",
        ArrowLeft: "moveColLeft",
        ArrowRight: "moveColRight",
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        runTableAction(view, t.from, r, c, action);
        return;
      }
    }
    if (event.key === "Tab") {
      if (host?.tabMovesFocus?.()) return;
      event.preventDefault();
      const last = r === T.rowCount(t) - 1 && c === t.columns - 1;
      if (!event.shiftKey && last) {
        dispatchChanges(view, T.insertRow(t, r), true);
        move(view, wrap, r + 1, 0);
        return;
      }
      const index = r * t.columns + c + (event.shiftKey ? -1 : 1);
      if (index < firstRow(t) * t.columns) {
        leave(view, wrap, "before");
        return;
      }
      move(view, wrap, Math.floor(index / t.columns), index % t.columns);
      const next = findWrap(view, tableIndex(view, wrap));
      const cell = next && cellAt(next, Math.floor(index / t.columns), index % t.columns);
      if (cell) placeSelection(cell, 0, cell.textContent?.length ?? 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) return; // a cell holds one line
      const last = T.rowCount(t) - 1;
      if (r < last) move(view, wrap, r + 1, c);
      else if (r > 1 && T.gridLine(t, last)?.cells.every((cell) => !T.displayCell(cell.text).trim())) {
        // Match the list-like exit: remove the empty trailing row when allowed.
        // F3 A keeps deletion server-only; offline we can still leave the table.
        if (!host?.structure || host.structure.available()) runTableAction(view, t.from, r, c, "deleteRow");
        leave(view, wrap, "after");
      } else if (dispatchChanges(view, T.insertRow(t, last), true)) move(view, wrap, last + 1, c);
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && !mod && !event.altKey) {
      const [anchor, head] = selectionOffsets(el);
      const right = event.key === "ArrowRight";
      if (anchor !== head || head !== (right ? (el.textContent?.length ?? 0) : 0)) return;
      event.preventDefault();
      const next = r * t.columns + c + (right ? 1 : -1);
      if (next >= firstRow(t) * t.columns && next < T.rowCount(t) * t.columns)
        move(view, wrap, Math.floor(next / t.columns), next % t.columns, right ? "start" : "end");
      else leave(view, wrap, right ? "after" : "before");
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.shiftKey || event.altKey || mod || !atCellVisualEdge(el, event.key === "ArrowDown")) return;
      const next = r + (event.key === "ArrowUp" ? -1 : 1);
      event.preventDefault();
      if (next >= firstRow(t) && next < T.rowCount(t)) move(view, wrap, next, c);
      else leave(view, wrap, next < firstRow(t) ? "before" : "after");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      leave(view, wrap, "after");
    }
  });
};

/** Route formatting to the active cell instead of the hidden outer-editor caret. */
export const formatActiveCell = (view: EditorView, name: InlineFormat): boolean => {
  const act = active.get(view);
  const wrap = act && findWrap(view, act.index);
  const el = act && wrap && cellAt(wrap, act.r, act.c);
  const table = wrap && currentTable(view, wrap);
  const source = wrap && sources.get(wrap);
  if (source?.element.contains(view.dom.ownerDocument.activeElement)) {
    if (!view.state.readOnly && !source.editor.state.readOnly) source.editor.dispatch(inlineFormat(source.editor.state, name));
    return true;
  }
  if (!el || !table || !act || view.state.readOnly) return false;
  const missing = missingCells.get(view);
  if (missing?.el === el && missing.changed) {
    recoverMissingCell(view, el);
    return true;
  }
  let sync = syncs.get(view);
  let base = view.state;
  let materialized = ChangeSet.empty(base.doc.length);
  let cell = T.gridLine(table, act.r)?.cells[act.c];
  if (!cell) {
    const changes = T.setCellText(table, act.r, act.c, "");
    materialized = base.changes(changes);
    base = base.update({ changes: materialized }).state;
    cell = T.gridLine(tablesIn(base).find((t) => t.from === table.from)!, act.r)?.cells[act.c];
    sync = undefined;
  }
  if (!cell) return true;
  const offsets = sync?.el === el ? (el.dataset.editing === "1" ? selectionOffsets(el) : (sync.selection ?? [0, 0])) : [0, 0];
  const map = T.cellDisplayMap(sync?.el === el ? sync.base : cell.text);
  const position = (offset: number) =>
    sync?.el === el
      ? sync.desc.mapPos(sync.baseFrom + (map.offsets[offset] ?? sync.base.length), 1)
      : cell!.from + (map.offsets[offset] ?? cell!.text.length);
  base = base.update({ selection: { anchor: position(offsets[0]!), head: position(offsets[1]!) } }).state;
  const formatted = base.update(inlineFormat(base, name));
  const changes: T.Change[] = [];
  materialized.compose(formatted.changes).iterChanges((from, to, _a, _b, insert) => changes.push({ from, to, insert: insert.toString() }));
  const selection = formatted.state.selection.main;
  missingCells.delete(view);
  if (sync) sync.committing = true;
  const accepted = dispatchChanges(view, changes, true, selection);
  if (sync) sync.committing = false;
  if (!accepted) return true;
  const hit = cellAtPos(view.state, selection.head);
  const currentWrap =
    hit &&
    findWrap(
      view,
      tablesIn(view.state).findIndex((t) => t.from === hit.table.from),
    );
  const target = hit && currentWrap && cellAt(currentWrap, hit.r, hit.c);
  if (target && hit) {
    focusCell(target, 0);
    placeSelection(
      target,
      T.displayCell(view.state.sliceDoc(hit.cell.from, selection.anchor)).length,
      T.displayCell(view.state.sliceDoc(hit.cell.from, selection.head)).length,
    );
    resync(view, target, hit.cell);
  }
  return true;
};

const syncCellSelection = (view: EditorView, el = syncs.get(view)?.el) => {
  const sync = syncs.get(view);
  if (!el?.isConnected || document.activeElement !== el || sync?.el !== el || active.get(view)?.composing) return;
  const [a, h] = selectionOffsets(el);
  const map = T.cellDisplayMap(sync.base);
  const position = (offset: number) => sync.desc.mapPos(sync.baseFrom + (map.offsets[offset] ?? sync.base.length), 1);
  const anchor = position(a),
    head = position(h);
  if (anchor !== view.state.selection.main.anchor || head !== view.state.selection.main.head)
    view.dispatch({ selection: { anchor, head } });
  view.state.facet(tableHost)?.onCellSelection?.({ anchor, head });
};
const pendingSelection = new WeakSet<EditorView>();
const queueCellSelection = (view: EditorView, el: HTMLElement) => {
  if (pendingSelection.has(view)) return;
  pendingSelection.add(view);
  queueMicrotask(() => {
    pendingSelection.delete(view);
    syncCellSelection(view, el);
  });
};
const atCellVisualEdge = (el: HTMLElement, down: boolean) => {
  const selection = el.ownerDocument.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(false);
  let caret = range.getBoundingClientRect();
  if (!caret.height) {
    // A collapsed range at a container boundary has no rectangle in WebKit.
    // Measure the neighbouring character without changing the user's selection.
    const at = selectionOffsets(el)[1];
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = at;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length && length) {
        const start = Math.min(remaining, length - 1);
        range.setStart(node, start);
        range.setEnd(node, start + 1);
        caret = range.getBoundingClientRect();
        break;
      }
      remaining -= length;
    }
  }
  if (!caret.height) return !(el.textContent ?? "").length;
  const box = el.getBoundingClientRect(),
    style = getComputedStyle(el);
  const lineHeight = Number.parseFloat(style.lineHeight) || caret.height;
  return down
    ? box.bottom - caret.bottom <= Number.parseFloat(style.paddingBottom) + lineHeight / 2
    : caret.top - box.top <= Number.parseFloat(style.paddingTop) + lineHeight / 2;
};
const enterTable = (view: EditorView, down: boolean) => {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (view.state.doc.lineAt(view.moveVertically(selection, down).head).number === line.number) return false;
  const tables = tablesIn(view.state);
  const index = tables.findIndex((t) =>
    down
      ? t.from > line.to && view.state.doc.lineAt(t.from).number === line.number + 1
      : t.to < line.from && view.state.doc.lineAt(t.to).number === line.number - 1,
  );
  const table = tables[index];
  const wrap = findWrap(view, index);
  const el = table && wrap && cellAt(wrap, down ? firstRow(table) : T.rowCount(table) - 1, 0);
  if (!el) return false;
  focusCell(el, 0);
  return true;
};

const leave = (view: EditorView, wrap: HTMLElement, where: "before" | "after") => {
  const t = currentTable(view, wrap);
  if (!t) return;
  // An EOF table needs an actual paragraph to receive the caret.
  if (where === "after" && t.to === view.state.doc.length && !view.state.readOnly)
    dispatchChanges(view, [{ from: t.to, to: t.to, insert: "\n\n" }]);
  const anchor = where === "before" ? Math.max(0, t.from - 1) : Math.min(view.state.doc.length, t.to + 1);
  view.focus();
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
};

/** First `<table>` of pasted HTML as a grid (Excel, Sheets, Word, web pages). */
export const htmlTableGrid = (html: string): string[][] | null => {
  const doc = parseClipboardHtml(html);
  const table = doc.querySelector("table");
  if (!table) return null;
  const rows = [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("th,td")].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
  );
  return rows.filter((row) => row.length).length ? rows.filter((row) => row.length) : null;
};

const decorate = (state: EditorState): DecorationSet =>
  Decoration.set(
    tablesIn(state).map((t) => Decoration.replace({ widget: new GridWidget(t, state.readOnly), block: true }).range(t.from, t.to)),
    true,
  );

export const tableGrid = (): Extension => [
  clipboardLoading((view) => view.state.facet(tableHost), syncCellSelection),
  Prec.highest(
    keymap.of([
      { key: "ArrowDown", run: (view) => enterTable(view, true) },
      { key: "ArrowUp", run: (view) => enterTable(view, false) },
    ]),
  ),
  ViewPlugin.define((view) => {
    const selection = () => {
      const el = syncs.get(view)?.el;
      if (el) queueCellSelection(view, el);
    };
    view.dom.ownerDocument.addEventListener("selectionchange", selection);
    return {
      destroy() {
        pendingContextMenus.get(view)?.abort();
        pendingContextMenus.delete(view);
        view.dom.ownerDocument.removeEventListener("selectionchange", selection);
        syncs.delete(view);
        missingCells.delete(view);
        active.delete(view);
        view.state.facet(tableHost)?.onCellSelection?.(null);
      },
    };
  }),
  StateField.define<DecorationSet>({
    create: decorate,
    update: (value, tr) =>
      tr.docChanged ||
      tr.effects.some((e) => e.is(refreshTables)) ||
      tr.startState.readOnly !== tr.state.readOnly ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
        ? decorate(tr.state)
        : value,
    provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
  }),
  followChanges,
];
