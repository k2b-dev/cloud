import { encodeTableFocus, type TextTableIntent } from "@k2b/cloud/browser/shared-text";
import {
  planTableAction,
  prepareTableActionFocus,
  SHARED_TEXT_NAME,
  type SharedTextEditResult,
  TableActionRejectedError,
  type TableFocusWitness,
  toBase64,
} from "@k2b/cloud/shared-text";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { ConflictError } from "@k2b/sync";
import { sql } from "bun";
import * as Y from "yjs";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { type DraftDocumentSave, lockDraftDocumentInTransaction, mailDraftDocumentLog } from "./draft-documents";

export type DraftTableActionResponse = {
  changed: boolean;
  accepted: boolean | null;
  persisted: boolean;
  cursor: string | null;
  receipt: { actionId: string; update: string } | null;
  focus: ReturnType<typeof encodeTableFocus> | null;
};

/** Shares admission, row locking, snapshots and the send fence with ordinary input. */
export const applyDraftTableAction = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  generation: string;
  actionId: string;
  intent: TextTableIntent;
  focus?: TableFocusWitness;
  caret?: { row: number; column: number };
  signal?: AbortSignal;
}): Promise<Result<DraftTableActionResponse>> => {
  const reference = actorRefFromRequest(params.context);
  const actor =
    reference.kind === "user"
      ? { kind: "user" as const, id: reference.userId }
      : reference.kind === "service_account"
        ? { kind: "service_account" as const, id: reference.serviceAccountId }
        : null;
  if (!actor) return fail(err.forbidden("Draft editor is invalid"));
  const outcome: { receipt: DraftTableActionResponse | null } = { receipt: null };
  try {
    return await sql.begin(async (db) => {
      const locked = await lockDraftDocumentInTransaction({ ...params, db });
      if (!locked.ok) return locked;
      if (locked.data.generation !== params.generation)
        return fail(err.conflict("Draft generation changed; reopen before editing the table"));
      const current = await locked.data.read();
      if (!current.ok) return current;
      if (!current.data.historyComplete) return fail(err.conflict("Draft history requires recovery before editing the table"));
      const bound = mailDraftDocumentLog.withStore(locked.data.store);
      let focusState: Uint8Array | undefined;
      let focusPlan: ((text: Y.Text) => TableFocusWitness | null) | undefined;
      let result: SharedTextEditResult<DraftDocumentSave>;
      const options = { actor, signal: params.signal, actionId: params.actionId, maxLength: 2_097_152 };
      if ("receiptCursor" in params.intent) {
        result = await bound.inverse(params.draftId, {
          ...options,
          receiptCursor: params.intent.receiptCursor,
          restoreRevision: params.generation,
        });
      } else {
        const intent = params.intent;
        result = await bound.change(params.draftId, options, (snapshot) => {
          if (snapshot.restoreRevision !== params.generation) throw new Error("Draft generation changed");
          const doc = new Y.Doc();
          try {
            const state = snapshot.state();
            Y.applyUpdate(doc, state);
            const text = doc.getText(SHARED_TEXT_NAME);
            if (params.focus) {
              focusState = state;
              focusPlan = prepareTableActionFocus(text, intent, params.focus, params.caret);
            }
            return planTableAction(text, intent, 2_097_152);
          } finally {
            doc.destroy();
          }
        });
      }
      if (result.status === "notFound") return fail(err.notFound("Draft"));
      if (result.status === "syncFailed") return fail(err.conflict("Draft could not be synchronized; table text was preserved"));
      if (result.status === "unchanged")
        return ok({ changed: false, accepted: false, persisted: true, cursor: null, receipt: null, focus: null });
      let focus: DraftTableActionResponse["focus"] = null;
      if (focusState && focusPlan && result.receipt) {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, focusState);
          Y.applyUpdate(doc, result.receipt.update);
          const target = focusPlan(doc.getText(SHARED_TEXT_NAME));
          if (target) focus = encodeTableFocus(target);
        } finally {
          doc.destroy();
        }
      }
      outcome.receipt = {
        changed: true,
        accepted: true,
        persisted: result.status === "edited",
        cursor: result.cursor,
        receipt: result.receipt ? { actionId: result.receipt.actionId, update: toBase64(result.receipt.update) } : null,
        focus,
      };
      return ok(outcome.receipt);
    });
  } catch (error) {
    if (outcome.receipt) return ok({ ...outcome.receipt, persisted: false });
    if (error instanceof TableActionRejectedError || error instanceof ConflictError)
      return fail(err.conflict("Table changed; inspect the current table before another action"));
    // A lost broker acknowledgement is not proof of rejection. Reconcile first;
    // never automatically repeat a structural operation with an unknown outcome.
    return ok({ changed: false, accepted: null, persisted: false, cursor: null, receipt: null, focus: null });
  }
};
