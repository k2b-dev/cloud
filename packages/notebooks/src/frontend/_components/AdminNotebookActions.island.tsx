import { openAccessDialog } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Dropdown, prompts, toast, useLocale } from "@k2b/ui";
import { onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { notebooksAdminMessages } from "../admin-messages";

type AdminNotebookActionsProps = {
  notebookId: string;
  notebookName: string;
};

const readErrorMessage = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  try {
    const data = (await response.json()) as { message?: string };
    if (typeof data?.message === "string" && data.message.length > 0) {
      return data.message;
    }
  } catch {
    // ignore parse errors and use fallback
  }
  return fallback;
};

const openPermissionDialog = async (props: AdminNotebookActionsProps, locale: string, signal: AbortSignal) => {
  const t = notebooksAdminMessages.resolve([locale]).t;
  const response = await apiClient[":id"].access.$get({ param: { id: props.notebookId } }, { init: { signal } });
  if (!response.ok) throw new Error(await readErrorMessage(response, t.loadPermissionsFailed));
  const initialEntries = (await response.json()) as AccessEntry[];
  // The page may have changed while the list loaded; never open the dialog over another page.
  if (signal.aborted) return;
  await openAccessDialog({
    resourceName: props.notebookName,
    subtitle: t.accessDialogSubtitle,
    initialEntries,
    grantAccess: async (principal, permission) => {
      const response = await apiClient[":id"].access.$post({
        param: { id: props.notebookId },
        json: { principal, permission },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.grantFailed));
      return (await response.json()) as AccessEntry;
    },
    updateAccess: async (accessId, permission) => {
      const response = await apiClient[":id"].access[":accessId"].$patch({
        param: { id: props.notebookId, accessId },
        json: { permission },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.updateAccessFailed));
    },
    revokeAccess: async (accessId) => {
      const response = await apiClient[":id"].access[":accessId"].$delete({
        param: { id: props.notebookId, accessId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.revokeAccessFailed));
    },
  });
};

const deleteNotebook = async (props: AdminNotebookActionsProps, locale: string) => {
  const t = notebooksAdminMessages.resolve([locale]).t;
  const confirmed = await prompts.confirm(t.deleteNotebookQuestion({ name: props.notebookName }), {
    title: t.deleteNotebook,
    icon: "ti ti-trash",
    confirmText: t.delete,
    variant: "danger",
  });
  if (!confirmed) return;

  const response = await apiClient[":id"].$delete({
    param: { id: props.notebookId },
  });
  if (!response.ok) {
    await prompts.error(await readErrorMessage(response, t.deleteFailed));
    return;
  }

  toast.success(t.deleted);
  refreshCurrentPath();
};

const AdminNotebookActions = (props: AdminNotebookActionsProps) => {
  const locale = useLocale();
  const t = () => notebooksAdminMessages.resolve([locale()]).t;
  const loading = new AbortController();
  onCleanup(() => loading.abort());
  // Loading the stored entries shows on the trigger; a failure says why instead of opening an empty dialog.
  const permissions = mutations.create<void, void>({
    mutation: () => openPermissionDialog(props, locale(), loading.signal),
    onError: (error) => {
      if (!loading.signal.aborted) void prompts.error(error.message);
    },
  });
  return (
    <Dropdown.Root
      position="bottom-left"
      width="13rem"
      items={[
        {
          items: [
            {
              icon: "ti ti-shield",
              label: t().permissions,
              action: () => void (permissions.loading() || permissions.mutate()),
            },
          ],
        },
        {
          items: [
            {
              icon: "ti ti-trash",
              label: t().delete,
              action: () => void deleteNotebook(props, locale()),
              variant: "danger",
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().actionsFor({ name: props.notebookName })} size="xs" tooltip={t().notebookActions}>
        <i class={permissions.loading() ? "ti ti-loader-2 animate-spin text-sm" : "ti ti-settings text-sm"} />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default AdminNotebookActions;
