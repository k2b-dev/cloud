import { openAccessDialog } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { confirm, type ShowToast } from "@k2b/ui/v2";
import { apiClient } from "@/api/client";
import { notebooksAdminMessages } from "../admin-messages";

export type AdminNotebookActionsProps = {
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

/**
 * Loads the notebook's access, as stored now, and opens its dialog. Resolves once the dialog opens, not when it closes,
 * so the menu that asked closes; a failure to load throws its reason.
 */
export const openPermissionDialog = async (props: AdminNotebookActionsProps, locale: string, signal: AbortSignal) => {
  const t = notebooksAdminMessages.resolve([locale]).t;
  const response = await apiClient[":id"].access.$get({ param: { id: props.notebookId } }, { init: { signal } });
  if (!response.ok) throw new Error(await readErrorMessage(response, t.loadPermissionsFailed));
  const initialEntries = (await response.json()) as AccessEntry[];
  // The page may have changed while the list loaded; never open the dialog over another page.
  if (signal.aborted) return;
  void openAccessDialog({
    target: { type: "notebooks.notebook", id: props.notebookId },
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

/** Deletes the notebook after asking; the toast says what happened, a failure with the server's reason. */
export const deleteNotebook = async (props: AdminNotebookActionsProps, locale: string, toast: ShowToast) => {
  const t = notebooksAdminMessages.resolve([locale]).t;
  const confirmed = await confirm({
    title: t.deleteNotebook,
    description: t.deleteNotebookQuestion({ name: props.notebookName }),
    confirm: t.delete,
    cancel: t.cancel,
  });
  if (!confirmed) return;
  const response = await apiClient[":id"].$delete({
    param: { id: props.notebookId },
  });
  if (!response.ok) {
    toast(await readErrorMessage(response, t.deleteFailed), { status: "bad" });
    return;
  }
  toast(t.deleted, { status: "ok" });
  refreshCurrentPath();
};
