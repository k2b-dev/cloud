/**
 * The history of a mailbox's retired rules (its public ID), a step of its Code page, optionally opened at one entry.
 * The reader and the workspace link here.
 */
export const automationLogHref = (mailboxId: string, entryId?: string) =>
  `/app/mail/${encodeURIComponent(mailboxId)}/code?history=1${entryId ? `&entry=${encodeURIComponent(entryId)}` : ""}`;
