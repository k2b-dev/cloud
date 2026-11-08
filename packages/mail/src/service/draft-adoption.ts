import type { sql } from "@k2b/cloud";
import { fail, ok, type Result } from "@k2b/stdlib";
import { draftAdoptionMessages } from "../draft-adoption-messages";
import type { MailRequestContext } from "./auth";
import { hasHumanDraftDocumentEdit } from "./draft-document-adoption";
import { mailDraftDocumentLog } from "./draft-document-log";

export const humanDraftEditor = (context: MailRequestContext): boolean =>
  context.actor.kind === "user" || context.actor.delegatedUser != null;

type Target = { db: typeof sql; draftId: string; signal?: AbortSignal };

/** Recover human provenance even when publication outlived its SQL transaction. */
export const refreshDraftAdoption = async ({ db, draftId, signal }: Target): Promise<Date | string | null> => {
  const [row] = await db<
    {
      adopted_at: Date | string | null;
      edit_mode: string;
      doc_state: Uint8Array | null;
      doc_cursor: string | null;
      doc_generation: string | number;
    }[]
  >`SELECT adopted_at, edit_mode, doc_state, doc_cursor, doc_generation
    FROM mail.drafts WHERE id = ${draftId}::uuid FOR UPDATE`;
  if (!row || row.adopted_at !== null) return row?.adopted_at ?? null;
  if (row.edit_mode !== "shared" || !row.doc_state) return null;
  const topic = mailDraftDocumentLog.topic();
  const head = await topic.latestCursor({ tenantId: draftId });
  if (!head || (row.doc_cursor && topic.cursorSequence(head) <= topic.cursorSequence(row.doc_cursor))) return null;
  const edited = await hasHumanDraftDocumentEdit({
    state: row.doc_state,
    generation: String(row.doc_generation),
    events: topic.replay({ tenantId: draftId, after: row.doc_cursor ?? topic.cursorAt(0), until: head, signal }),
  });
  if (!edited) return null;
  const [adopted] = await db<{ adopted_at: Date | string }[]>`UPDATE mail.drafts
    SET adopted_at = COALESCE(adopted_at, now()) WHERE id = ${draftId}::uuid RETURNING adopted_at`;
  return adopted?.adopted_at ?? null;
};

/** Call after access checks, inside the transaction that owns the content write. */
export const requireDraftContentWrite = async (params: Target & { context: MailRequestContext }): Promise<Result<void>> => {
  const adopted = await refreshDraftAdoption(params);
  return adopted !== null && !humanDraftEditor(params.context)
    ? fail({ code: "DRAFT_ADOPTED", status: 409, message: draftAdoptionMessages.resolve(["en"]).t.adopted })
    : ok();
};
