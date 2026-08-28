import { query } from "@k2b/stdlib/solid";
import { Button, Placeholder, SettingsGroup, useLocale } from "@k2b/ui";
import { PermissionEditor, type ResourceApiKey, ResourceApiKeys } from "@valentinkolb/cloud/access/ui";
import type { AccessEntry } from "@valentinkolb/cloud/contracts";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Notebook } from "../sidebar/types";
import { readErrorMessage } from "./utils";
import { notebookSettingsMessages } from "./messages";

function RetryButton(props: { loading: boolean; onClick: () => void }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  return (
    <Button type="button" variant="secondary" size="sm" disabled={props.loading} onClick={props.onClick}>
      <i class={props.loading ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} aria-hidden="true" />
      {t().retry}
    </Button>
  );
}

export function ApiKeysSection(props: { notebook: Notebook }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const apiKeys = query.create({
    source: () => props.notebook.id,
    load: async (notebookId, { abortSignal }): Promise<ResourceApiKey[]> => {
      const response = await apiClient[":id"]["api-keys"].$get({ param: { id: notebookId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().apiKeysLoadFailed));
      return ((await response.json()) as { items: ResourceApiKey[] }).items;
    },
  });
  const [reconcileError, setReconcileError] = createSignal<string | null>(null);
  const reconcile = () => {
    setReconcileError(null);
    void apiKeys.invalidate().catch(() => setReconcileError(t().apiKeysReconcileFailed));
  };

  return (
    <SettingsGroup title={t().integrationAccess} description={t().integrationAccessDescription}>
      <Show when={!apiKeys.loading()} fallback={<Placeholder state="loading" variant="panel" title={t().loadingApiKeys} />}>
        <Show
          when={apiKeys.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              variant="panel"
              title={t().couldNotLoadApiKeys}
              description={apiKeys.error()?.message ?? t().apiKeysCouldNotLoad}
              action={<RetryButton loading={apiKeys.refreshing()} onClick={() => void apiKeys.refresh()} />}
            />
          }
        >
          {(items) => (
            <ResourceApiKeys
              title={t().apiKeys}
              description={t().apiKeysPanelDescription}
              initialKeys={items}
              createKey={async (input) => {
                const response = await apiClient[":id"]["api-keys"].$post({
                  param: { id: props.notebook.id },
                  json: input,
                });
                if (!response.ok) throw new Error(await readErrorMessage(response, t().createApiKeyFailed));
                const created = (await response.json()) as { credential: ResourceApiKey; token: string };
                reconcile();
                return created;
              }}
              revokeKey={async (credentialId) => {
                const response = await apiClient[":id"]["api-keys"][":credentialId"].$delete({
                  param: { id: props.notebook.id, credentialId },
                });
                if (!response.ok) throw new Error(await readErrorMessage(response, t().revokeApiKeyFailed));
                reconcile();
              }}
            />
          )}
        </Show>
      </Show>
      <Show when={reconcileError()}>
        <div class="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300">
          <span>{reconcileError()}</span>
          <RetryButton loading={apiKeys.refreshing()} onClick={() => reconcile()} />
        </div>
      </Show>
    </SettingsGroup>
  );
}

export function PermissionsSection(props: { notebook: Notebook }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const accessEntries = query.create({
    source: () => props.notebook.id,
    load: async (notebookId, { abortSignal }): Promise<AccessEntry[]> => {
      const response = await apiClient[":id"].access.$get({ param: { id: notebookId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().permissionsLoadFailed));
      return (await response.json()) as AccessEntry[];
    },
  });
  const [reconcileError, setReconcileError] = createSignal<string | null>(null);
  const reconcile = () => {
    setReconcileError(null);
    void accessEntries.invalidate().catch(() => setReconcileError(t().accessReconcileFailed));
  };

  return (
    <SettingsGroup title={t().peopleGroups} description={t().peopleGroupsDescription}>
      <Show when={!accessEntries.loading()} fallback={<Placeholder state="loading" variant="panel" title={t().loadingAccess} />}>
        <Show
          when={accessEntries.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              variant="panel"
              title={t().couldNotLoadAccess}
              description={accessEntries.error()?.message ?? t().accessCouldNotLoad}
              action={<RetryButton loading={accessEntries.refreshing()} onClick={() => void accessEntries.refresh()} />}
            />
          }
        >
          {(entries) => (
            <PermissionEditor
              initialEntries={entries.filter((entry) => entry.principal.type !== "service_account")}
              canEdit
              grantAccess={async (principal, permission) => {
                const response = await apiClient[":id"].access.$post({
                  param: { id: props.notebook.id },
                  json: { principal, permission },
                });
                if (!response.ok) throw new Error(await readErrorMessage(response, t().grantAccessFailed));
                const created = (await response.json()) as AccessEntry;
                reconcile();
                return created;
              }}
              updateAccess={async (accessId, permission) => {
                const response = await apiClient[":id"].access[":accessId"].$patch({
                  param: { id: props.notebook.id, accessId },
                  json: { permission },
                });
                if (!response.ok) throw new Error(await readErrorMessage(response, t().updateAccessFailed));
                reconcile();
              }}
              revokeAccess={async (accessId) => {
                const response = await apiClient[":id"].access[":accessId"].$delete({
                  param: { id: props.notebook.id, accessId },
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
          <RetryButton loading={accessEntries.refreshing()} onClick={() => reconcile()} />
        </div>
      </Show>
    </SettingsGroup>
  );
}
