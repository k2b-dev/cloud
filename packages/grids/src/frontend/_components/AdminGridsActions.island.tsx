import { openAccessDialog, principalLabel } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts/shared";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Dropdown, IconButton, prompts, toast, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { unshadowedGrants } from "@/access-precedence";
import { apiClient } from "@/api/client";
import { gridsAdminMessages } from "../admin-messages";

type AdminGridsActionsProps = {
  baseId: string;
  baseName: string;
};

type ScopedAccessEntry = AccessEntry & {
  resourceType: "base" | "customApp";
  resourceId: string;
  resourceName: string;
  tableId: string | null;
  tableName: string | null;
};

const readErrorMessage = (_response: unknown, fallback: string): Promise<string> => Promise.resolve(fallback);

const listBaseAccess = async (baseId: string, fallback: string): Promise<ScopedAccessEntry[]> => {
  const response = await apiClient.admin.bases[":baseId"].access.$get({
    param: { baseId },
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, fallback));
  return (await response.json()) as ScopedAccessEntry[];
};

/** App access, listed under the base's own access. Apps never inherit the base's access; revoking applies right away. */
const AppAccessList = (props: { baseId: string; entries: ScopedAccessEntry[] }) => {
  const locale = useLocale();
  const t = () => gridsAdminMessages.resolve([locale()]).t;
  const label = (entry: AccessEntry) => principalLabel(entry, locale());
  const permissionLabel = (permission: AccessEntry["permission"]) => {
    if (permission === "none") return t().permissionNone;
    if (permission === "read") return t().permissionRead;
    if (permission === "write") return t().permissionWrite;
    return t().permissionAdmin;
  };
  const [entries, setEntries] = createSignal(props.entries);
  const revoke = mutations.create<ScopedAccessEntry, ScopedAccessEntry>({
    mutation: async (entry) => {
      const response = await apiClient.admin.bases[":baseId"].access[":accessId"].$delete({
        param: { baseId: props.baseId, accessId: entry.id },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().revokeAppFailed));
      return entry;
    },
    onSuccess: (entry) => {
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      toast.success(t().appAccessRevoked);
    },
    onError: (err) => prompts.error(err.message),
  });
  return (
    <div class="flex flex-col gap-2">
      <div>
        <h3 class="text-xs font-semibold text-secondary">{t().appAccess}</h3>
        <p class="text-xs text-dimmed">{t().appAccessDescription}</p>
      </div>
      <div class="flex flex-col">
        <For each={entries()}>
          {(entry) => (
            <div class="grid grid-cols-[1fr_auto] items-center gap-3 px-1 py-2">
              <div class="min-w-0">
                <div class="truncate text-sm font-medium text-default">{entry.resourceName}</div>
                <div class="truncate text-xs text-dimmed">
                  {label(entry)} · {permissionLabel(entry.permission)}
                </div>
              </div>
              <IconButton
                variant="ghost"
                size="xs"
                class="text-dimmed hover:text-default"
                label={t().revokeAppFor({ name: label(entry) })}
                disabled={revoke.loading()}
                onClick={() => revoke.mutate(entry)}
              >
                <i class="ti ti-x text-sm" />
              </IconButton>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

/**
 * The base's own access in the shared access dialog; changes apply on Save. App access follows below.
 * Exported for the behavior test; the island opens it from its menu.
 */
export const openPermissionDialog = async (
  props: AdminGridsActionsProps,
  entries: ScopedAccessEntry[],
  locale: string,
  signal?: AbortSignal,
) => {
  const t = gridsAdminMessages.resolve([locale]).t;
  const appEntries = entries.filter((entry) => entry.resourceType === "customApp");
  await openAccessDialog({
    resourceName: props.baseName,
    subtitle: t.baseAccessSubtitle,
    initialEntries: entries.filter((entry) => entry.resourceType === "base"),
    allowPublic: false,
    effectiveEntries: unshadowedGrants,
    signal,
    grantAccess: async (principal, permission) => {
      const response = await apiClient.admin.bases[":baseId"].access.$post({
        param: { baseId: props.baseId },
        json: { principal, permission },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.grantFailed));
      return (await response.json()) as AccessEntry;
    },
    updateAccess: async (accessId, permission) => {
      const response = await apiClient.admin.bases[":baseId"].access[":accessId"].$patch({
        param: { baseId: props.baseId, accessId },
        json: { permission },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.updateFailed));
    },
    revokeAccess: async (accessId) => {
      const response = await apiClient.admin.bases[":baseId"].access[":accessId"].$delete({
        param: { baseId: props.baseId, accessId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.revokeFailed));
    },
    extraSections: (
      <div class="flex flex-col gap-4">
        <p class="text-xs text-dimmed">{t.baseGrantDescription}</p>
        <Show when={appEntries.length > 0}>
          <AppAccessList baseId={props.baseId} entries={appEntries} />
        </Show>
      </div>
    ),
  });
};

const AdminGridsActions = (props: AdminGridsActionsProps) => {
  const locale = useLocale();
  const t = () => gridsAdminMessages.resolve([locale()]).t;
  // The access dialog closes with this menu's page; nothing is sent after the page changed.
  const owner = new AbortController();
  onCleanup(() => owner.abort());
  const permissionsMutation = mutations.create<void, void>({
    mutation: async () => {
      const entries = await listBaseAccess(props.baseId, t().loadPermissionsFailed);
      if (owner.signal.aborted) return;
      await openPermissionDialog(props, entries, locale(), owner.signal);
    },
    onError: (err) => {
      if (!owner.signal.aborted) void prompts.error(err.message);
    },
  });

  const deleteMutation = mutations.create<boolean, void>({
    mutation: async () => {
      const confirmed = await prompts.confirm(t().deleteConfirm({ name: props.baseName }), {
        title: t().deleteBase,
        icon: "ti ti-trash",
        confirmText: t().delete,
        variant: "danger",
      });
      if (!confirmed) return false;

      const response = await apiClient.admin.bases[":baseId"].$delete({
        param: { baseId: props.baseId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().deleteFailed));
      return true;
    },
    onSuccess: (deleted) => {
      if (!deleted) return;
      toast.success(t().baseDeleted);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
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
              action: () => void permissionsMutation.mutate(undefined),
            },
          ],
        },
        {
          items: [
            {
              icon: "ti ti-trash",
              label: t().delete,
              action: () => void deleteMutation.mutate(undefined),
              variant: "danger",
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger
        iconOnly
        variant="ghost"
        size="sm"
        type="button"
        class="h-7 w-7"
        label={t().actionsFor({ name: props.baseName })}
        tooltip={t().baseActions}
      >
        <i
          class={
            permissionsMutation.loading() || deleteMutation.loading() ? "ti ti-loader-2 animate-spin text-sm" : "ti ti-settings text-sm"
          }
        />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default AdminGridsActions;
