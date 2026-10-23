import { fromBase64, type TableActionIntent, type TableFocusWitness, toBase64 } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import { z } from "zod";

/** Approved editor limit, measured in UTF-16 code units. Rejection must preserve the existing text. */
export const NOTE_TABLE_ACTION_MAX_LENGTH = 2_097_152;

// An item relative position is one tag, two safe-integer varuints (at most
// ceil(53 / 7) bytes each), and the zero-association byte. No root-name/sentinel
// positions are accepted. The base64 bound follows this Yjs wire format.
const ITEM_ANCHOR_MAX_BYTES = 1 + 2 * Math.ceil(53 / 7) + 1;
const ITEM_ANCHOR_MAX_BASE64_LENGTH = 4 * Math.ceil(ITEM_ANCHOR_MAX_BYTES / 3);
const AnchorSchema = z
  .string()
  .min(1)
  .max(ITEM_ANCHOR_MAX_BASE64_LENGTH)
  .refine((encoded) => {
    if (encoded.length > ITEM_ANCHOR_MAX_BASE64_LENGTH) return false;
    try {
      const bytes = fromBase64(encoded);
      const position = Y.decodeRelativePosition(bytes);
      return (
        bytes.length <= ITEM_ANCHOR_MAX_BYTES &&
        position.item !== null &&
        position.assoc === 0 &&
        Number.isSafeInteger(position.item.client) &&
        position.item.client >= 0 &&
        Number.isSafeInteger(position.item.clock) &&
        position.item.clock >= 0 &&
        toBase64(Y.encodeRelativePosition(position)) === encoded
      );
    } catch {
      return false;
    }
  }, "Expected a canonical Yjs character anchor");

const TableSchema = z.object({ headerBreak: AnchorSchema, separatorHyphen: AnchorSchema }).strict();
const RowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("header") }).strict(),
  z.object({ kind: z.literal("body"), beforeBreak: AnchorSchema, inside: AnchorSchema, insideKind: z.enum(["pipe", "break"]) }).strict(),
]);
const ColumnSchema = z.object({ hyphen: AnchorSchema, left: AnchorSchema, right: AnchorSchema }).strict();

export const NoteTableFocusSchema = z.object({ table: TableSchema, row: RowSchema, column: ColumnSchema }).strict();
export type EncodedTableFocus = z.infer<typeof NoteTableFocusSchema>;
export const encodeTableFocus = (focus: TableFocusWitness): EncodedTableFocus => ({
  table: { headerBreak: toBase64(focus.table.headerBreak), separatorHyphen: toBase64(focus.table.separatorHyphen) },
  row:
    focus.row.kind === "header"
      ? focus.row
      : { ...focus.row, beforeBreak: toBase64(focus.row.beforeBreak), inside: toBase64(focus.row.inside) },
  column: { hyphen: toBase64(focus.column.hyphen), left: toBase64(focus.column.left), right: toBase64(focus.column.right) },
});
export const decodeTableFocus = (focus: EncodedTableFocus): TableFocusWitness => ({
  table: { headerBreak: fromBase64(focus.table.headerBreak), separatorHyphen: fromBase64(focus.table.separatorHyphen) },
  row:
    focus.row.kind === "header"
      ? focus.row
      : { ...focus.row, beforeBreak: fromBase64(focus.row.beforeBreak), inside: fromBase64(focus.row.inside) },
  column: { hyphen: fromBase64(focus.column.hyphen), left: fromBase64(focus.column.left), right: fromBase64(focus.column.right) },
});

export const EncodedTableActionIntentSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["moveRowUp", "moveRowDown"]), table: TableSchema, row: RowSchema, neighbor: RowSchema }).strict(),
  z.object({ action: z.enum(["moveColLeft", "moveColRight"]), table: TableSchema, column: ColumnSchema, neighbor: ColumnSchema }).strict(),
  z.object({ action: z.enum(["undo", "redo"]), receiptCursor: z.string().min(1).max(256) }).strict(),
  z
    .object({
      action: z.literal("replaceSource"),
      table: TableSchema,
      expected: z.string().max(NOTE_TABLE_ACTION_MAX_LENGTH),
      source: z.string().max(NOTE_TABLE_ACTION_MAX_LENGTH),
    })
    .strict(),
  z.object({ action: z.enum(["completeColumns", "toggleHeader", "deleteTable"]), table: TableSchema }).strict(),
  z.object({ action: z.enum(["rowAbove", "rowBelow", "deleteRow"]), table: TableSchema, row: RowSchema }).strict(),
  z
    .object({
      action: z.enum(["colLeft", "colRight", "deleteCol", "alignLeft", "alignCenter", "alignRight"]),
      table: TableSchema,
      column: ColumnSchema,
    })
    .strict(),
]);

export const NoteTableActionRequestSchema = z
  .object({
    // Notebooks stores this token in a nonnegative Postgres bigint.
    restoreRevision: z
      .string()
      .min(1)
      .max(19)
      .regex(/^(0|[1-9]\d*)$/)
      .refine((value) => value.length <= 19 && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n),
    actionId: z.uuid(),
    intent: EncodedTableActionIntentSchema,
    focus: NoteTableFocusSchema.optional(),
    caret: z
      .object({
        row: z.number().int().nonnegative().max(NOTE_TABLE_ACTION_MAX_LENGTH),
        column: z.number().int().nonnegative().max(NOTE_TABLE_ACTION_MAX_LENGTH),
      })
      .strict()
      .optional(),
  })
  .strict();

export type EncodedTableActionIntent = z.infer<typeof EncodedTableActionIntentSchema>;
export type NoteTableActionRequest = z.infer<typeof NoteTableActionRequestSchema>;

/** Decode only schema-validated transport; planning still validates identity and current context. */
export type NoteTableIntent = TableActionIntent | { action: "undo" | "redo"; receiptCursor: string };
export const decodeTableActionIntent = (intent: EncodedTableActionIntent): NoteTableIntent => {
  if ("receiptCursor" in intent) return intent;
  const table = { headerBreak: fromBase64(intent.table.headerBreak), separatorHyphen: fromBase64(intent.table.separatorHyphen) };
  if ("source" in intent) return { action: intent.action, table, expected: intent.expected, source: intent.source };
  if (!("row" in intent) && !("column" in intent)) return { action: intent.action, table };
  const decodeRow = (row: z.infer<typeof RowSchema>) =>
    row.kind === "header"
      ? row
      : { kind: "body" as const, beforeBreak: fromBase64(row.beforeBreak), inside: fromBase64(row.inside), insideKind: row.insideKind };
  const decodeColumn = (column: z.infer<typeof ColumnSchema>) => ({
    hyphen: fromBase64(column.hyphen),
    left: fromBase64(column.left),
    right: fromBase64(column.right),
  });
  if ("row" in intent) {
    const row = decodeRow(intent.row);
    return "neighbor" in intent
      ? { action: intent.action, table, row, neighbor: decodeRow(intent.neighbor) }
      : { action: intent.action, table, row };
  }
  const column = decodeColumn(intent.column);
  return "neighbor" in intent
    ? { action: intent.action, table, column, neighbor: decodeColumn(intent.neighbor) }
    : { action: intent.action, table, column };
};

export const NoteTableActionReceiptSchema = z.object({ actionId: z.uuid(), update: z.string() });
export const NoteTableActionResponseSchema = z.object({
  changed: z.boolean(),
  focus: NoteTableFocusSchema.nullable().optional(),
  cursor: z.string().nullable(),
  receipt: NoteTableActionReceiptSchema.nullable(),
});
export type NoteTableActionResponse = z.infer<typeof NoteTableActionResponseSchema>;

export const NoteTableActionErrorCodeSchema = z.enum([
  "table_action_access_denied",
  "table_action_note_not_found",
  "table_action_locked",
  "table_action_history_incomplete",
  "table_action_restore_conflict",
  "table_target_rejected",
  "table_action_conflict",
  "table_action_too_large",
  "table_action_sync_failed",
  "table_action_persist_failed",
  "table_action_outcome_unknown",
]);
export type NoteTableActionErrorCode = z.infer<typeof NoteTableActionErrorCodeSchema>;

/**
 * accepted=true means publication succeeded even if the store/projections failed.
 * accepted=null means publication may have succeeded. Neither permits automatic
 * resubmission. A receipt, when present, is the already accepted update for local
 * undo correlation. Recover current text through the existing live stream.
 */
export const NoteTableActionErrorSchema = z.object({
  message: z.string(),
  code: NoteTableActionErrorCodeSchema,
  accepted: z.boolean().nullable(),
  focus: NoteTableFocusSchema.nullable().optional(),
  cursor: z.string().nullable(),
  receipt: NoteTableActionReceiptSchema.nullable(),
});
