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
