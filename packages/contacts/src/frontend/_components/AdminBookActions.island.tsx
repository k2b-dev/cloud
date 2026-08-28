import { refreshCurrentPath } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { Button, Dropdown, Placeholder, prompts, useLocale } from "@k2b/ui";
import { type GrantableLevel, PermissionEditor } from "@valentinkolb/cloud/access/ui";
import type { AccessEntry, Principal } from "@valentinkolb/cloud/contracts";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { readErrorMessage } from "./api";
import { bookMessages } from "./book-messages";
import { createQueuedReconciliation } from "./book-settings-reconcile";

type AdminBookActionsProps = {
  bookId: string;
  bookName: string;
};

const PermissionDialogBody = (props: AdminBookActionsProps) => {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const entries = query.create<string, AccessEntry[]>({
    source: () => props.bookId,
    load: async (bookId, { abortSignal }) => {
      const response = await apiClient.admin.books[":bookId"].access.$get({ param: { bookId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().loadPermissionsFailed));
      return response.json();
    },
  });
  const [reconcileError, setReconcileError] = createSignal<string | null>(null);
  const [reconciling, setReconciling] = createSignal(false);
  let disposed = false;
  const coverage = createQueuedReconciliation(entries.invalidate, (state) => {
    setReconciling(state.reconciling);
    setReconcileError(state.error);
  });
  const reconcile = () => coverage.run(t().accessSavedReloadFailed);
  const coverageBlocked = () => reconciling() || reconcileError() !== null;
  const requestControllers = new Set<AbortController>();
  const runRequest = async <T,>(request: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (disposed) throw new DOMException(t().permissionsClosedAbort, "AbortError");
    if (coverageBlocked() || requestControllers.size > 0) throw new Error(t().permissionChangeInProgress);
    const controller = new AbortController();
    requestControllers.add(controller);
    try {
      const result = await request(controller.signal);
      if (disposed) throw new DOMException(t().permissionsClosedAbort, "AbortError");
      return result;
    } finally {
      requestControllers.delete(controller);
    }
  };
  const grant = async (input: { bookId: string; principal: Principal; permission: GrantableLevel }): Promise<AccessEntry> => {
    const created = await runRequest(async (abortSignal) => {
      const response = await apiClient.admin.books[":bookId"].access.$post(
        { param: { bookId: input.bookId }, json: { principal: input.principal, permission: input.permission } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().adminGrantAccessFailed));
      return response.json();
    });
    reconcile();
    return created;
  };
  const update = async (input: { bookId: string; accessId: string; permission: GrantableLevel }): Promise<void> => {
    await runRequest(async (abortSignal) => {
      const response = await apiClient.admin.books[":bookId"].access[":accessId"].$patch(
        { param: { bookId: input.bookId, accessId: input.accessId }, json: { permission: input.permission } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().adminUpdateAccessFailed));
    });
    reconcile();
  };
  const revoke = async (input: { bookId: string; accessId: string }): Promise<void> => {
    await runRequest(async (abortSignal) => {
      const response = await apiClient.admin.books[":bookId"].access[":accessId"].$delete(
        { param: { bookId: input.bookId, accessId: input.accessId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().adminRevokeAccessFailed));
    });
    reconcile();
  };
  onCleanup(() => {
    disposed = true;
    for (const controller of requestControllers) controller.abort();
    requestControllers.clear();
    coverage.dispose();
  });

  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <p class="text-xs text-dimmed">{t().manageAccessHint}</p>
      <Show when={!entries.loading()} fallback={<Placeholder state="loading" variant="compact" title={t().loadingAccess} />}>
        <Show
          when={entries.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              variant="compact"
              title={t().loadAccessErrorTitle}
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
              initialEntries={currentEntries.filter((entry) => entry.principal.type !== "service_account")}
              canEdit={!coverageBlocked()}
              grantAccess={async (principal, permission) => {
                return grant({ bookId: props.bookId, principal, permission });
              }}
              updateAccess={async (accessId, permission) => {
                await update({ bookId: props.bookId, accessId, permission });
              }}
              revokeAccess={async (accessId) => {
                await revoke({ bookId: props.bookId, accessId });
              }}
            />
          )}
        </Show>
      </Show>
      <Show when={reconcileError()}>
        <div class="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300" role="status">
          <span>{reconcileError()}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void coverage.retry()} disabled={reconciling()}>
            {t().retryReload}
          </Button>
        </div>
      </Show>
    </div>
  );
};

const openPermissionDialog = async (props: AdminBookActionsProps) => {
  await prompts.dialog<void>(() => <PermissionDialogBody {...props} />, { title: props.bookName, icon: "ti ti-shield" });
  refreshCurrentPath();
};

const AdminBookActions = (props: AdminBookActionsProps) => {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  return (
    <Dropdown.Root
      position="bottom-left"
      width="13rem"
      items={[
        {
          items: [
            {
              icon: "ti ti-shield",
              label: t().permissionsLabel,
              action: () => void openPermissionDialog(props),
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().managePermissionsFor({ name: props.bookName })} size="xs" tooltip={t().managePermissions}>
        <i class="ti ti-settings text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default AdminBookActions;
