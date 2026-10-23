import type { sql } from "bun";
import type { MailRequestContext } from "./auth";
import { lockDraftDocumentInTransaction } from "./draft-documents";

/** Call in the attachment mutation's transaction after its revision bump. */
export const recordDraftDocumentRevision = async (params: {
  db: typeof sql;
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
}): Promise<void> => {
  const [row] = await params.db<{ edit_mode: "lock" | "shared" }[]>`
    SELECT edit_mode FROM mail.drafts WHERE id = ${params.draftId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid AND origin = 'user' FOR UPDATE
  `;
  if (!row || row.edit_mode !== "shared") return;
  const locked = await lockDraftDocumentInTransaction(params);
  if (!locked.ok) throw Object.assign(new Error(locked.error.message), locked.error);
  const recorded = await locked.data.recordRevisionBase();
  // Throw to roll back the attachment and revision together, never leave a
  // revision whose document identities cannot be authenticated by old clients.
  if (!recorded.ok) throw Object.assign(new Error(recorded.error.message), recorded.error);
};
