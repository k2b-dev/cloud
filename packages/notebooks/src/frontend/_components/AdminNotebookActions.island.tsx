import { refreshCurrentPath } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { Button, Dropdown, Placeholder, prompts, toast, useLocale } from "@k2b/ui";
import { PermissionEditor } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { notebooksAdminMessages } from "../admin-messages";

type AdminNotebookActionsProps = {
  notebookId: string;
  notebookName: string;
};

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
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

const PermissionDialogBody = (props: AdminNotebookActionsProps) => {
  const locale = useLocale();
  const t = () => notebooksAdminMessages.resolve([locale()]).t;
  const entries = query.create({
    source: () => props.notebookId,
    load: async (notebookId, { abortSignal }): Promise<AccessEntry[]> => {
      const response = await apiClient[":id"].access.$get({ param: { id: notebookId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().loadPermissionsFailed));
      return (await response.json()) as AccessEntry[];
    },
  });
  const [reconcileError, setReconcileError] = createSignal<string | null>(null);
  const reconcile = () => {
    setReconcileError(null);
    void entries.invalidate().catch(() => setReconcileError(t().reconcilePermissionsFailed));
  };

  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <p class="text-xs text-dimmed">{t().manageAccess}</p>
      <Show when={!entries.loading()} fallback={<Placeholder state="loading" title={t().loadingAccess} />}>
        <Show
          when={entries.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              title={t().accessLoadFailed}
              description={entries.error()?.message}
              action={
                <Button type="button" variant="secondary" size="sm" onClick={() => void entries.refresh()}>
                  {t().retry}
                </Button>
              }
            />
          }
        >
          {(currentEntries) => (
            <PermissionEditor
              initialEntries={currentEntries}
              canEdit
              grantAccess={async (principal, permission) => {
                const response = await apiClient[":id"].access.$post({
                  param: { id: props.notebookId },
                  json: { principal, permission },
                });
                if (!response.ok) throw new Error(await readErrorMessage(response, t().grantFailed));
                const created = (await response.json()) as AccessEntry;
                reconcile();
                return created;
              }}
              updateAccess={async (accessId, permission) => {
                const response = await apiClient[":id"].access[":accessId"].$patch({
                  param: { id: props.notebookId, accessId },
                  json: { permission },
                });
                if (!response.ok) throw new Error(await readErrorMessage(response, t().updateAccessFailed));
                reconcile();
              }}
              revokeAccess={async (accessId) => {
                const response = await apiClient[":id"].access[":accessId"].$delete({
                  param: { id: props.notebookId, accessId },
                });
                if (!response.ok) throw new Error(await readErrorMessage(response, t().revokeAccessFailed));
                reconcile();
              }}
            />
          )}
        </Show>
      </Show>
      <Show when={reconcileError()}>
        <div class="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300">
          <span>{reconcileError()}</span>
          <Button type="button" variant="secondary" size="sm" onClick={reconcile} disabled={entries.refreshing()}>
            {t().retryReload}
          </Button>
        </div>
      </Show>
    </div>
  );
};

const openPermissionDialog = (props: AdminNotebookActionsProps) =>
  prompts.dialog<void>(() => <PermissionDialogBody {...props} />, { title: props.notebookName, icon: "ti ti-shield" });

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
              action: () => void openPermissionDialog(props),
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
        <i class="ti ti-settings text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default AdminNotebookActions;
