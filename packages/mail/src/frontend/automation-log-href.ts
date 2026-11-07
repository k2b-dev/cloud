/** The automation log of a mailbox (its public ID), optionally opened at one entry. The reader and the workspace link here. */
export const automationLogHref = (mailboxId: string, entryId?: string) =>
  `/app/mail/${encodeURIComponent(mailboxId)}/automations/log${entryId ? `?entry=${encodeURIComponent(entryId)}` : ""}`;
