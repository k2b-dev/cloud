import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { IconButton, prompts, Tooltip, useLocale } from "@k2b/ui";
import { PermissionEditor } from "@valentinkolb/cloud/access/ui";
import type { AccessEntry } from "@valentinkolb/cloud/contracts";
import { createMemo } from "solid-js";
import { apiClient } from "../../api/client";
import { mailSettingsMessages } from "./mail-settings-messages";

type MailAdminMailboxActionsProps = {
  mailboxId: string;
  mailboxName: string;
};

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message?.trim() || fallback;
  } catch {
    return fallback;
  }
};

type Messages = ReturnType<typeof mailSettingsMessages.resolve>["t"];

const loadAccess = async (mailboxId: string, messages: Messages): Promise<AccessEntry[]> => {
  const response = await apiClient.admin.mailboxes[":mailboxId"].access.$get({ param: { mailboxId } });
  if (!response.ok) throw new Error(await readErrorMessage(response, messages.failedLoadMailboxPermissions));
  return response.json();
};

const openPermissionDialog = async (props: MailAdminMailboxActionsProps, entries: AccessEntry[], messages: Messages) => {
  await prompts.dialog<void>(
    () => (
      <div class="flex w-full max-w-full flex-col gap-3">
        <p class="text-xs text-dimmed">{messages.mailboxAccessRepairDescription}</p>
        <PermissionEditor
          initialEntries={entries}
          canEdit
          allowAuthenticated={false}
          allowServiceAccounts
          grantAccess={async (principal, permission) => {
            const response = await apiClient.admin.mailboxes[":mailboxId"].access.$post({
              param: { mailboxId: props.mailboxId },
              json: { principal, permission },
            });
            if (!response.ok) throw new Error(await readErrorMessage(response, messages.failedGrantMailboxAccess));
            return response.json();
          }}
          updateAccess={async (accessId, permission) => {
            const response = await apiClient.admin.mailboxes[":mailboxId"].access[":accessId"].$patch({
              param: { mailboxId: props.mailboxId, accessId },
              json: { permission },
            });
            if (!response.ok) throw new Error(await readErrorMessage(response, messages.failedUpdateMailboxAccess));
          }}
          revokeAccess={async (accessId) => {
            const response = await apiClient.admin.mailboxes[":mailboxId"].access[":accessId"].$delete({
              param: { mailboxId: props.mailboxId, accessId },
            });
            if (!response.ok) throw new Error(await readErrorMessage(response, messages.failedRevokeMailboxAccess));
          }}
        />
      </div>
    ),
    { title: messages.mailboxPermissions({ name: props.mailboxName }), icon: "ti ti-shield" },
  );
  refreshCurrentPath();
};

export default function MailAdminMailboxActions(props: MailAdminMailboxActionsProps) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const accessMutation = mutation.create<AccessEntry[], void>({
    mutation: () => loadAccess(props.mailboxId, messages()),
    onSuccess: (entries) => void openPermissionDialog(props, entries, messages()),
    onError: (error) => void prompts.error(error.message),
  });

  return (
    <Tooltip.Anchor content={messages().managePermissions}>
      <IconButton
        type="button"
        class="h-7 w-7"
        label={messages().managePermissionsFor({ name: props.mailboxName })}
        disabled={accessMutation.loading()}
        onClick={() => accessMutation.mutate(undefined)}
      >
        <i class={accessMutation.loading() ? "ti ti-loader-2 animate-spin text-sm" : "ti ti-shield text-sm"} aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
}
