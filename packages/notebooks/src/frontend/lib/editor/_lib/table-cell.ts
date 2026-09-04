/**
 * Markdown table-row helpers shared by the formula-name autocomplete
 * (`table-formulas.ts`) and the column-name autocomplete
 * (`table-columns.ts`).
 *
 * Both sources need to answer the same two questions per keystroke:
 *
 *   1. Is the current line a table data row? (= begins + ends with
 *      `|`, has at least one internal `|`, isn't a separator row.)
 *   2. What's the text typed inside the current cell?
 *
 * Both checks are intentionally heuristic-only (no Lezer-`Table`
 * node lookup) because the parser doesn't promote a freshly-typed
 * row to a `Table` until the structure is complete; the heuristic
 * works during active editing.
 */

/** Matches the `|---|:--:|` separator row plus permissive variants. */
export const TABLE_SEPARATOR_RE = /^\s*\|?\s*[:\-|\s]+\|?\s*$/;

export type TableCellRange = { fromInLine: number; toInLine: number; text: string };

/** Source positions stay intact; an escaped GFM pipe belongs to its cell. */
export const splitTableLineCells = (lineText: string): TableCellRange[] => {
  const separators: number[] = [];
  let backslashes = 0;
  for (let i = 0; i < lineText.length; i++) {
    const char = lineText[i];
    if (char === "|" && backslashes % 2 === 0) separators.push(i);
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  const ranges: TableCellRange[] = [];
  let start = 0;
  for (const separator of separators) {
    if (separator === separators[0] && !lineText.slice(0, separator).trim()) {
      start = separator + 1;
      continue;
    }
    ranges.push({ fromInLine: start, toInLine: separator, text: lineText.slice(start, separator) });
    start = separator + 1;
  }
  if (start < lineText.length && (lineText.slice(start).trim() || separators.length === 0)) {
    ranges.push({ fromInLine: start, toInLine: lineText.length, text: lineText.slice(start) });
  }
  return ranges;
};

export const tableCellText = (raw: string): string => raw.trim().replace(/\\\|/g, "|");

/** Is this line a markdown table data row?
 *  - begins + ends with `|` (after trim)
 *  - has ≥ 2 pipe characters
 *  - is NOT the `---` separator row
 */
export const isTableRow = (lineText: string): boolean => {
  const trimmed = lineText.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  let backslashes = 0;
  for (let i = trimmed.length - 2; i >= 0 && trimmed[i] === "\\"; i--) backslashes++;
  if (backslashes % 2 !== 0) return false;
  if (TABLE_SEPARATOR_RE.test(lineText)) return false;
  return true;
};

/** Find the text between the nearest `|` BEFORE the cursor and the
 *  cursor itself. Returns `{ from, text }` with `from` relative to
 *  the line, or `null` if no `|` separator exists before the cursor
 *  (= cursor is in the line's row-prefix before any cell). */
export type CellTextBefore = { from: number; text: string };

export const cellTextBeforeCursor = (lineText: string, cursorCol: number): CellTextBefore | null => {
  const cell = splitTableLineCells(lineText).find((range) => range.fromInLine <= cursorCol && cursorCol <= range.toInLine);
  return cell ? { from: cell.fromInLine, text: lineText.slice(cell.fromInLine, cursorCol) } : null;
};
