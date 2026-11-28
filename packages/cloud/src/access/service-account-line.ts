import { accessDialogMessages } from "./access-dialog-messages";

/**
 * What a service account is, as the server describes it, and what it may: "Service account of a mailbox · may edit".
 * Read-only, the level stands there alone instead of beside the row.
 */
export const serviceAccountLine = (locale: string, account: { description?: string; level?: string; readOnly?: boolean }) => {
  const t = accessDialogMessages.resolve([locale]).t;
  const description = account.description || t.serviceAccount;
  if (!account.level) return description;
  return account.readOnly ? t.accountMayAlone({ level: account.level }) : `${description} · ${t.accountMay({ level: account.level })}`;
};
