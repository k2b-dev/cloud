import { openAccessDialog } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { apiClient } from "../../api/client";
import type { mailSettingsMessages } from "./mail-settings-messages";
import { mailboxAccessLevels, mailboxAccessScope } from "./mailbox-access-levels";

export type MailboxAccessTarget = {
  mailboxId: string;
  mailboxName: string;
};

const readErrorMessage = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message?.trim() || fallback;
  } catch {
    return fallback;
  }
};

export type MailboxAccessMessages = ReturnType<typeof mailSettingsMessages.resolve>["t"];

const loadAccess = async (mailboxId: string, messages: MailboxAccessMessages): Promise<AccessEntry[]> => {
  const response = await apiClient.admin.mailboxes[":mailboxId"].access.$get({ param: { mailboxId } });
  if (!response.ok) throw new Error(await readErrorMessage(response, messages.failedLoadMailboxPermissions));
  return response.json();
};

const openPermissionDialog = async (
  props: MailboxAccessTarget,
  entries: AccessEntry[],
  messages: MailboxAccessMessages,
  locale: string,
) => {
  // Set by every saved change, also when a later one fails and the person discards the rest.
  let wrote = false;
  await openAccessDialog({
    target: { type: "mail.mailbox", id: props.mailboxId },
    resourceName: props.mailboxName,
    subtitle: messages.mailboxAccessRepairDescription,
    initialEntries: entries,
    allowAuthenticated: false,
    allowedLevels: mailboxAccessLevels(locale),
    grantAccess: async (principal, permission, _display, scope) => {
      const response = await apiClient.admin.mailboxes[":mailboxId"].access.$post({
        param: { mailboxId: props.mailboxId },
        json: { principal, permission, scope: mailboxAccessScope(scope) },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, messages.failedGrantMailboxAccess));
      wrote = true;
      return response.json();
    },
    updateAccess: async (accessId, permission, scope) => {
      const response = await apiClient.admin.mailboxes[":mailboxId"].access[":accessId"].$patch({
        param: { mailboxId: props.mailboxId, accessId },
        json: { permission, scope: mailboxAccessScope(scope) },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, messages.failedUpdateMailboxAccess));
      wrote = true;
    },
    revokeAccess: async (accessId) => {
      const response = await apiClient.admin.mailboxes[":mailboxId"].access[":accessId"].$delete({
        param: { mailboxId: props.mailboxId, accessId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, messages.failedRevokeMailboxAccess));
      wrote = true;
    },
  });
  if (wrote) refreshCurrentPath();
};

/**
 * Opens the shared access dialog of one mailbox for an administrator, loaded fresh, and shows the page again when a
 * change was saved. Throws the server's reason when the access cannot be loaded.
 */
export const repairMailboxAccess = async (target: MailboxAccessTarget, messages: MailboxAccessMessages, locale: string) =>
  openPermissionDialog(target, await loadAccess(target.mailboxId, messages), messages, locale);
