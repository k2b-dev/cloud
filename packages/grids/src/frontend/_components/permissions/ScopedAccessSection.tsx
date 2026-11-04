import { openAccessDialog, PermissionEditor } from "@k2b/cloud/access/ui";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts/shared";
import { Button, NoticeCard, Placeholder, SettingsGroup, useLocale } from "@k2b/ui";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { unshadowedGrants } from "@/access-precedence";
import { apiClient } from "@/api/client";
import { resolveGridsMessages } from "../../messages";
import { errorMessage } from "../utils/api-helpers";

type GrantableLevel = Exclude<PermissionLevel, "none">;
type AllowedLevel = GrantableLevel | { level: GrantableLevel; label?: string; icon?: string };

type PermissionScope = { type: "base"; id: string } | { type: "customApp"; id: string };

type Props = {
  scope: PermissionScope;
  /** The base's or app's name, for the dialog's title. */
  resourceName: string;
  title: JSX.Element;
  description?: JSX.Element;
  /** Shown above the list, such as what this access covers. */
  children?: JSX.Element;
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

/**
 * Who may use a base or an app: the stored list, and "Edit access" opens the shared access dialog. Changes apply on
 * Save there; the list reads the result once afterwards.
 */
export function ScopedAccessSection(props: Props) {
  const locale = useLocale();
  const t = () => resolveGridsMessages(locale()).t;
  const [entries, setEntries] = createSignal<AccessEntry[] | null>(props.initialEntries ? [...props.initialEntries] : null);
  const [loading, setLoading] = createSignal(props.initialEntries === undefined);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [refreshError, setRefreshError] = createSignal(false);
  // A change can take the person's own Manage access away, for example lowering their own entry.
  const [manageable, setManageable] = createSignal(true);
  // The access dialog closes with this section; nothing is sent after it is gone.
  const owner = new AbortController();
  onCleanup(() => owner.abort());
  // Set by every saved change, also when a later one fails and the person discards the rest. Each saved change also
  // shows in the list at once, so it stays visible when the reload afterwards is refused.
  let wrote = false;
  // A plain guard, not a disabled state: a disabled button could not take focus back when the dialog closes.
  let editing = false;

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
   * Re-reads the entries after a change. Only managers may list them, so a refusal means the change cost the person
   * Manage access, and the section turns read-only. Other failures keep the old list and offer a retry.
   */
  const reload = async (): Promise<boolean> => {
    const response = await requestAccess(props.scope).catch(() => null);
    if (owner.signal.aborted) return false;
    if (response?.status === 403) {
      setManageable(false);
      setRefreshError(false);
      return false;
    }
    if (!response?.ok) {
      setRefreshError(true);
      return false;
    }
    setEntries(await response.json());
    setRefreshError(false);
    return true;
  };

  const levels = (): AllowedLevel[] | undefined =>
    props.scope.type === "customApp" ? [{ level: "read", label: t().open, icon: "ti ti-eye" }] : props.allowedLevels;
  const grant = async (principal: Principal, permission: GrantableLevel, display?: { displayName?: string }) => {
    const created = await grantAccess(props.scope, principal, permission, t().grantAccessFailed);
    wrote = true;
    const entry: AccessEntry = { id: created.accessId, principal, permission, createdAt: new Date().toISOString(), ...display };
    setEntries((current) => (current ? [...current, entry] : current));
    return entry;
  };
  const update = async (accessId: string, permission: GrantableLevel) => {
    const response = await apiClient.access[":accessId"].$patch({ param: { accessId }, json: { permission } });
    if (!response.ok) throw new Error(await errorMessage(response, t().updateAccessFailed));
    wrote = true;
    setEntries((current) => current?.map((entry) => (entry.id === accessId ? { ...entry, permission } : entry)) ?? current);
  };
  const revoke = async (accessId: string) => {
    const response = await apiClient.access[":accessId"].$delete({ param: { accessId } });
    if (!response.ok) throw new Error(await errorMessage(response, t().revokeAccessFailed));
    wrote = true;
    setEntries((current) => current?.filter((entry) => entry.id !== accessId) ?? current);
  };

  const edit = async () => {
    // A list that missed a saved change is read first, so the dialog never starts from an old list.
    if (refreshError() && !(await reload())) return;
    const current = entries();
    if (!current || !manageable() || owner.signal.aborted) return;
    wrote = false;
    await openAccessDialog({
      resourceName: props.resourceName,
      subtitle: props.scope.type === "base" ? t().baseAccessSubtitle : t().appAccessSubtitle,
      initialEntries: current,
      allowPublic: props.scope.type === "customApp",
      // Visitors of a public app can also send what it publishes, such as forms.
      publicWarning: props.scope.type === "customApp" ? t().appPublicWarning : undefined,
      allowedLevels: levels(),
      effectiveEntries: unshadowedGrants,
      grantAccess: grant,
      updateAccess: update,
      revokeAccess: revoke,
      signal: owner.signal,
    });
    // Awaited, so a second click waits for the saved list instead of opening the old one.
    if (wrote && !owner.signal.aborted) await reload();
  };
  const run = () => {
    if (editing) return;
    editing = true;
    edit().finally(() => {
      editing = false;
    });
  };

  return (
    <SettingsGroup title={props.title} description={props.description}>
      <SettingsGroup.Action>
        <Show when={props.canEdit && manageable()}>
          <Button size="sm" variant="secondary" type="button" disabled={!entries()} onClick={run}>
            <i class="ti ti-pencil" aria-hidden="true" />
            {t().editAccess}
          </Button>
        </Show>
      </SettingsGroup.Action>
      {props.children}
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
            canEdit={false}
            allowPublic={props.scope.type === "customApp"}
            allowedLevels={levels()}
            effectiveEntries={unshadowedGrants}
            grantAccess={grant}
            updateAccess={update}
            revokeAccess={revoke}
          />
        )}
      </Show>
      <Show when={refreshError()}>
        <NoticeCard tone="warning" bodyClass="flex items-center justify-between gap-3">
          <span>{t().refreshAccessFailed}</span>
          <Button variant="secondary" size="sm" type="button" onClick={() => void reload()}>
            <i class="ti ti-refresh" /> {t().retry}
          </Button>
        </NoticeCard>
      </Show>
    </SettingsGroup>
  );
}
