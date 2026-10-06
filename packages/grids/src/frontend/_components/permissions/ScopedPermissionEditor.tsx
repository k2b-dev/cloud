import { PermissionEditor } from "@k2b/cloud/access/ui";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts/shared";
import { Button, NoticeCard, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { resolveGridsMessages } from "../../messages";
import { errorMessage } from "../utils/api-helpers";

type GrantableLevel = Exclude<PermissionLevel, "none">;
type AllowedLevel = GrantableLevel | { level: GrantableLevel; label?: string; icon?: string };

type PermissionScope = { type: "base"; id: string } | { type: "customApp"; id: string };

type Props = {
  scope: PermissionScope;
  initialEntries?: AccessEntry[];
  canEdit?: boolean;
  allowedLevels?: AllowedLevel[];
};

const requestAccess = (scope: PermissionScope) =>
  scope.type === "base"
    ? apiClient.access["by-base"][":baseId"].$get({ param: { baseId: scope.id } })
    : apiClient.access["by-custom-app"][":customAppId"].$get({ param: { customAppId: scope.id } });

const listAccess = async (scope: PermissionScope, fallback: string): Promise<AccessEntry[]> => {
  const response = await requestAccess(scope);
  if (!response.ok) throw new Error(await errorMessage(response, fallback));
  return response.json();
};

const grantAccess = async (scope: PermissionScope, principal: Principal, permission: GrantableLevel, fallback: string) => {
  const response =
    scope.type === "base"
      ? await apiClient.access["by-base"][":baseId"].$post({ param: { baseId: scope.id }, json: { principal, permission } })
      : await apiClient.access["by-custom-app"][":customAppId"].$post({
          param: { customAppId: scope.id },
          json: { principal, permission },
        });
  if (!response.ok) throw new Error(await errorMessage(response, fallback));
  return response.json();
};

export function ScopedPermissionEditor(props: Props) {
  const locale = useLocale();
  const t = () => resolveGridsMessages(locale()).t;
  const [entries, setEntries] = createSignal<AccessEntry[] | null>(props.initialEntries ? [...props.initialEntries] : null);
  const [loading, setLoading] = createSignal(props.initialEntries === undefined);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  // A change can take the person's own Manage access away, for example lowering their own entry.
  const [manageable, setManageable] = createSignal(true);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setEntries(await listAccess(props.scope, t().refreshAccessFailed));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t().loadAccessFailed);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    if (props.initialEntries === undefined) void load();
  });

  /**
   * Re-reads the entries after a change that succeeded. Only managers may list them, so a refusal
   * means the change cost the person Manage access, and the editor turns read-only. Other failures
   * keep the editor's own copy, which already shows the change.
   */
  const reload = async (): Promise<AccessEntry[] | null> => {
    const response = await requestAccess(props.scope).catch(() => null);
    if (response?.status === 403) setManageable(false);
    if (!response?.ok) return null;
    const next = await response.json();
    setEntries(next);
    return next;
  };

  return (
    <Show
      when={entries()}
      fallback={
        <Show when={!loading() && loadError()} fallback={<Placeholder state="loading" align="left" title={t().loadingAccess} />}>
          {(message) => (
            <NoticeCard tone="danger" bodyClass="flex items-center justify-between gap-3">
              <span>{message()}</span>
              <Button variant="secondary" size="sm" type="button" onClick={() => void load()}>
                <i class="ti ti-refresh" /> {t().retry}
              </Button>
            </NoticeCard>
          )}
        </Show>
      }
    >
      {(loadedEntries) => (
        <PermissionEditor
          initialEntries={loadedEntries()}
          canEdit={props.canEdit && manageable()}
          allowPublic={props.scope.type === "customApp"}
          allowedLevels={props.scope.type === "customApp" ? [{ level: "read", label: t().open, icon: "ti ti-eye" }] : props.allowedLevels}
          grantAccess={async (principal, permission, display) => {
            const created = await grantAccess(props.scope, principal, permission, t().grantAccessFailed);
            const refreshed = await reload();
            return (
              refreshed?.find((entry) => entry.id === created.accessId) ?? {
                id: created.accessId,
                principal,
                permission,
                createdAt: new Date().toISOString(),
                ...display,
              }
            );
          }}
          updateAccess={async (accessId, permission) => {
            const response = await apiClient.access[":accessId"].$patch({
              param: { accessId },
              json: { permission },
            });
            if (!response.ok) throw new Error(await errorMessage(response, t().updateAccessFailed));
            await reload();
          }}
          revokeAccess={async (accessId) => {
            const response = await apiClient.access[":accessId"].$delete({ param: { accessId } });
            if (!response.ok) throw new Error(await errorMessage(response, t().revokeAccessFailed));
            await reload();
          }}
        />
      )}
    </Show>
  );
}
