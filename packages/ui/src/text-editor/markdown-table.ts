/**
 * Pure GFM table edits in original Markdown coordinates. Markdown is the only
 * model; callers reparse after applying a transaction. No repair of damaged
 * tables or prose is attempted. Extra and missing body cells remain inspectable.
 */
import type { ChangeDesc } from "@codemirror/state";
import { GFM, parser } from "@lezer/markdown";

export type Align = "left" | "center" | "right" | null;
export type Change = { from: number; to: number; insert: string };
/** Trimmed raw content, with absolute UTF-16 source offsets. */
export type Cell = { from: number; to: number; text: string };
export type Line = {
  from: number;
  to: number;
  pipes: number[];
  leadingPipe: boolean;
  trailingPipe: boolean;
  cells: Cell[];
  /** Original terminator, used when inserting rows. */
  lineBreak?: string;
};
export type Table = {
  from: number;
  to: number;
  /** Header, delimiter, then body rows. */
  lines: Line[];
  align: Align[];
  columns: number;
};

const gfm = parser.configure(GFM);
const index = (value: number) => Number.isSafeInteger(value) && value >= 0;
const normalizeBreaks = (value: string) => value.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
const splitsCharacter = (value: string, at: number): boolean => {
  const before = value.charCodeAt(at - 1),
    after = value.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
};

const parseLine = (text: string, from: number, lineBreak: string): Line => {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|") pipes.push(from + i);
  }
  const leadingPipe = pipes[0] === from + text.search(/[^ \t]/);
  const trailingPipe = pipes.length > (leadingPipe ? 1 : 0) && pipes.at(-1) === from + text.trimEnd().length - 1;
  const cells: Cell[] = [];
  let start = leadingPipe ? pipes[0]! + 1 : from;
  const addCell = (end: number) => {
    const segment = text.slice(start - from, end - from);
    const trimmed = segment.trim();
    const at = start + (trimmed ? segment.length - segment.trimStart().length : Math.min(1, segment.length));
    cells.push({ from: at, to: at + trimmed.length, text: trimmed });
  };
  for (const pipe of leadingPipe ? pipes.slice(1) : pipes) {
    addCell(pipe);
    start = pipe + 1;
  }
  if (!trailingPipe) addCell(from + text.length);
  return { from, to: from + text.length, pipes, leadingPipe, trailingPipe, cells, lineBreak };
};

const alignOf = (text: string): Align =>
  text.startsWith(":") ? (text.endsWith(":") ? "center" : "left") : text.endsWith(":") ? "right" : null;

/** Only top-level Lezer GFM tables: never code, block quotes, or list items. */
export const findTables = (doc: string): Table[] => {
  const lines: { text: string; from: number; normalizedFrom: number; lineBreak: string }[] = [];
  let from = 0,
    normalizedFrom = 0;
  for (const match of doc.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
    if (match[0] === "" && from === doc.length) break;
    const text = match[1]!,
      lineBreak = match[2]!;
    lines.push({ text, from, normalizedFrom, lineBreak });
    from += match[0].length;
    normalizedFrom += text.length + (lineBreak ? 1 : 0);
  }
  if (!lines.length) return [];
  const lineAt = (pos: number) => {
    let low = 0,
      high = lines.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lines[mid]!.normalizedFrom <= pos) low = mid;
      else high = mid;
    }
    return low;
  };
  const tree = gfm.parse(lines.map((line) => line.text + (line.lineBreak ? "\n" : "")).join(""));
  const tables: Table[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "Table") continue;
    const rows = lines.slice(lineAt(node.from), lineAt(node.to) + 1).map((line) => parseLine(line.text, line.from, line.lineBreak));
    const header = rows[0]!,
      separator = rows[1];
    if (!separator) continue;
    tables.push({
      from: header.from,
      to: rows.at(-1)!.to,
      lines: rows,
      align: separator.cells.map((cell) => alignOf(cell.text)),
      columns: header.cells.length,
    });
  }
  return tables;
};

export const tableAt = (doc: string, pos: number): Table | null =>
  findTables(doc).find((table) => pos >= table.from && pos <= table.to) ?? null;
export const gridLine = (table: Table, row: number): Line | undefined => (index(row) ? table.lines[row === 0 ? 0 : row + 1] : undefined);
export const rowCount = (table: Table): number => table.lines.length - 1;

/** Literal displayed text → safe raw content. Call once, never on existing raw Markdown. */
export const escapeCell = (value: string): string => normalizeBreaks(value).replace(/[\\|]/g, "\\$&");

/** Display text and a raw offset for every displayed UTF-16 boundary. */
export const cellDisplayMap = (raw: string): { text: string; offsets: number[] } => {
  let text = "";
  const offsets = [0];
  for (let i = 0; i < raw.length; ) {
    const escaped = raw[i] === "\\" && (raw[i + 1] === "\\" || raw[i + 1] === "|");
    text += raw[i + (escaped ? 1 : 0)]!;
    i += escaped ? 2 : 1;
    offsets.push(i);
  }
  return { text, offsets };
};
/** Decode only table pipes and backslashes; leave inline Markdown source editable. */
export const displayCell = (raw: string): string => cellDisplayMap(raw).text;

/**
 * One minimal contiguous source edit from literal displayed input. Unchanged
 * escapes keep their exact bytes, including noncanonical lone backslashes.
 * `from` is the old cell's absolute start; input must NOT be pre-escaped.
 */
export const cellChanges = (raw: string, nextDisplayed: string, from: number): Change[] => {
  const { text, offsets } = cellDisplayMap(raw);
  const next = normalizeBreaks(nextDisplayed);
  if (text === next) return [];
  let prefix = 0,
    suffix = 0;
  while (prefix < text.length && prefix < next.length && text[prefix] === next[prefix]) prefix++;
  if (splitsCharacter(text, prefix) || splitsCharacter(next, prefix)) prefix--;
  while (
    suffix < text.length - prefix &&
    suffix < next.length - prefix &&
    text[text.length - suffix - 1] === next[next.length - suffix - 1]
  )
    suffix++;
  if (splitsCharacter(text, text.length - suffix) || splitsCharacter(next, next.length - suffix)) suffix--;
  const end = offsets[text.length - suffix]!;
  let start = offsets[prefix]!;
  let insert = escapeCell(next.slice(prefix, next.length - suffix));
  // A lone slash can consume the inserted pipe escape without changing the
  // displayed text, yet expose a structural pipe. Check source parity too.
  const candidate = raw.slice(0, start) + insert + raw.slice(end);
  let exposedPipe = false,
    escaped = false;
  for (const ch of candidate) {
    if (ch === "|" && !escaped) exposedPipe = true;
    escaped = ch === "\\" && !escaped;
  }
  // Newly exposing a final lone slash could escape an adjacent closing pipe.
  // Existing trailing escapes in an untouched suffix retain their bytes.
  if ((displayCell(candidate) !== next || exposedPipe || (escaped && suffix === 0)) && prefix > 0) {
    prefix--;
    start = offsets[prefix]!;
    insert = escapeCell(next.slice(prefix, next.length - suffix));
  }
  let to = end;
  while (start < to && insert && raw[start] === insert[0] && !splitsCharacter(raw, start + 1) && !splitsCharacter(insert, 1)) {
    start++;
    insert = insert.slice(1);
  }
  while (
    start < to &&
    insert &&
    raw[to - 1] === insert.at(-1) &&
    !splitsCharacter(raw, to - 1) &&
    !splitsCharacter(insert, insert.length - 1)
  ) {
    to--;
    insert = insert.slice(0, -1);
  }
  return [{ from: from + start, to: from + to, insert }];
};

/**
 * Map an edit based on an old cell through intervening document changes.
 * Deletes only surviving old-source spans (iterGaps), preserving remote inserts
 * and excluding replaced/deleted identities. Returns current-document offsets.
 * The caller must first verify that the mapped range is still the same cell;
 * concurrent structural/escape edits require resyncing its displayed snapshot.
 */
export const mappedCellChanges = (raw: string, nextDisplayed: string, from: number, changes: ChangeDesc): Change[] => {
  const edit = cellChanges(raw, nextDisplayed, from)[0];
  if (!edit) return [];
  const result: Change[] = [];
  changes.iterGaps((oldFrom, newFrom, length) => {
    const a = Math.max(edit.from, oldFrom),
      b = Math.min(edit.to, oldFrom + length);
    if (a < b) result.push({ from: newFrom + a - oldFrom, to: newFrom + b - oldFrom, insert: "" });
  });
  if (edit.insert) {
    const at = changes.mapPos(edit.from, 1);
    const deletion = result.find((change) => change.from === at);
    if (deletion) deletion.insert = edit.insert;
    else result.push({ from: at, to: at, insert: edit.insert });
  }
  return result.sort((a, b) => a.from - b.from || a.to - b.to);
};

const appendCells = (line: Line, count: number, separator = false): Change[] =>
  count > 0
    ? [
        {
          from: line.to,
          to: line.to,
          insert: (line.trailingPipe ? "" : " |") + (separator ? " --- |" : "   |").repeat(count),
        },
      ]
    : [];

/** Spike-compatible escaped RAW input; fills ragged cells within the existing grid width. */
export const setCellText = (table: Table, row: number, col: number, next: string): Change[] => {
  const line = gridLine(table, row);
  if (!line || !index(col) || col >= width(table)) return [];
  const cell = line.cells[col];
  if (cell) return cellChanges(cell.text, displayCell(next), cell.from);
  return [
    {
      from: line.to,
      to: line.to,
      insert: (line.trailingPipe ? "" : " |") + "   |".repeat(col - line.cells.length) + ` ${escapeCell(displayCell(next))} |`,
    },
  ];
};

export const insertRow = (table: Table, after: number): Change[] => {
  const line = after === 0 ? table.lines[1] : gridLine(table, after);
  if (!line) return [];
  const newline = table.lines[0]?.lineBreak || "\n";
  return [{ from: line.to, to: line.to, insert: `${newline}|${"   |".repeat(table.columns)}` }];
};
export const deleteRow = (table: Table, row: number): Change[] => {
  const line = gridLine(table, row),
    previous = table.lines[row];
  return row > 0 && line && previous ? [{ from: previous.to, to: line.to, insert: "" }] : [];
};
const width = (table: Table) => table.lines.reduce((max, line) => Math.max(max, line.cells.length), table.columns);

/** Insert before `at`, including at the widest row's end; pad ragged rows without dropping cells. */
export const insertColumn = (table: Table, at: number): Change[] => {
  if (!index(at) || at > width(table)) return [];
  return table.lines.flatMap((line, i) => {
    if (at >= line.cells.length) return appendCells(line, at - line.cells.length + 1, i === 1);
    const pos = line.leadingPipe ? line.pipes[at]! + 1 : at === 0 ? line.from : line.pipes[at - 1]! + 1;
    return [{ from: pos, to: pos, insert: (at === 0 && !line.leadingPipe ? "|" : "") + (i === 1 ? " --- |" : "   |") }];
  });
};
/** Complete a ragged grid without changing or removing any existing cell. */
export const completeColumns = (table: Table): Change[] => {
  const columns = width(table);
  return table.lines.flatMap((line, i) => appendCells(line, columns - line.cells.length, i === 1));
};

export const deleteColumn = (table: Table, col: number): Change[] => {
  if (!index(col) || col >= width(table) || (table.columns <= 1 && col < table.columns)) return [];
  return table.lines.flatMap((line, row) => {
    if (col >= line.cells.length) return [];
    const before = line.leadingPipe ? line.pipes[col]! : col === 0 ? line.from - 1 : line.pipes[col - 1]!;
    const after = line.leadingPipe ? line.pipes[col + 1] : line.pipes[col];
    // A blank physical line would end the table and orphan later body rows.
    // Preserve a delimiter as the explicit empty row, or insert one if absent.
    if (line.cells.length === 1 && !line.leadingPipe) {
      return [{ from: line.from, to: after ?? line.to, insert: after === undefined ? "|" : "" }];
    }
    // Keep the last delimiter when reducing to one cell. Lezer additionally
    // needs a trailing delimiter on a one-cell separator (a leading one alone
    // is not recognized), so add it only on that marker line when necessary.
    if (line.cells.length === 2 && !line.trailingPipe) {
      if (col === 1) return [{ from: before + 1, to: line.to, insert: "" }];
      if (!line.leadingPipe)
        return [{ from: line.from, to: after!, insert: "" }, ...(row === 1 ? [{ from: line.to, to: line.to, insert: "|" }] : [])];
      return [{ from: before + 1, to: after! + 1, insert: "" }, ...(row === 1 ? [{ from: line.to, to: line.to, insert: "|" }] : [])];
    }
    // With omitted outer pipes, remove the preceding delimiter for the last cell.
    if (after === undefined && col > 0) return [{ from: before, to: line.to, insert: "" }];
    if (after === undefined) return [{ from: before + 1, to: line.to, insert: "" }];
    return [{ from: before + 1, to: after + 1, insert: "" }];
  });
};
export const setAlign = (table: Table, col: number, align: Align): Change[] => {
  if (!index(col)) return [];
  const cell = table.lines[1]?.cells[col];
  if (!cell) return [];
  const result: Change[] = [];
  const left = align === "left" || align === "center",
    right = align === "right" || align === "center";
  const hasLeft = cell.text.startsWith(":"),
    hasRight = cell.text.endsWith(":");
  if (left !== hasLeft) result.push({ from: cell.from, to: cell.from + Number(hasLeft), insert: left ? ":" : "" });
  if (right !== hasRight) result.push({ from: cell.to - Number(hasRight), to: cell.to, insert: right ? ":" : "" });
  return result;
};

/** First grid row is the header; pad short rows, preserve every extra cell. */
export const tableFromGrid = (grid: string[][]): string => {
  const columns = grid.reduce((max, row) => Math.max(max, row.length), 1);
  const rows = (grid.length ? grid : [[]]).map(
    (row) => `| ${Array.from({ length: columns }, (_, col) => escapeCell(row[col] ?? "")).join(" | ")} |`,
  );
  rows.splice(1, 0, `|${" --- |".repeat(columns)}`);
  return rows.join("\n");
};

/** Quoted TSV (including doubled quotes and embedded newlines). Invalid quotes stay raw. */
export const parseTsv = (text: string): string[][] | null => {
  if (!text.includes("\t")) return null;
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else cell += ch;
    } else if (ch === '"' && cell === "" && !closed) quoted = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
      closed = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      closed = false;
    } else if (closed) return null;
    else cell += ch;
  }
  if (quoted) return null;
  if (cell !== "" || row.length || closed) {
    row.push(cell);
    rows.push(row);
  }
  return rows.length ? rows : null;
};

/** Apply sorted or unsorted, non-overlapping edits in old-document coordinates. */
export const applyChanges = (doc: string, changes: Change[]): string => {
  const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
  let result = "",
    pos = 0;
  for (const change of sorted) {
    if (!index(change.from) || !index(change.to) || change.from < pos || change.to < change.from || change.to > doc.length)
      throw new RangeError("Invalid or overlapping table changes");
    result += doc.slice(pos, change.from) + change.insert;
    pos = change.to;
  }
  return result + doc.slice(pos);
};
