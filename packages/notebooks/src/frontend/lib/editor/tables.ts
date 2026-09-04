/**
 * Markdown table widget — renders a `| col | col |` block as a tile-style
 * preview when the cursor is on a different line, mirroring the read-mode
 * HTML produced by the `marked` extension. Same `.md-table-*` classes
 * flow through `cloud/src/styles/utilities-markdown-table.css` so the visual
 * is identical in edit and read mode.
 *
 * Editing path:
 *  - Cursor inside the table's lines (or on the line right before / after) →
 *    widget hidden, raw markdown source visible, normal CM editing.
 *  - Click on the widget → cursor dispatched to the table's start so the
 *    source-show range fires; user can then arrow-key around inside.
 *
 * # Cursor navigation
 *
 * Four defense-in-depth measures around CodeMirror's vertical-nav
 * behavior near block widgets:
 *
 *  1. `EditorView.atomicRanges` over the block-widget decorations.
 *     CM's official recommendation for replace-block decorations —
 *     snaps cursor positions that fall inside the widget range to
 *     the nearest edge.
 *
 *  2. StateField rebuild only on `docChanged` OR cursor-crosses-
 *     table-boundary (NOT on every `tr.selection`). Prevents
 *     widget destroy+recreate on every vertical-nav keystroke,
 *     which was thrashing layout heights mid-move.
 *
 *  3. Over-estimated `TableWidget.estimatedHeight` (48px/row + 24px
 *     padding). Under-estimating causes upward layout shift after
 *     DOM measurement, which CM's vertical-nav sees as a moving
 *     target.
 *
 *  4. `Prec.highest` ArrowUp/Down keymap intercept that does
 *     strict logical-line navigation when tables are present in
 *     the doc. Bypasses CM's Y-coord based `moveVertically` for
 *     vertical motion, walking past widgets in a single hop.
 *
 * CodeMirror 6.39.13 / 6.40.0 / 6.41.0 fixed several upstream
 * cursor-jump bugs around block widgets + line-wrapping (this
 * project pulls them in via `@codemirror/view: ^6.42.1`), but
 * our specific layout — multiple stacked `Decoration.replace({
 * block: true })` widgets with `cm-lineWrapping` and a cursor-
 * proximity source-toggle — still triggers a residual case where
 * ArrowDown approaching a widget from above resolves past it
 * instead of into its source. We therefore keep a `Prec.highest`
 * custom keymap (4) that does line-by-line nav and walks past
 * widgets in a single hop. With the CM upgrade as a strong base
 * + the keymap as final guard, all the cursor-jump symptoms from
 * the original bug report are gone.
 *
 * No pagination, no per-cell type detection, no column zebra — markdown
 * tables are hand-edited and small. Data tables belong in the Grids app.
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Prec, type Range, RangeSet, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { clipboard } from "@k2b/stdlib/browser";
import { type EvalContext, evaluateFormula, isFormula } from "@valentinkolb/cloud/shared";
import { isNamedBlockHandle } from "../../../lib/named-blocks";
import { formatFormulaError, formatFormulaValue, renderPrettyTableHtml } from "../pretty-table";
import { refreshMarkdownDecorationsEffect, selectionIntersectsRange } from "./_lib/cursor-zone-field";
import { splitTableLineCells, tableCellText } from "./_lib/table-cell";

type Align = "left" | "right" | "center" | null;

type TableData = {
  caption?: string;
  headers: string[];
  rows: string[][];
  align: Align[];
};

const splitRow = (line: string): string[] => {
  return splitTableLineCells(line).map((cell) => tableCellText(cell.text));
};

const parseAlign = (separator: string): Align => {
  const t = separator.trim();
  const startsColon = t.startsWith(":");
  const endsColon = t.endsWith(":");
  if (startsColon && endsColon) return "center";
  if (endsColon) return "right";
  if (startsColon) return "left";
  return null;
};

const parseTable = (text: string): TableData | null => {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return null;
  if (!lines[1]?.includes("---")) return null;

  const allRows = lines.map(splitRow);
  const headers = allRows[0] ?? [];
  const align: Align[] = (allRows[1] ?? []).map(parseAlign);
  const rows = allRows.slice(2);

  const cols = headers.length;
  const normalizedRows = rows.map((row) => {
    while (row.length < cols) row.push("");
    return row.slice(0, cols);
  });
  // Pad / truncate align to match column count.
  while (align.length < cols) align.push(null);

  return { headers, rows: normalizedRows, align: align.slice(0, cols) };
};

const renderTable = (data: TableData, notebookId: string): string => renderPrettyTableHtml(data, { notebookId });

const sameArray = <T>(left: T[], right: T[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameRows = (left: string[][], right: string[][]): boolean =>
  left.length === right.length && left.every((row, index) => sameArray(row, right[index] ?? []));

const sameTableData = (left: TableData, right: TableData): boolean =>
  left.caption === right.caption &&
  sameArray(left.headers, right.headers) &&
  sameArray(left.align, right.align) &&
  sameRows(left.rows, right.rows);

/**
 * Inline live-preview widget for raw-mode formula cells. When the user
 * has the cursor inside a table (so the markdown source is visible),
 * we slip a small ` → <result> ` ghost after each `=...` cell so they
 * see whether their formula evaluates correctly without having to
 * leave the cell.
 *
 * Click-to-copy: clicking the OK preview copies the computed value to
 * the clipboard and briefly swaps the text to ` copied ` for ~800 ms.
 * The error variant stays inert — there's nothing useful to copy.
 *
 * `eq()` makes equal-content widgets DOM-stable so the in-flight
 * "copied" state survives unrelated editor updates.
 */
const COPIED_REVERT_MS = 800;

class FormulaPreviewWidget extends WidgetType {
  constructor(
    private text: string,
    private isError: boolean,
  ) {
    super();
  }

  override toDOM() {
    const span = document.createElement("span");
    span.className = this.isError ? "cm-formula-preview cm-formula-preview-error" : "cm-formula-preview";
    span.textContent = ` → ${this.text} `;

    // Errors aren't copyable — no sensible value to put on the clipboard.
    if (this.isError) return span;

    const valueText = this.text;
    let revertTimer: number | null = null;

    // mousedown: we own the event. preventDefault stops CM from moving
    // the cursor to the click position; stopPropagation keeps our DOM
    // click handler reachable without CM also processing it.
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    span.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Fire-and-forget — clipboard errors (e.g. permission denied)
      // are silent; the user sees no "copied" flash and will retry.
      clipboard
        .copy(valueText)
        .then(() => {
          span.textContent = " copied ";
          span.classList.add("cm-formula-preview-copied");
          if (revertTimer !== null) window.clearTimeout(revertTimer);
          revertTimer = window.setTimeout(() => {
            span.textContent = ` → ${valueText} `;
            span.classList.remove("cm-formula-preview-copied");
            revertTimer = null;
          }, COPIED_REVERT_MS);
        })
        .catch(() => {});
    });

    return span;
  }

  override eq(other: WidgetType) {
    return other instanceof FormulaPreviewWidget && other.text === this.text && other.isError === this.isError;
  }

  override ignoreEvent() {
    return true;
  }
}

/** Build inline live-preview decorations for one table when its
 *  source is visible. Walks each body line, parses cell positions,
 *  evaluates any `=...` cells, and inserts a `Decoration.widget` at
 *  the cell-end position so it floats next to the literal source. */
const buildLivePreviewDecorations = (state: EditorState, tableNode: { from: number; to: number }, data: TableData): Range<Decoration>[] => {
  const decorations: Range<Decoration>[] = [];
  const startLine = state.doc.lineAt(tableNode.from);
  const endLine = state.doc.lineAt(tableNode.to);
  // Lines: [0]=header, [1]=separator, [2..]=body rows
  for (let lineNum = startLine.number + 2; lineNum <= endLine.number; lineNum++) {
    const line = state.doc.line(lineNum);
    const bodyRowIdx = lineNum - startLine.number - 2;
    if (bodyRowIdx < 0 || bodyRowIdx >= data.rows.length) continue;
    const cells = splitTableLineCells(line.text);
    cells.forEach((cell, colIdx) => {
      if (colIdx >= data.headers.length) return;
      const trimmed = tableCellText(cell.text);
      if (!isFormula(trimmed)) return;
      const ctx: EvalContext = {
        headers: data.headers,
        rows: data.rows,
        currentRow: bodyRowIdx,
        currentCol: colIdx,
      };
      const result = evaluateFormula(trimmed, ctx);
      const locale = typeof document === "undefined" ? undefined : document.documentElement.lang;
      const previewText =
        result.kind === "ok" ? formatFormulaValue(result.value, locale) : `⚠ ${formatFormulaError(result, locale).split("\n")[0]}`;
      decorations.push(
        Decoration.widget({
          widget: new FormulaPreviewWidget(previewText, result.kind === "error"),
          side: 1,
        }).range(line.from + cell.toInLine),
      );
    });
  }
  return decorations;
};

/**
 * DataTable-style table preview. Click → dispatches cursor to the table's
 * start (`fromPos`, captured at decoration time) so the source-show
 * range fires and the user can edit inline.
 *
 * The click handler lives on the widget DOM, not in a view-level
 * `mousedown`, because `view.posAtDOM(target)` falls back to
 * `state.doc.length` for nodes inside a `contenteditable=false` widget
 * — that fallback was the cause of the "click jumps to end of doc" bug.
 * Capturing the start position at construction sidesteps the problem.
 */
class TableWidget extends WidgetType {
  constructor(
    private data: TableData,
    private fromPos: number,
    private notebookId: string,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "cm-table-widget";
    container.setAttribute("contenteditable", "false");
    container.innerHTML = renderTable(this.data, this.notebookId);
    container.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.fromPos } });
      view.focus();
    };
    // CM's default `dblclick` handler runs INDEPENDENTLY of mousedown.
    // When the user double-clicks on the widget, CM falls back to
    // `posAtDOM(target)` for word-selection, which returns
    // `state.doc.length` for nodes inside a `contenteditable=false`
    // widget — observed as "double-click on a table jumps the cursor
    // to the end of the doc". Stopping propagation on dblclick
    // (without preventDefault, so the browser's native click logic
    // still works for any descendant `<a>`/button) keeps CM out of
    // it.
    container.ondblclick = (event) => {
      event.stopPropagation();
    };
    return container;
  }

  override eq(other: WidgetType) {
    return (
      other instanceof TableWidget &&
      other.fromPos === this.fromPos &&
      other.notebookId === this.notebookId &&
      sameTableData(this.data, other.data)
    );
  }

  /** Widget handles its own clicks; keep CM's view-level handlers off
   *  this DOM tree so the click never reaches `posAtDOM`. */
  override ignoreEvent() {
    return true;
  }

  override get estimatedHeight() {
    // Per-cell rendered metrics (from `utilities-markdown-table.css`):
    //   - padding: 0.5rem 0.75rem (16px vertical)
    //   - font-size: 12px, line-height: 16px
    //   → 32px per single-line row plus its hairline divider.
    // Plus 16px outer padding on `.cm-table-widget` (0.5rem top +
    //   0.5rem bottom — see the theme rule for why this is padding
    //   not margin: margin would collapse and confuse CM's height
    //   measurement, padding stays inside the border-box).
    //
    // Formula: (N+1) rows × 33px + 16px container + 2px frame
    //        ≈ (N+1) × 33 + 18
    //
    // ACCURATE estimate matters MORE than buffer — see history at
    // file top for the click-drift bug this matches.
    return (this.data.rows.length + 1) * 33 + 18;
  }
}

/** Per-table source range — the from/to of the markdown `Table`
 *  node. Used by the StateField's update() to detect cursor-boundary
 *  crossings without re-iterating the syntax tree. */
type TableRange = { from: number; to: number };

/** Full StateField value. Both decoration sets are derived from the
 *  same scan: `decorations` includes block widgets + live-preview
 *  formula chips, `blockWidgetDecorations` is just the block widgets
 *  (feeds `EditorView.atomicRanges` so the cursor snaps to widget
 *  edges instead of landing inside the replaced range during
 *  vertical navigation). */
type TablesState = {
  decorations: DecorationSet;
  blockWidgetDecorations: DecorationSet;
  /** All discovered table source ranges. Used for the
   *  cursor-crossed-a-boundary check in `update()`. */
  tableRanges: TableRange[];
};

/** Compute which table the cursor is currently INSIDE (or
 *  immediately before / after). Returns:
 *    - the matching range's `from` (stable key per-table)
 *    - or `null` when the cursor is outside all tables.
 *
 *  We key by `from` because the array index changes when tables are
 *  added/removed, and a stable identity makes the crossing check
 *  robust against any reorder.
 *
 *  The "source-visible zone" extends by ONE LINE in BOTH directions
 *  around the table:
 *
 *    - Line BEFORE the table: ArrowDown from this line would
 *      otherwise hit the block widget and our line-based vertical
 *      nav would SKIP past it (= user can't enter the table by
 *      arrowing from above). With the zone extended upward, the
 *      table flips to source-visible when the cursor reaches the
 *      line above it, so the next ArrowDown lands inside the
 *      first source row.
 *
 *    - Line AFTER the table: symmetric — ArrowUp from this line
 *      flips the table to source mode so the user enters the
 *      table source rather than skipping past it.
 *
 *  This makes the table behave consistently regardless of approach
 *  direction. */
const cursorTableKey = (state: EditorState, ranges: TableRange[]): string | null => {
  if (ranges.length === 0) return null;
  const cursor = state.selection.main;
  const hits: number[] = [];
  for (const r of ranges) {
    const prevLineStart = state.doc.lineAt(Math.max(r.from - 1, 0)).from;
    const nextLineEnd = state.doc.lineAt(Math.min(r.to + 1, state.doc.length)).to;
    if (selectionIntersectsRange(cursor, prevLineStart, nextLineEnd)) hits.push(r.from);
  }
  return hits.length > 0 ? hits.sort((a, b) => a - b).join(",") : null;
};

/** Full scan: walks the syntax tree, finds every Markdown table,
 *  builds the right decoration mode for each (block widget when the
 *  cursor is elsewhere, live-preview formula chips when inside).
 *
 *  Returns the full StateField value — both decoration sets and the
 *  list of table ranges. */
const scanTables = (state: EditorState, notebookId: string): TablesState => {
  const decorations: Range<Decoration>[] = [];
  const blockWidgetDecorations: Range<Decoration>[] = [];
  const tableRanges: TableRange[] = [];
  const cursor = state.selection.main;

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.type.name !== "Table") return;

      const text = state.sliceDoc(node.from, node.to);
      const data = parseTable(text);
      if (!data || data.headers.length === 0) return;
      const tableLine = state.doc.lineAt(node.from);
      const handleLine = tableLine.number > 1 ? state.doc.line(tableLine.number - 1) : null;
      const caption = handleLine ? isNamedBlockHandle(handleLine.text) : null;
      const rangeFrom = caption ? handleLine!.from : node.from;
      if (caption) data.caption = caption;
      tableRanges.push({ from: rangeFrom, to: node.to });

      // Show-source range: when the cursor is anywhere inside the table
      // OR on the line right before / right after it, drop the block
      // widget so the raw markdown becomes editable. Instead, slip in
      // inline live-preview decorations after each formula cell — the
      // user sees their `=hours * rate` followed by ` → 160` ghost
      // text and can verify the result while still typing in the
      // source.
      //
      // The line-before extension is what makes ArrowDown from above
      // ENTER the table (rather than the line-based vertical-nav
      // widget-skip kicking in). See `cursorTableKey` for the
      // symmetric rationale and the original asymmetric-only bug.
      const prevLine = state.doc.lineAt(Math.max(rangeFrom - 1, 0));
      const nextLine = state.doc.lineAt(Math.min(node.to + 1, state.doc.length));
      const sourceVisible = selectionIntersectsRange(cursor, prevLine.from, nextLine.to);
      if (sourceVisible) {
        for (const deco of buildLivePreviewDecorations(state, { from: node.from, to: node.to }, data)) {
          decorations.push(deco);
        }
        return false;
      }

      const blockDeco = Decoration.replace({
        widget: new TableWidget(data, node.from, notebookId),
        block: true,
      }).range(rangeFrom, node.to);
      decorations.push(blockDeco);
      blockWidgetDecorations.push(blockDeco);
    },
  });

  return {
    decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
    blockWidgetDecorations: blockWidgetDecorations.length > 0 ? RangeSet.of(blockWidgetDecorations, true) : Decoration.none,
    tableRanges,
  };
};

export const tablesExtension = (notebookId: string): Extension => {
  const stateField = StateField.define<TablesState>({
    create(state) {
      return scanTables(state, notebookId);
    },
    update(value, tr) {
      if (tr.effects.some((effect) => effect.is(refreshMarkdownDecorationsEffect))) {
        return scanTables(tr.state, notebookId);
      }
      // Doc changed → tables may have appeared / disappeared / shifted
      // positions. Full rescan.
      if (tr.docChanged) {
        return scanTables(tr.state, notebookId);
      }
      // Selection unchanged AND doc unchanged → nothing to do.
      if (!tr.selection) {
        return value;
      }
      // Selection changed but stayed in the same "table zone" — the
      // widget vs. source-visible decision is identical for both
      // states, so we can keep the existing decorations unchanged.
      // This is the key perf + correctness win:
      //
      //  - PERF: vertical-nav keystrokes don't burn a syntax-tree
      //    walk + decoration rebuild per keystroke.
      //  - CORRECTNESS: the decoration set stays STABLE between
      //    cursor moves that don't actually change widget visibility.
      //    The previous implementation rebuilt on every selection,
      //    which could DESTROY+RECREATE the block widget mid-move —
      //    layout heights shifted under CM's vertical-nav math and
      //    the cursor landed at unpredictable spots (the reported
      //    "ArrowUp jumps multiple lines" bug).
      const oldKey = cursorTableKey(tr.startState, value.tableRanges);
      const newKey = cursorTableKey(tr.state, value.tableRanges);
      if (oldKey === newKey) {
        return value;
      }
      // Cursor crossed INTO or OUT OF a table (or moved between two
      // different tables) — the widget vs source-visible decision
      // for at least one table flipped. Rebuild.
      return scanTables(tr.state, notebookId);
    },
    provide(field) {
      return [
        EditorView.decorations.from(field, (v) => v.decorations),
        // Mark the block widget ranges as atomic so CM's selection
        // dispatcher snaps the cursor to widget edges instead of
        // landing inside the replaced range. This is what stops the
        // "ArrowUp from below the table jumps to top of doc" bug:
        // without atomicRanges, moveVertically's posAtCoords can
        // resolve a Y-coordinate to a position INSIDE the widget
        // range (which CM then renders at the START of the range,
        // many lines above where the user expected).
        EditorView.atomicRanges.of((view) => view.state.field(field).blockWidgetDecorations),
      ];
    },
  });

  const theme = EditorView.theme({
    ".cm-table-widget": {
      display: "block",
      // PAD instead of margin. The shared CSS (`utilities-markdown-table.css`)
      // sets `.md-table-wrap { margin-top: 0.5rem; margin-bottom: 0.5rem; }`
      // for breathing room in the read-mode rendering, but inside a CM
      // block-widget that pattern produces a measurement-vs-visual
      // mismatch: the inner wrap's vertical margins COLLAPSE through
      // the cm-table-widget container (which has no border/padding to
      // contain them), so `getBoundingClientRect().height` on the
      // container returns the table height EXCLUDING those 16px. CM's
      // height-map records the smaller number; click resolution Y-coords
      // then drift DOWN by 16px per table. Cumulative drift after 3
      // tables = ~48px = ~3 lines, which matches the observed bug.
      //
      // Fix: override the inner wrap to ZERO margin (already done below
      // via the descendant selector) and add equivalent PADDING on the
      // outer widget. Padding stays inside the border box, so
      // `getBoundingClientRect().height` includes it, and CM's
      // measurement matches the visual layout.
      padding: "0.5rem 0",
      margin: "0 !important",
    },
    // Neutralise the shared read-mode wrap margins inside the CM
    // widget — see the .cm-table-widget rule above for the rationale.
    ".cm-table-widget .md-table-wrap": {
      marginTop: "0 !important",
      marginBottom: "0 !important",
    },
  });

  /**
   * High-precedence ArrowUp / ArrowDown intercept — strict
   * logical-line vertical navigation, bypassing CM's Y-coord based
   * `moveVertically`.
   *
   * The CodeMirror 6.39.13 / 6.40.0 / 6.41.0 upstream fixes
   * resolved several block-widget + line-wrapping issues, but our
   * specific layout (multiple stacked block widgets + `cm-lineWrapping`
   * + `Decoration.replace({block: true})` with cursor-proximity
   * source-toggle) still triggers the cursor-jump in some cases —
   * specifically ArrowDown approaching a block widget from above,
   * where the target Y resolves past the widget instead of into
   * its source-visible range.
   *
   * This keymap intercept guarantees ONE-LINE-PER-KEYSTROKE
   * deterministic navigation: caretLine ± 1, walking past widgets
   * in a single hop when needed.
   */
  const tableNavKeymap = Prec.highest(
    keymap.of([
      { key: "ArrowUp", run: (view) => navigateLine(view, -1, false) },
      { key: "Shift-ArrowUp", run: (view) => navigateLine(view, -1, true) },
      { key: "ArrowDown", run: (view) => navigateLine(view, 1, false) },
      { key: "Shift-ArrowDown", run: (view) => navigateLine(view, 1, true) },
    ]),
  );

  function navigateLine(view: EditorView, dir: -1 | 1, extend: boolean): boolean {
    const tablesState = view.state.field(stateField, false);
    if (!tablesState || tablesState.tableRanges.length === 0) return false;

    const sel = view.state.selection.main;
    const head = sel.head;
    const caretLine = view.state.doc.lineAt(head);
    const caretCol = head - caretLine.from;

    let targetLineNumber = caretLine.number + dir;
    while (targetLineNumber >= 1 && targetLineNumber <= view.state.doc.lines) {
      const line = view.state.doc.line(targetLineNumber);
      const inside = isLineInBlockWidget(tablesState, line.from, line.to);
      if (!inside) break;
      const widgetStartLine = view.state.doc.lineAt(inside.from).number;
      const widgetEndLine = view.state.doc.lineAt(inside.to).number;
      targetLineNumber = dir < 0 ? widgetStartLine - 1 : widgetEndLine + 1;
    }

    if (targetLineNumber < 1) {
      view.dispatch({
        selection: extend ? { anchor: sel.anchor, head: 0 } : { anchor: 0 },
        scrollIntoView: true,
        userEvent: "select",
      });
      return true;
    }
    if (targetLineNumber > view.state.doc.lines) {
      const target = view.state.doc.length;
      view.dispatch({
        selection: extend ? { anchor: sel.anchor, head: target } : { anchor: target },
        scrollIntoView: true,
        userEvent: "select",
      });
      return true;
    }

    const targetLine = view.state.doc.line(targetLineNumber);
    const target = targetLine.from + Math.min(caretCol, targetLine.length);
    view.dispatch({
      selection: extend ? { anchor: sel.anchor, head: target } : { anchor: target },
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  }

  // No view-level mousedown handler — the widget's own onmousedown
  // captures the click + stopPropagation prevents CM's internal
  // logic from running posAtDOM against widget-DOM targets.
  return [stateField, theme, tableNavKeymap];
};

/** Check whether the document range [from, to] is covered by a
 *  currently-rendered block-widget decoration. Returns the table's
 *  source range when yes, null otherwise. Source-visible tables
 *  (cursor near them) are NOT in `blockWidgetDecorations`, so
 *  they don't trigger the widget-skip path. */
const isLineInBlockWidget = (state: TablesState, from: number, to: number): TableRange | null => {
  for (const r of state.tableRanges) {
    const lineOverlapsRange = from <= r.to && to >= r.from;
    if (!lineOverlapsRange) continue;
    let isWidget = false;
    state.blockWidgetDecorations.between(r.from, r.to, (decoFrom, decoTo) => {
      if (decoFrom === r.from && decoTo === r.to) {
        isWidget = true;
        return false;
      }
      return undefined;
    });
    if (isWidget) return r;
  }
  return null;
};
