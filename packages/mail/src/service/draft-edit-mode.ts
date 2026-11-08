import type { sql } from "@k2b/cloud";
import type { Mailbox } from "../contracts";

/** Serialize draft creation with mailbox setting changes; keep the lock until insertion commits. */
export const newDraftEditMode = async (db: typeof sql, mailboxId: string): Promise<Mailbox["draftEditMode"]> => {
  const [mailbox] = await db<{ draft_edit_mode: Mailbox["draftEditMode"] }[]>`
    SELECT draft_edit_mode FROM mail.mailboxes WHERE id = ${mailboxId}::uuid FOR SHARE
  `;
  if (!mailbox) throw new Error("Draft mailbox is unavailable");
  return mailbox.draft_edit_mode;
};
