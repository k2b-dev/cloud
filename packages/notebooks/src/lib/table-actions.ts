import { fromBase64, type TableActionIntent, toBase64 } from "@k2b/cloud/shared-text";
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

export const EncodedTableActionIntentSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("completeColumns"), table: TableSchema }).strict(),
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
  })
  .strict();

export type EncodedTableActionIntent = z.infer<typeof EncodedTableActionIntentSchema>;
export type NoteTableActionRequest = z.infer<typeof NoteTableActionRequestSchema>;

/** Decode only schema-validated transport; planning still validates identity and current context. */
export const decodeTableActionIntent = (intent: EncodedTableActionIntent): TableActionIntent => {
  const table = { headerBreak: fromBase64(intent.table.headerBreak), separatorHyphen: fromBase64(intent.table.separatorHyphen) };
  if (intent.action === "completeColumns") return { action: intent.action, table };
  if ("row" in intent)
    return {
      action: intent.action,
      table,
      row:
        intent.row.kind === "header"
          ? intent.row
          : {
              kind: "body",
              beforeBreak: fromBase64(intent.row.beforeBreak),
              inside: fromBase64(intent.row.inside),
              insideKind: intent.row.insideKind,
            },
    };
  return {
    action: intent.action,
    table,
    column: {
      hyphen: fromBase64(intent.column.hyphen),
      left: fromBase64(intent.column.left),
      right: fromBase64(intent.column.right),
    },
  };
};

export const NoteTableActionReceiptSchema = z.object({ actionId: z.uuid(), update: z.string() });
export const NoteTableActionResponseSchema = z.object({
  changed: z.boolean(),
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
  cursor: z.string().nullable(),
  receipt: NoteTableActionReceiptSchema.nullable(),
});
