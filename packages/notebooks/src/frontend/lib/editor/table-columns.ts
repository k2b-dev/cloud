/**
 * Autocomplete für Spaltennamen in Tabellen-Formel-Argumenten.
 *
 * Trigger: cursor sits inside the parentheses of a formula call in
 * a table cell — i.e. after `=FUNC(` or after `=FUNC(arg, `. The
 * partial word being typed (or empty after `(` / `,`) is matched
 * against the column names in the current table's header row.
 *
 * Examples (`|` = cursor position):
 *
 *   | =SUM(|              → columns
 *   | =SUM(Co|            → columns starting with "Co"
 *   | =IF(ColA, |         → columns (for the second argument)
 *   | =IF(ColA, ColB, Co| → columns starting with "Co"
 *
 * # Header detection
 *
 * Markdown tables are anchored by their separator row (`|---|---|`).
 * The HEADER is the line immediately before the separator. We walk
 * backwards from the cursor line — at most a handful of lines for
 * any realistic table — and return the cells of the line above the
 * first separator we hit. If we hit a non-table line before any
 * separator (e.g. cursor IS on the header line), the table is
 * malformed or we're typing into the header itself; return no
 * suggestions either way.
 *
 * # Performance
 *
 * Hot-path cost when NOT inside a table: a single `lineAt` call +
 * `isTableRow` check on the current line text. ~µs. Once we know
 * we're in a table cell, the in-cell regex match is the next gate.
 * Header lookup only runs after both pass.
 *
 * Header extraction is O(table height) — bounded by table size,
 * not document size. A 50-row table costs ~50 line reads, sub-ms.
 *
 * # Scope
 *
 * No fenced-code check needed — the table-row gate already
 * excludes code-block context (Markdown tables aren't recognised
 * inside fenced blocks; lines that begin and end with `|` inside a
 * code fence are just literal pipe characters, and the user is
 * not editing a table there).
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorState } from "@codemirror/state";
import { cellTextBeforeCursor, isTableRow, TABLE_SEPARATOR_RE } from "./_lib/table-cell";
import { withIcon } from "./completion-icon";

const isSeparatorRow = (lineText: string): boolean => TABLE_SEPARATOR_RE.test(lineText);

/** Walk backwards from the cursor's line to find the table's
 *  separator row, then return the cells of the line immediately
 *  before it (the header). Empty array if no header is reachable
 *  (cursor is on the header line, or the table has no separator). */
const extractHeaderColumns = (state: EditorState, currentLineNumber: number): string[] => {
  for (let n = currentLineNumber - 1; n >= 1; n--) {
    const lineText = state.doc.line(n).text;
    if (isSeparatorRow(lineText)) {
      // Header is the line just above the separator. If we'd run
      // off the doc start, there's no header.
      if (n - 1 < 1) return [];
      const headerText = state.doc.line(n - 1).text;
      return splitHeaderCells(headerText);
    }
    if (!isTableRow(lineText)) {
      // Hit a non-table line before finding the separator —
      // current cursor is above or outside the header section.
      return [];
    }
  }
  return [];
};

/** Split a header row into cell labels. Strips the leading/trailing
 *  pipes and trims whitespace from each cell. */
const splitHeaderCells = (lineText: string): string[] => {
  return lineText
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
};

/** Match: cursor is positioned at the END of cell text that looks
 *  like a partial formula call with an open-but-unclosed paren —
 *  i.e. we're inside the argument list and the user is typing a
 *  word fragment (or nothing yet, right after `(` or `,`).
 *
 *  Captures the partial word being typed at position 1 (may be the
 *  empty string when cursor sits right after `(` or `, `).
 *
 *  Examples that match (`|` = cursor, capture group in []):
 *    `=SUM(|`              → []
 *    `=SUM(Co|`            → [Co]
 *    `=IF(ColA, |`         → []
 *    `=IF(ColA, ColB, Co|` → [Co]
 *
 *  Doesn't match once the paren closes — by then the user is past
 *  argument entry. */
const FORMULA_ARG_RE = /=\w+\([^)]*?(\w*)$/;

/** Strict identifier pattern matching what the formula tokenizer
 *  accepts as a bare IDENT (see `isIdentStart` / `isIdentChar` in
 *  `cloud/shared/markdown/formula.ts`): `[a-zA-Z_]` to start, then
 *  word chars. Anything else needs backtick quoting. */
const BARE_IDENT_RE = /^[a-zA-Z_]\w*$/;

/** Wrap a column name for safe insertion into formula source.
 *  - Bare identifiers → returned as-is.
 *  - Everything else (spaces, parens, `%`, leading digit, …) →
 *    backtick-quoted with `\\` and `\\\`` escapes, mirroring the
 *    backtick-ident tokenizer rules in `formula.ts`.
 *
 *  `userTypedBacktick = true` means the user already typed an
 *  opening backtick before our `partialFrom`; we then emit ONLY
 *  the escaped body + a closing backtick so the result reads as
 *  `` `Tax (19%)` `` rather than `` ``Tax (19%)` `` (which would
 *  fail to parse as an identifier). */
const buildColumnApply = (col: string, userTypedBacktick: boolean): string => {
  if (!userTypedBacktick && BARE_IDENT_RE.test(col)) return col;
  const escaped = col.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  return userTypedBacktick ? `${escaped}\`` : `\`${escaped}\``;
};

/**
 * Completion source. Wire after `tableFormulaCompletionSource` in
 * the `autocompletion({override: …})` array.
 */
export const tableColumnCompletionSource = (context: CompletionContext): CompletionResult | null => {
  // Stage 1 — cheap: must be on a line that LOOKS like a table row.
  const line = context.state.doc.lineAt(context.pos);
  if (!isTableRow(line.text)) return null;

  // Stage 2 — must be in a cell that has formula-call-with-open-paren
  // shape leading up to the cursor.
  const cursorCol = context.pos - line.from;
  const cell = cellTextBeforeCursor(line.text, cursorCol);
  if (!cell) return null;
  const match = FORMULA_ARG_RE.exec(cell.text);
  if (!match) return null;

  // Stage 3 — extract the table header (one walk-backwards, capped
  // at the table's vertical size).
  const columns = extractHeaderColumns(context.state, line.number);
  if (columns.length === 0) return null;

  // Build completions. `completionIcon` is set via structural cast (same
  // pattern as the other completion sources) so the option-list shows a
  // distinct glyph (`ti-columns-3`) for column entries — visually
  // separates them from ordinary identifiers.
  //
  // The `apply` text is computed per-completion based on whether
  // the column name needs backtick-quoting AND whether the user
  // has already typed an opening backtick. Without this the
  // autocomplete would insert raw `Tax (19%)` for a special-char
  // column, which the formula parser rejects (`%` is not a valid
  // identifier char). With the quoting it emits `` `Tax (19%)` ``,
  // which is what the formula tokenizer accepts via its
  // backtick-ident rule.
  const partial = match[1] ?? "";
  const partialFrom = context.pos - partial.length;
  // Check whether the char immediately before our match start is a
  // backtick — that signals the user is already typing inside a
  // quoted-ident, so our apply should NOT add another opening
  // backtick (would produce ``…` which doesn't parse).
  const charBefore = partialFrom > 0 ? context.state.sliceDoc(partialFrom - 1, partialFrom) : "";
  const userTypedBacktick = charBefore === "`";

  const options: Completion[] = columns.map((col) => {
    const c: Completion = {
      // `label` is the raw column name — used both for the popup
      // display AND for CM's prefix filter. So a user typing "Tax"
      // narrows to "Tax (19%)" even though the actual inserted
      // text is the backtick-quoted form.
      label: col,
      type: "property",
      detail: "column",
      apply: buildColumnApply(col, userTypedBacktick),
    };
    withIcon(c, "ti-columns-3");
    return c;
  });

  return {
    from: partialFrom,
    to: context.pos,
    options,
    validFor: /^\w*$/,
  };
};
