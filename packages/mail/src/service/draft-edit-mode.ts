import type { sql } from "@k2b/cloud";
import type { Mailbox } from "../contracts";

/**
 * The mode a new user draft starts in: the mailbox's current setting. A draft created while an administrator switches
 * the setting may take either mode; both are complete. No row lock: draft creation must never queue behind mailbox
 * updates, and commands lock the mailbox row first.
 */
export const newDraftEditMode = async (db: typeof sql, mailboxId: string): Promise<Mailbox["draftEditMode"]> => {
  const [mailbox] = await db<{ draft_edit_mode: Mailbox["draftEditMode"] }[]>`
    SELECT draft_edit_mode FROM mail.mailboxes WHERE id = ${mailboxId}::uuid
  `;
  if (!mailbox) throw new Error("Draft mailbox is unavailable");
  return mailbox.draft_edit_mode;
};

/** PATCH and startup share this setting-only switch. Callers lock mailbox rows in ID order.
 * Open drafts retain edit_mode, doc_generation and all document history; no draft lock or conversion.
 */
export const setMailboxDraftEditMode = async (db: typeof sql, mailboxIds: string[], mode: Mailbox["draftEditMode"]): Promise<void> => {
  await db`UPDATE mail.mailboxes SET draft_edit_mode = ${mode}
    WHERE id = ANY(${db.array(mailboxIds, "UUID")})`;
};
