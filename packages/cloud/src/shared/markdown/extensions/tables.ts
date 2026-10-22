/**
 * Markdown table renderer for `marked`.
 *
 * Emits the three-layer markup that `utilities-markdown-table.css` styles:
 *   <div class="md-table-wrap">      — horizontal scroll
 *     <table class="md-table">       — layout reset
 *       <th|td>
 *         <span class="md-table-cell"> — content + alignment owner
 *
 * Per-column alignment from `:---:` syntax flows through `token.align`
 * to a `md-align-{left,center,right}` class on each cell.
 *
 * Cells starting with `=` are evaluated as formulas via the shared
 * `formula.ts` module. The computed value replaces the cell text;
 * errors render as a red-text cell with a hover-title showing the
 * full diagnostic. The same evaluator runs in the editor widget so
 * read-mode HTML and rich-edit preview stay in sync.
 *
 * Markdown tables are hand-edited and small — no pagination, no
 * NULL/datetime cell-formatting, no zebra columns. If you need any of
 * those, you're rendering data not prose; use the Grids app.
 */
import type { MarkedExtension, Tokens } from "marked";
import { type EvalContext, evaluateFormula, formatValue, isFormula, isTotalRow, type ProgressValue, parseProgressValue } from "../formula";
import { escapeHtml } from "../shared";

type Align = "left" | "right" | "center" | null;

const alignClass = (align: Align): string => {
  if (align === "right") return " md-align-right";
  if (align === "center") return " md-align-center";
  return "";
};

/** Best-effort plain-text extraction for formula evaluation. The
 *  formula evaluator only needs the raw cell value (numbers, strings),
 *  so we walk the marked-token tree and collect the text — falling
 *  back to `cell.text` if anything goes wrong. */
const cellText = (cell: Tokens.TableCell): string => {
  if (typeof cell.text === "string" && cell.text.length > 0) return cell.text;
  return "";
};

const renderProgressCell = (progress: ProgressValue, alignCls: string, title: string): string => {
  const pct = Math.round(progress.ratio * 100);
  return `<td><span class="md-table-cell md-table-progress${alignCls}" title="${escapeHtml(title)}"><span class="md-table-progress-track" aria-hidden="true"><span class="md-table-progress-fill" style="width:${pct}%"></span></span><span>${escapeHtml(progress.label)}</span></span></td>`;
};

const renderCell = (alignCls: string, originalText: string, ctx: EvalContext, htmlContent: string): string => {
  if (!isFormula(originalText)) {
    return `<td><span class="md-table-cell${alignCls}">${htmlContent}</span></td>`;
  }
  const result = evaluateFormula(originalText, ctx);
  if (result.kind === "ok") {
    const progress = parseProgressValue(result.value);
    if (progress) return renderProgressCell(progress, alignCls, originalText);
    // Computed cells get a `ti-math-function` icon prefix + blue text
    // so the user can tell at a glance which values are derived vs
    // hand-typed. Hover-title shows the original formula source.
    return `<td><span class="md-table-cell md-formula-ok${alignCls}" title="${escapeHtml(originalText)}"><i class="ti ti-math-function"></i>${escapeHtml(formatValue(result.value))}</span></td>`;
  }
  // Error: show the original formula in red + ⚠ icon, hover title
  // carries the full diagnostic. Pattern matches `md-formula-error`
  // styling in `utilities-markdown-table.css`.
  const tooltip = result.suggestion ? `${result.message}\n→ Suggestion: ${result.suggestion}` : result.message;
  return `<td><span class="md-table-cell md-formula-error${alignCls}" title="${escapeHtml(tooltip)}">⚠ ${escapeHtml(originalText)}</span></td>`;
};

export function tablesExtension(plain = false): MarkedExtension {
  return {
    renderer: {
      table(token: Tokens.Table): string {
        const align = token.align ?? [];
        // Email has no Cloud stylesheet or formula widgets. Keep alignment on the
        // structural cells and escape formula source before Markdown can interpret it.
        if (plain) {
          const cellHtml = (cell: Tokens.TableCell, tag: "th" | "td", column: number): string => {
            const alignment = align[column];
            const attribute = alignment ? ` align="${alignment}"` : "";
            const content = isFormula(cell.text) ? escapeHtml(cell.text) : this.parser.parseInline(cell.tokens);
            return `<${tag}${attribute}>${content}</${tag}>`;
          };
          const header = token.header.map((cell, column) => cellHtml(cell, "th", column)).join("");
          const rows = token.rows
            .map((row) => `<tr>${row.map((cell, column) => cellHtml(cell, "td", column)).join("")}</tr>`)
            .join("");
          return `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
        }

        // Build the EvalContext once per table — formulas reference
        // raw cell text, not other formulas' results, so a single pass
        // through the source rows is enough.
        const headers = token.header.map((h) => cellText(h));
        const rawRows = token.rows.map((row) => row.map((c) => cellText(c)));

        const headerCells = token.header
          .map((cell, i) => {
            const cls = `md-table-cell${alignClass(align[i] ?? null)}`;
            return `<th><span class="${cls}">${this.parser.parseInline(cell.tokens)}</span></th>`;
          })
          .join("");

        const rows = token.rows
          .map((row, rowIdx) => {
            const rowTexts = rawRows[rowIdx] ?? [];
            const totalRow = isTotalRow(rowTexts);
            const cells = row
              .map((cell, colIdx) => {
                const alignCls = alignClass(align[colIdx] ?? null);
                const original = cellText(cell);
                const htmlContent = this.parser.parseInline(cell.tokens);
                const ctx: EvalContext = { headers, rows: rawRows, currentRow: rowIdx, currentCol: colIdx };
                return renderCell(alignCls, original, ctx, htmlContent);
              })
              .join("");
            return totalRow ? `<tr class="md-table-total-row">${cells}</tr>` : `<tr>${cells}</tr>`;
          })
          .join("");

        return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>`;
      },
    },
  };
}
