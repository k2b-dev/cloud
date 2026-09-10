import { query } from "@k2b/stdlib/solid";
import { PermissionEditor } from "@k2b/cloud/access/ui";
import { Button, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { client, checked, displayError } from "./client";
import { messages } from "./messages";
import { databaseMessages } from "../database-messages";

export function AdminKitPermissions(props: { id: string }) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  const admin = () => databaseMessages.resolve([locale()]).t;
  const entries = query.create({
    source: () => props.id,
    load: async (id, { abortSignal }) =>
      checked(await client.projects[":id"].access.$get({ param: { id } }, { init: { signal: abortSignal } })),
  });
  const [reconcileError, setReconcileError] = createSignal(false);
  const reconcile = () => {
    setReconcileError(false);
    void entries.invalidate().catch(() => setReconcileError(true));
  };
  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <p class="text-xs text-dimmed">{admin().manageAccess}</p>
      <Show when={!entries.loading()} fallback={<Placeholder state="loading" title={admin().permissions} />}>
        <Show
          when={entries.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              title={admin().accessLoadFailed}
              description={displayError(entries.error(), locale())}
              action={
                <Button type="button" variant="secondary" size="sm" onClick={() => void entries.refresh()}>
                  {admin().refresh}
                </Button>
              }
            />
          }
        >
          {(currentEntries) => (
            <PermissionEditor
              initialEntries={currentEntries}
              canEdit
              allowPublic={false}
              allowServiceAccounts={false}
              allowedLevels={[
                { level: "read", label: t().accessRead },
                { level: "write", label: t().accessWrite },
                { level: "admin", label: t().accessAdmin },
              ]}
              grantAccess={async (principal, permission) => {
                if (principal.type === "public" || principal.type === "service_account") throw new Error(t().error);
                const created = await checked(
                  await client.projects[":id"].access.$post({ param: { id: props.id }, json: { principal, permission } }),
                );
                if (!created) throw new Error(t().error);
                reconcile();
                return created;
              }}
              updateAccess={async (accessId, permission) => {
                await checked(
                  await client.projects[":id"].access[":accessId"].$patch({ param: { id: props.id, accessId }, json: { permission } }),
                );
                reconcile();
              }}
              revokeAccess={async (accessId) => {
                await checked(await client.projects[":id"].access[":accessId"].$delete({ param: { id: props.id, accessId } }));
                reconcile();
              }}
            />
          )}
        </Show>
      </Show>
      <Show when={reconcileError()}>
        <div class="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300">
          <span>{admin().accessRefreshFailed}</span>
          <Button type="button" variant="secondary" size="sm" onClick={reconcile} disabled={entries.refreshing()}>
            {admin().refresh}
          </Button>
        </div>
      </Show>
    </div>
  );
}
