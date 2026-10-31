/** Notebook presentation only. The public grid owns editing, focus, history and source writes. */
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";
import { i18n } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/browser";
import type { TableHost } from "@k2b/ui/text-editor";
import { displayCell, findTables, type Table } from "@k2b/ui/text-editor/model";
import { isFormula } from "../formula";
import { refreshMarkdownDecorationsEffect } from "./_lib/cursor-zone-field";
import { applyLigatures } from "./ligatures";
import {
  createPrettyTablePresentation,
  formatFormulaError,
  formatFormulaValue,
  type PrettyTableData,
  type PrettyTableOptions,
} from "./pretty-table";
import { formulaPreviewWidget } from "./tables";

export type TablePresentationOptions = Omit<PrettyTableOptions, "locale"> & {
  /** Pass the inherited UI locale accessor, not a separate locale signal. */
  locale?: () => string;
};

const copyMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { copy: "Copy result", copied: "Copied", failed: "Could not copy. Try again." },
    de: { copy: "Ergebnis kopieren", copied: "Kopiert", failed: "Kopieren fehlgeschlagen. Erneut versuchen." },
  },
});

/** Padding belongs exclusively to the evaluated view. Original header indexes and source stay intact. */
const presentationData = (table: Table): PrettyTableData => {
  const width = table.lines.reduce((width, line) => Math.max(width, line.cells.length), table.columns);
  const values = (line: Table["lines"][number] | undefined) =>
    Array.from({ length: width }, (_, column) => displayCell(line?.cells[column]?.text ?? ""));
  return { headers: values(table.lines[0]), rows: table.lines.slice(2).map(values), align: table.align };
};

const presentationTheme = EditorView.theme({
  ".k2b-ste-table .cm-notebook-formula-editor": {
    position: "absolute",
    top: "0",
    left: "0",
    width: "100%",
    minWidth: "100%",
    maxWidth: "100%",
    minHeight: "100%",
    zIndex: "5",
    background: "var(--k2b-surface)",
  },
  // One flat chip right below the edited cell, above the page so the table's scroll area never cuts it.
  ".cm-notebook-active-result": {
    position: "fixed",
    inset: "auto",
    margin: "0",
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    width: "max-content",
    height: "auto",
    maxWidth: "min(20rem, calc(100vw - 16px))",
    overflow: "visible",
    padding: "4px 8px",
    border: "0",
    borderRadius: "var(--k2b-radius-control)",
    boxShadow: "none",
    background: "var(--k2b-surface-muted)",
    color: "var(--k2b-text-secondary)",
    font: "12.5px/1.4 var(--k2b-font-sans)",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  ".cm-notebook-active-result[data-error]": { background: "var(--k2b-danger-surface)", color: "var(--k2b-danger-text)" },
  ".cm-notebook-active-result > .ti": { flex: "none", alignSelf: "center" },

  ".k2b-ste-table .k2b-ste-cell > .md-table-cell": { padding: "0", minHeight: "0" },
  ".k2b-ste-table .k2b-ste-cell > .md-table-cell.md-formula-error": {
    display: "inline-block",
    padding: "0 6px",
    borderRadius: "var(--k2b-radius-control)",
    fontFamily: "var(--k2b-font-mono)",
    fontSize: "12.5px",
  },
  ".k2b-ste-table tr:has([data-notebook-total]) > td": { borderTop: "1px solid var(--ui-border-strong)", fontWeight: "600" },
  ".cm-notebook-formula-copy": {
    display: "inline-flex",
    alignItems: "center",
    padding: "0 0.25rem",
    border: "0",
    borderRadius: "var(--k2b-radius-control)",
    background: "transparent",
    color: "var(--k2b-text-muted)",
    font: "inherit",
    cursor: "pointer",
  },
  ".cm-notebook-formula-copy:hover": { background: "var(--ui-data-row-hover)" },
  ".cm-notebook-formula-copy:focus-visible": { outline: "2px solid var(--k2b-action)", outlineOffset: "2px" },
  ".cm-notebook-formula-copy[data-failed]": { color: "var(--k2b-danger-text)" },
});

const copyButton = (element: HTMLElement, value: string, locale: string): HTMLButtonElement => {
  const t = copyMessages.resolve([locale]).t;
  const button = element.ownerDocument.createElement("button");
  button.type = "button";
  button.contentEditable = "false";
  button.className = "cm-notebook-formula-copy";
  button.setAttribute("aria-label", t.copy);
  button.setAttribute("aria-live", "polite");
  button.title = t.copy;
  button.innerHTML = '<i class="ti ti-copy" aria-hidden="true"></i>';
  // A copy press must not focus the surrounding editable cell (which would reveal source).
  button.onmousedown = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  button.onkeydown = (event) => event.stopPropagation();
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    void clipboard
      .copy(value)
      .then(
        () => {
          button.textContent = t.copied;
          button.setAttribute("aria-label", t.copied);
          delete button.dataset.failed;
        },
        () => {
          button.textContent = t.failed;
          button.setAttribute("aria-label", t.failed);
          button.dataset.failed = "";
        },
      )
      .finally(() => {
        button.disabled = false;
      });
  };
  return button;
};

/** The active formula stays over its reserved cell, with its result or error
 * right below it, described to screen readers. Reuse the same evaluation as
 * the inactive grid and exports. */
let resultIds = 0;
const activeFormulaPreview = (options: TablePresentationOptions): Extension =>
  ViewPlugin.define((view) => {
    let cell: HTMLElement | null = null;
    let result: HTMLElement | null = null;
    let alive = true;
    const place = () => {
      const box = cell?.parentElement?.getBoundingClientRect();
      if (!box || !result) return;
      result.style.left = `${Math.max(8, Math.min(box.left, innerWidth - result.offsetWidth - 8))}px`;
      result.style.top = `${box.bottom + 4}px`;
    };
    const clear = () => {
      cell?.classList.remove("cm-notebook-formula-editor");
      cell?.removeAttribute("aria-describedby");
      if (cell?.parentElement) cell.parentElement.style.removeProperty("height");
      result?.remove();
      result = null;
      cell = null;
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
    const paint = () =>
      queueMicrotask(() => {
        if (!alive) return;
        const focused = view.dom.ownerDocument.activeElement;
        const target = focused instanceof HTMLElement && focused.matches(".k2b-ste-cell") && view.dom.contains(focused) ? focused : null;
        if (target !== cell) clear();
        if (!target || !isFormula(target.textContent ?? "")) {
          clear();
          return;
        }
        const wrap = target.closest<HTMLElement>(".k2b-ste-table");
        const table = wrap && findTables(view.state.doc.toString()).find((table) => table.from === view.posAtDOM(wrap));
        const row = Number(target.dataset.r),
          column = Number(target.dataset.c);
        if (!table || row === 0) {
          clear();
          return;
        }
        if (!result) {
          const parent = target.parentElement;
          if (!parent) return;
          parent.style.height = `${parent.getBoundingClientRect().height}px`;
          result = parent.ownerDocument.createElement("div");
          result.className = "cm-notebook-active-result";
          result.id = `cm-notebook-active-result-${++resultIds}`;
          result.popover = "manual";
          result.setAttribute("role", "status");
          result.contentEditable = "false";
          parent.append(result);
          result.showPopover();
          target.classList.add("cm-notebook-formula-editor");
          target.setAttribute("aria-describedby", result.id);
          cell = target;
          addEventListener("scroll", place, true);
          addEventListener("resize", place);
        }
        const locale = options.locale?.() ?? (target.ownerDocument.documentElement.lang || "en");
        const presentation = createPrettyTablePresentation(presentationData(table), { ...options, locale });
        const evaluated = presentation.rows[row - 1]?.cells[column]?.result;
        if (!evaluated) {
          clear();
          return;
        }
        // An error says what is wrong and what helps, on one wrapping line; a valid result shows quietly.
        const error = evaluated.kind === "error";
        result.toggleAttribute("data-error", error);
        result.replaceChildren();
        if (error) {
          const icon = result.ownerDocument.createElement("i");
          icon.className = "ti ti-alert-triangle";
          icon.setAttribute("aria-hidden", "true");
          result.append(icon);
        }
        const message = result.ownerDocument.createElement("span");
        message.textContent = error
          ? formatFormulaError(evaluated, locale).replace(/\n→ /, " · ")
          : formatFormulaValue(evaluated.value, locale);
        result.append(message);
        place();
      });
    view.contentDOM.addEventListener("focusin", paint);
    view.contentDOM.addEventListener("focusout", paint);
    return {
      update(update) {
        if (update.docChanged) paint();
      },
      destroy() {
        alive = false;
        view.contentDOM.removeEventListener("focusin", paint);
        view.contentDOM.removeEventListener("focusout", paint);
        clear();
      },
    };
  });

/** Spread renderCell into the parent's existing TableHost; add extension only in grid mode.
 * This factory does not install tableGrid, the old tablesExtension, or any key handlers. */
export const createNotebookTablePresentation = (
  options: TablePresentationOptions,
): {
  renderCell: NonNullable<TableHost["renderCell"]>;
  extension: Extension;
} => {
  const snapshots = new WeakMap<Table, { locale: string; presentation: ReturnType<typeof createPrettyTablePresentation> }>();
  return {
    extension: [presentationTheme, activeFormulaPreview(options)],
    renderCell(element, _raw, table, row, column) {
      const locale = options.locale?.() ?? (element.ownerDocument.documentElement.lang || "en");
      let snapshot = snapshots.get(table);
      if (!snapshot || snapshot.locale !== locale) {
        snapshot = {
          locale,
          presentation: createPrettyTablePresentation(presentationData(table), { ...options, locale }),
        };
        snapshots.set(table, snapshot);
      }
      const presentation = snapshot.presentation;
      element.innerHTML = row === 0 ? presentation.headerHtml(column) : presentation.cellHtml(row - 1, column);
      // renderCell is also called before initial attachment; use a cell attribute
      // rather than relying on a parent row being present.
      const total = row > 0 && presentation.rows[row - 1]?.isTotalRow === true;
      element.toggleAttribute("data-notebook-total", total);
      const cell = row > 0 ? presentation.rows[row - 1]?.cells[column] : undefined;
      if (cell && isFormula(cell.raw) && cell.result.kind === "ok") {
        element.querySelector(".md-table-cell")?.append(copyButton(element, formatFormulaValue(cell.result.value, locale), locale));
      }
      // Links remain usable without focusing the cell and replacing the anchor
      // with raw source before the browser can complete its click.
      for (const link of element.querySelectorAll<HTMLAnchorElement>("a")) {
        link.contentEditable = "false";
        link.onmousedown = (event) => {
          event.preventDefault();
          event.stopPropagation();
        };
        link.onclick = (event) => event.stopPropagation();
        link.onkeydown = (event) => event.stopPropagation();
      }
      applyLigatures(element);
    },
  };
};

/** Source result chips only: no block replacement, atomic ranges or arrow navigation.
 * Install in Markdown mode. A host with mixed source/grid areas can restrict the
 * source-visible tables with sourceVisible; never decorate a replaced grid range. */
export const notebookSourceFormulasExtension = (
  options: { locale?: () => string; sourceVisible?: (state: EditorState, table: Table) => boolean } = {},
): Extension => {
  const decorate = (state: EditorState): DecorationSet => {
    const ranges: Range<Decoration>[] = [];
    const locale = options.locale?.() ?? (typeof document === "undefined" ? "en" : document.documentElement.lang || "en");
    for (const table of findTables(state.doc.toString())) {
      if (options.sourceVisible && !options.sourceVisible(state, table)) continue;
      const presentation = createPrettyTablePresentation(presentationData(table), { locale });
      table.lines.slice(2).forEach((line, row) => {
        line.cells.forEach((cell, column) => {
          const value = presentation.rows[row]?.cells[column];
          if (!value || !isFormula(value.raw)) return;
          ranges.push(Decoration.widget({ widget: formulaPreviewWidget(value.result, locale), side: 1 }).range(cell.to));
        });
      });
    }
    return Decoration.set(ranges, true);
  };
  return StateField.define<DecorationSet>({
    create: decorate,
    update: (value, tr) =>
      tr.docChanged || (options.sourceVisible && tr.selection) || tr.effects.some((effect) => effect.is(refreshMarkdownDecorationsEffect))
        ? decorate(tr.state)
        : value,
    provide: (field) => EditorView.decorations.from(field),
  });
};
