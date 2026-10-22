/** Fixed-character table intents shared by browser capture and server planning. */
import type { MenuAction, TableTarget } from "@k2b/ui/text-editor";
import * as T from "@k2b/ui/text-editor/model";
import type * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "./anchors";

type RowAction = Extract<MenuAction, "rowAbove" | "rowBelow" | "deleteRow">;
type ColumnAction = Exclude<MenuAction, RowAction | "completeColumns">;
type TableWitness = { headerBreak: Uint8Array; separatorHyphen: Uint8Array };
type RowWitness = { kind: "header" } | { kind: "body"; beforeBreak: Uint8Array; inside: Uint8Array; insideKind: "pipe" | "break" };
type ColumnWitness = { hyphen: Uint8Array; left: Uint8Array; right: Uint8Array };

/** Transport encodes the byte arrays; no old numeric row/column survives capture. */
export type TableActionIntent =
  | { action: "completeColumns"; table: TableWitness }
  | { action: RowAction; table: TableWitness; row: RowWitness }
  | { action: ColumnAction; table: TableWitness; column: ColumnWitness };

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
  switch (action) {
    case "completeColumns":
      return { action, table: witness };
    case "rowAbove":
    case "rowBelow":
    case "deleteRow": {
      if (target.row === 0) return { action, table: witness, row: { kind: "header" } };
      const inside = row.pipes[0] ?? row.to;
      if (!row.pipes.length && !isBreak(source, inside)) return reject();
      return {
        action,
        table: witness,
        row: {
          kind: "body",
          beforeBreak: anchor(table.lines[target.row]!.to),
          inside: anchor(inside),
          insideKind: row.pipes.length ? "pipe" : "break",
        },
      };
    }
    case "colLeft":
    case "colRight":
    case "deleteCol":
    case "alignLeft":
    case "alignCenter":
    case "alignRight": {
      const cell = table.lines[1]!.cells[target.column];
      if (!cell) return reject(); // Ragged extras need completeColumns first.
      const [left, right] = columnEdges(table, target.column);
      if (right === table.lines[1]!.to && !isBreak(source, right)) return reject();
      return { action, table: witness, column: { hyphen: anchor(hyphenAt(cell)), left: anchor(left), right: anchor(right) } };
    }
    default:
      return reject();
  }
};

/**
 * Reparse a reconstructed Y.Text and plan disjoint model edits without mutation.
 * Apply in descending source order in one Yjs transaction, under the writer's
 * current-head CAS. Never collapse these edits into a whole-table replacement.
 */
export const planTableAction = (text: Y.Text, intent: TableActionIntent, maxLength: number): T.Change[] => {
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
