/** Fixed-character table intents shared by browser capture and server planning. */
import type { MenuAction, TableTarget } from "@k2b/ui/text-editor";
import * as T from "@k2b/ui/text-editor/model";
import type * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "./anchors";
import type { SharedTextChange } from "./types";

type RowAction = Extract<MenuAction, "rowAbove" | "rowBelow" | "deleteRow" | "moveRowUp" | "moveRowDown">;
type RowMove = Extract<RowAction, "moveRowUp" | "moveRowDown">;
type ColumnMove = Extract<MenuAction, "moveColLeft" | "moveColRight">;
type TableAction = Extract<MenuAction, "completeColumns" | "toggleHeader" | "deleteTable">;
type ColumnAction = Exclude<MenuAction, RowAction | TableAction>;
type TableWitness = { headerBreak: Uint8Array; separatorHyphen: Uint8Array };
type RowWitness = { kind: "header" } | { kind: "body"; beforeBreak: Uint8Array; inside: Uint8Array; insideKind: "pipe" | "break" };
type ColumnWitness = { hyphen: Uint8Array; left: Uint8Array; right: Uint8Array };

/** Transport encodes the byte arrays; no old numeric row/column survives capture. */
export type TableActionIntent =
  | { action: TableAction; table: TableWitness }
  | { action: "replaceSource"; table: TableWitness; expected: string; source: string }
  | { action: Exclude<RowAction, RowMove>; table: TableWitness; row: RowWitness }
  | { action: RowMove; table: TableWitness; row: RowWitness; neighbor: RowWitness }
  | { action: Exclude<ColumnAction, ColumnMove>; table: TableWitness; column: ColumnWitness }
  | { action: ColumnMove; table: TableWitness; column: ColumnWitness; neighbor: ColumnWitness };

/** Stable conflict for malformed, unsupported, deleted, replaced, or moved targets. */
export class TableActionRejectedError extends Error {
  readonly code = "table_target_rejected";

  constructor() {
    super("The table target is unavailable. Inspect the table and retry.");
    this.name = "TableActionRejectedError";
  }
}

export class TableActionLimitError extends RangeError {
  readonly code = "table_action_too_large";
  constructor() {
    super("The table action exceeds the document text limit");
    this.name = "TableActionLimitError";
  }
}

const reject = (): never => {
  throw new TableActionRejectedError();
};
const isIndex = (value: number) => Number.isSafeInteger(value) && value >= 0;
const isBreak = (source: string, at: number) => source[at] === "\n" || source[at] === "\r";
const hyphenAt = (cell: T.Cell) => cell.from + cell.text.indexOf("-");

// Both edges must be actual characters. Optional outer pipes use the physical
// newline instead; an omitted right pipe at EOF has no safe witness.
const columnEdges = (table: T.Table, column: number): [number, number] => {
  const separator = table.lines[1]!;
  return [
    separator.leadingPipe ? separator.pipes[column]! : column === 0 ? table.lines[0]!.to : separator.pipes[column - 1]!,
    separator.leadingPipe ? (separator.pipes[column + 1] ?? separator.to) : (separator.pipes[column] ?? separator.to),
  ];
};

/**
 * Call synchronously in structure.perform, before awaiting a flush or request.
 * The host must ensure its edits reached the server. Capture grants no access;
 * applications authorize the document and fence restore revisions externally.
 */
export const captureTableAction = (text: Y.Text, action: MenuAction, target: TableTarget): TableActionIntent => {
  if (!text.doc) return reject();
  const source = text.toString();
  const table = T.findTables(source).find((candidate) => candidate.from === target.tableFrom);
  const row = table && T.gridLine(table, target.row);
  // UI columnFrom clamps extra body cells to the last header cell. Validate that
  // offset, but never mistake it for an extra column's identity.
  const headerCell = table?.lines[0]?.cells[Math.min(target.column, table.columns - 1)];
  const width = table?.lines.reduce((max, line) => Math.max(max, line.cells.length), 0) ?? 0;
  if (
    !table ||
    !row ||
    !headerCell ||
    !isIndex(target.row) ||
    !isIndex(target.column) ||
    target.column >= width ||
    row.from !== target.rowFrom ||
    headerCell.from !== target.columnFrom
  )
    return reject();
  const anchor = (at: number) => captureTextAnchor(text, at);
  const witness: TableWitness = {
    headerBreak: anchor(table.lines[0]!.to),
    separatorHyphen: anchor(hyphenAt(table.lines[1]!.cells[0]!)),
  };
  const rowWitness = (index: number): RowWitness => {
    if (index === 0) return { kind: "header" };
    const line = T.gridLine(table, index);
    if (!line || index < 1) return reject();
    const inside = line.pipes[0] ?? line.to;
    if (!line.pipes.length && !isBreak(source, inside)) return reject();
    return {
      kind: "body",
      beforeBreak: anchor(table.lines[index]!.to),
      inside: anchor(inside),
      insideKind: line.pipes.length ? "pipe" : "break",
    };
  };
  const columnWitness = (index: number): ColumnWitness => {
    const cell = table.lines[1]!.cells[index];
    if (!cell) return reject();
    const [left, right] = columnEdges(table, index);
    if (right === table.lines[1]!.to && !isBreak(source, right)) return reject();
    return { hyphen: anchor(hyphenAt(cell)), left: anchor(left), right: anchor(right) };
  };
  switch (action) {
    case "completeColumns":
    case "toggleHeader":
    case "deleteTable":
      return { action, table: witness };
    case "rowAbove":
    case "rowBelow":
    case "deleteRow":
    case "moveRowUp":
    case "moveRowDown": {
      const row = rowWitness(target.row);
      if (action === "moveRowUp" || action === "moveRowDown") {
        const to = target.row + (action === "moveRowUp" ? -1 : 1);
        if (target.row === 0 || to < 1) return reject();
        return { action, table: witness, row, neighbor: rowWitness(to) };
      }
      return { action, table: witness, row };
    }
    case "moveColLeft":
    case "moveColRight":
    case "colLeft":
    case "colRight":
    case "deleteCol":
    case "alignLeft":
    case "alignCenter":
    case "alignRight": {
      const column = columnWitness(target.column);
      if (action === "moveColLeft" || action === "moveColRight")
        return { action, table: witness, column, neighbor: columnWitness(target.column + (action === "moveColLeft" ? -1 : 1)) };
      return { action, table: witness, column };
    }
    default:
      return reject();
  }
};

/** An explicit source draft uses the same fixed target and exact source CAS. */
export const captureTableSource = (text: Y.Text, target: TableTarget, expected: string, source: string): TableActionIntent => {
  const captured = captureTableAction(text, "completeColumns", target);
  return { action: "replaceSource", table: captured.table, expected, source };
};

/** A move changes column identity. Reissue both raw cell spans, including their
 * padding/separator identities, so stale fixed witnesses cannot target the
 * neighbor whose contents the pure text model moved into that physical slot. */
const moveColumns = (source: string, table: T.Table, column: number, to: number): SharedTextChange[] => {
  const changes = T.moveColumn(table, column, to);
  if (!changes.length) return [];
  const first = Math.min(column, to),
    last = Math.max(column, to);
  return table.lines.map((line) => {
    const from = line.leadingPipe ? line.pipes[first]! + 1 : first === 0 ? line.from : line.pipes[first - 1]! + 1;
    const end = (line.leadingPipe ? line.pipes[last + 1] : line.pipes[last]) ?? line.to;
    const edits = changes
      .filter((change) => change.from >= from && change.to <= end)
      .map((change) => ({ ...change, from: change.from - from, to: change.to - from }));
    return { from, to: end, insert: T.applyChanges(source.slice(from, end), edits), recreate: true as const };
  });
};

/**
 * Reparse a reconstructed Y.Text and plan disjoint model edits without mutation.
 * Apply in descending source order in one Yjs transaction, under the writer's
 * current-head CAS. Only an explicit source draft replaces a whole table.
 */
export const planTableAction = (text: Y.Text, intent: TableActionIntent, maxLength: number): SharedTextChange[] => {
  try {
    const source = text.toString();
    if (!Number.isSafeInteger(maxLength) || maxLength < 0) return reject();
    const resolve = (bytes: Uint8Array): number => {
      if (!(bytes instanceof Uint8Array)) return reject();
      return resolveTextAnchor(text, bytes) ?? reject();
    };
    const headerBreak = resolve(intent.table.headerBreak);
    const separatorHyphen = resolve(intent.table.separatorHyphen);
    const table = T.findTables(source).find(
      (candidate) =>
        candidate.lines[0]!.to === headerBreak &&
        candidate.lines[1]!.cells.some((cell) => separatorHyphen >= cell.from && separatorHyphen < cell.to),
    );
    if (!table || !isBreak(source, headerBreak) || source[separatorHyphen] !== "-") return reject();
    const resolveRow = (witness: RowWitness): number => {
      if (witness.kind === "header") return 0;
      if (witness.kind !== "body") return reject();
      const before = resolve(witness.beforeBreak),
        inside = resolve(witness.inside);
      if (!isBreak(source, before)) return reject();
      // The preceding newline is deleted by deleteRow. A row's own ending
      // newline alone is unsafe: deletion can leave it attached to another row.
      for (let row = 1; row < T.rowCount(table); row++) {
        const line = T.gridLine(table, row)!;
        if (table.lines[row]!.to !== before) continue;
        if (witness.insideKind === "pipe" && line.pipes.includes(inside)) return row;
        if (witness.insideKind === "break" && line.to === inside && isBreak(source, inside)) return row;
      }
      return reject();
    };
    const resolveColumn = (witness: ColumnWitness): number => {
      const hyphen = resolve(witness.hyphen),
        left = resolve(witness.left),
        right = resolve(witness.right);
      if (source[hyphen] !== "-") return reject();
      const column = table.lines[1]!.cells.findIndex((cell) => hyphen >= cell.from && hyphen < cell.to);
      if (column < 0) return reject();
      const [currentLeft, currentRight] = columnEdges(table, column);
      if (left !== currentLeft || right !== currentRight) return reject();
      if (right === table.lines[1]!.to && !isBreak(source, right)) return reject();
      return column;
    };
    const checkExpansion = (length: number) => {
      if (source.length + length > maxLength) throw new TableActionLimitError();
    };
    const columnInsertion = (column: number) => {
      let length = 0;
      for (const [row, line] of table.lines.entries()) {
        length +=
          column >= line.cells.length
            ? (line.trailingPipe ? 0 : 2) + (column - line.cells.length + 1) * (row === 1 ? 6 : 4)
            : (column === 0 && !line.leadingPipe ? 1 : 0) + (row === 1 ? 6 : 4);
        checkExpansion(length);
      }
      return T.insertColumn(table, column);
    };
    const rowInsertion = (after: number) => {
      checkExpansion((table.lines[0]?.lineBreak || "\n").length + 1 + 4 * table.columns);
      return T.insertRow(table, after);
    };
    switch (intent.action) {
      case "completeColumns": {
        const columns = table.lines.reduce((width, line) => Math.max(width, line.cells.length), table.columns);
        let length = 0;
        for (const [row, line] of table.lines.entries()) {
          const count = columns - line.cells.length;
          if (count) length += (line.trailingPipe ? 0 : 2) + count * (row === 1 ? 6 : 4);
          checkExpansion(length);
        }
        return T.completeColumns(table);
      }
      case "rowAbove":
        return rowInsertion(Math.max(0, resolveRow(intent.row) - 1));
      case "rowBelow":
        return rowInsertion(resolveRow(intent.row));
      case "deleteRow":
        return T.deleteRow(table, resolveRow(intent.row));
      case "moveRowUp": {
        const row = resolveRow(intent.row);
        const to = resolveRow(intent.neighbor);
        if (to !== row - 1) return reject();
        return T.moveRow(source, table, row, to);
      }
      case "moveRowDown": {
        const row = resolveRow(intent.row);
        const to = resolveRow(intent.neighbor);
        if (to !== row + 1) return reject();
        return T.moveRow(source, table, row, to);
      }
      case "moveColLeft": {
        const column = resolveColumn(intent.column);
        const to = resolveColumn(intent.neighbor);
        if (to !== column - 1) return reject();
        return moveColumns(source, table, column, to);
      }
      case "moveColRight": {
        const column = resolveColumn(intent.column);
        const to = resolveColumn(intent.neighbor);
        if (to !== column + 1) return reject();
        return moveColumns(source, table, column, to);
      }
      case "toggleHeader":
        return T.toggleHeader(source, table);
      case "deleteTable":
        return T.deleteTable(table);
      case "replaceSource": {
        if (source.slice(table.from, table.to) !== intent.expected) return reject();
        const replacement = T.findTables(intent.source);
        if (
          replacement.length !== 1 ||
          replacement[0]!.from !== 0 ||
          intent.source.slice(replacement[0]!.to).trim() !== "" ||
          replacement[0]!.lines.some((line) => line.cells.length > replacement[0]!.columns)
        )
          return reject();
        checkExpansion(intent.source.length - intent.expected.length);
        return intent.source === intent.expected ? [] : [{ from: table.from, to: table.to, insert: intent.source }];
      }
      case "colLeft":
        return columnInsertion(resolveColumn(intent.column));
      case "colRight":
        return columnInsertion(resolveColumn(intent.column) + 1);
      case "deleteCol":
        return T.deleteColumn(table, resolveColumn(intent.column));
      case "alignLeft":
        return T.setAlign(table, resolveColumn(intent.column), "left");
      case "alignCenter":
        return T.setAlign(table, resolveColumn(intent.column), "center");
      case "alignRight":
        return T.setAlign(table, resolveColumn(intent.column), "right");
      default:
        return reject();
    }
  } catch (error) {
    if (error instanceof TableActionLimitError) throw error;
    // Transport may supply invalid shapes/bytes despite the static type. Every
    // rejected intent has the same public error, and planning never edits text.
    return reject();
  }
};

/** A focus target is resolved against current identities immediately before use. */
export type TableFocusWitness = { table: TableWitness; row: RowWitness; column: ColumnWitness };
export const captureTableFocus = (text: Y.Text, target: TableTarget): TableFocusWitness => {
  const row = captureTableAction(text, "rowBelow", target);
  const column = captureTableAction(text, "alignLeft", target);
  if (!("row" in row) || !("column" in column)) return reject();
  return { table: row.table, row: row.row, column: column.column };
};
export const resolveTableFocus = (text: Y.Text, witness: TableFocusWitness): TableTarget | null => {
  try {
    const source = text.toString();
    const at = (bytes: Uint8Array) => resolveTextAnchor(text, bytes);
    const table = T.findTables(source).find(
      (table) =>
        table.lines[0]!.to === at(witness.table.headerBreak) &&
        table.lines[1]!.cells.some((cell) => {
          const hyphen = at(witness.table.separatorHyphen);
          return hyphen !== null && hyphen >= cell.from && hyphen < cell.to;
        }),
    );
    if (!table) return null;
    const hyphen = at(witness.column.hyphen);
    const column = table.lines[1]!.cells.findIndex((cell) => hyphen !== null && hyphen >= cell.from && hyphen < cell.to);
    if (column < 0 || source[hyphen!] !== "-") return null;
    const edges = columnEdges(table, column);
    if (at(witness.column.left) !== edges[0] || at(witness.column.right) !== edges[1]) return null;
    const rowWitness = witness.row;
    const row =
      rowWitness.kind === "header"
        ? 0
        : Array.from({ length: T.rowCount(table) - 1 }, (_, index) => index + 1).find((index) => {
            const line = T.gridLine(table, index)!;
            return (
              table.lines[index]!.to === at(rowWitness.beforeBreak) &&
              (rowWitness.insideKind === "pipe" ? line.pipes.includes(at(rowWitness.inside) ?? -1) : line.to === at(rowWitness.inside))
            );
          });
    if (row === undefined) return null;
    return { tableFrom: table.from, rowFrom: T.gridLine(table, row)!.from, columnFrom: table.lines[0]!.cells[column]!.from, row, column };
  } catch {
    return null;
  }
};

/** Resolve the selection at the planned head, then capture the ACTUAL receipt IDs. */
export const prepareTableActionFocus = (
  before: Y.Text,
  intent: TableActionIntent,
  focus: TableFocusWitness,
  caret?: { row: number; column: number },
): ((after: Y.Text) => TableFocusWitness | null) => {
  const target = resolveTableFocus(before, focus);
  const table = target && T.findTables(before.toString()).find((table) => table.from === target.tableFrom);
  if (!target || !table || resolveTextAnchor(before, intent.table.headerBreak) !== table.lines[0]!.to) return () => null;
  let { row, column } = target;
  // Row/column intents must identify the same selected identity. The request's
  // optional focus is presentation, never authority to change another target.
  if ("row" in intent) {
    const selected = resolveTableFocus(before, { ...focus, row: intent.row });
    if (!selected || selected.row !== row) return () => null;
  }
  if ("column" in intent) {
    const selected = resolveTableFocus(before, { ...focus, column: intent.column });
    if (!selected || selected.column !== column) return () => null;
  }
  switch (intent.action) {
    case "deleteTable":
      return () => null;
    case "rowAbove":
      row = Math.max(1, row);
      break;
    case "rowBelow":
      row++;
      break;
    case "moveRowUp":
      row--;
      break;
    case "moveRowDown":
      row++;
      break;
    case "colRight":
    case "moveColRight":
      column++;
      break;
    case "moveColLeft":
      column--;
      break;
    case "toggleHeader":
      row = table.lines[0]!.cells.some((cell) => cell.text) ? row + 1 : Math.max(0, row - 1);
      break;
    case "replaceSource":
      row = caret?.row ?? row;
      column = caret?.column ?? column;
      break;
  }
  const from = table.from;
  return (after) => {
    const table = T.findTables(after.toString()).find((table) => table.from === from);
    if (!table) return null;
    const selectedRow = Math.max(0, Math.min(row, T.rowCount(table) - 1));
    const selectedColumn = Math.max(0, Math.min(column, table.columns - 1));
    try {
      return captureTableFocus(after, {
        tableFrom: table.from,
        rowFrom: T.gridLine(table, selectedRow)!.from,
        columnFrom: table.lines[0]!.cells[selectedColumn]!.from,
        row: selectedRow,
        column: selectedColumn,
      });
    } catch {
      return null;
    }
  };
};
