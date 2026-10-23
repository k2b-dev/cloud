import {
  TextTableActionReceiptSchema as NoteTableActionReceiptSchema,
  TextTableFocusSchema as NoteTableFocusSchema,
} from "@k2b/cloud/browser/shared-text";
import { z } from "zod";

export {
  decodeTableActionIntent,
  decodeTableFocus,
  type EncodedTableActionIntent,
  EncodedTableActionIntentSchema,
  type EncodedTableFocus,
  encodeTableFocus,
  TEXT_TABLE_ACTION_MAX_LENGTH as NOTE_TABLE_ACTION_MAX_LENGTH,
  TextTableActionReceiptSchema as NoteTableActionReceiptSchema,
  type TextTableActionRequest as NoteTableActionRequest,
  TextTableActionRequestSchema as NoteTableActionRequestSchema,
  type TextTableActionResponse as NoteTableActionResponse,
  TextTableActionResponseSchema as NoteTableActionResponseSchema,
  TextTableFocusSchema as NoteTableFocusSchema,
  type TextTableIntent as NoteTableIntent,
} from "@k2b/cloud/browser/shared-text";

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
